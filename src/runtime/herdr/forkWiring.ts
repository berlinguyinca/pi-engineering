/**
 * Runtime wiring for forks (T13): build the fork manager, the steering port and a head/diff refresher from the global
 * YAML. Returns null (nothing constructed, no timer, no network) unless `forks.enabled` is true, so standalone Pi,
 * with or without Herdr or AutoSpec, behaves exactly as before.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CliForkGit } from "../../git/forkGit.ts";
import {
  type GithubLinkStore,
  type GithubRef,
  createGithubClient,
  normaliseRepo,
  refConfigOf,
} from "../../github/index.ts";
import {
  type ForkLineage,
  ForkManager,
  type ForkOrigin,
  ForkRegistry,
  type OriginResolution,
  type RemotePin,
} from "../../orchestration/forks.ts";
import type { ForkSteeringPort } from "../../orchestration/steering.ts";
import type { WorkGraph } from "../../work/types.ts";
import { loadForkSettings } from "./forkSettings.ts";

/** A unit of work a fork can start from, identified without reference to a Mission. */
export interface ForkTaskRef {
  task_id: string;
  /** The enclosing work id: a Mission id for Mission-backed work, else the root work task. Persisted as `missionId` in fork records. */
  work_id: string;
  repo_id?: string;
}

/** Where the work lives: the repository and the branch a fork is based on. */
export interface ForkScope {
  work_id: string;
  repository: string;
  base_ref: string;
}

/**
 * What the fork wiring reads, independent of any one store. Satisfied by a Mission ({@link missionForkSources}) and
 * by the generic work read model ({@link workForkSources}), so a fork or handoff from a Mission-less session resolves
 * the same way. Injected so tests need neither.
 */
export interface ForkRuntimeSources {
  getTask(taskId: string): ForkTaskRef | undefined | Promise<ForkTaskRef | undefined>;
  getExecution(executionId: string): { task_id: string } | undefined;
  /** Repository and base ref of the work a task belongs to; undefined = not known on this host. */
  getScope(workId: string): ForkScope | undefined | Promise<ForkScope | undefined>;
  /** Repository root bound to a task's repo id (throws when no manifest is active). */
  boundRoot(repoId: string): string | null;
  /** Root of the git repository at `path`, or null. */
  openRoot(path: string): Promise<string | null>;
  links: GithubLinkStore;
  /** Canonical PR ids of the tasks that depend (transitively) on `taskId`; absent = no downstream invalidation. */
  downstreamPrs?: (taskId: string) => string[];
  /** A promoted fork's PR was opened and linked for `taskId`; record it where the task's work lives (best effort). */
  onPrLinked?: (taskId: string, pr: GithubRef) => void | Promise<void>;
}

/** The parts of {@link ForkRuntimeSources} that do not depend on how work is stored. */
export type ForkHostSources = Pick<
  ForkRuntimeSources,
  "boundRoot" | "openRoot" | "links" | "downstreamPrs" | "onPrLinked"
>;

/** Adapter over MissionStore: a Mission is the work, its repository and base_ref are the scope. */
export function missionForkSources(
  store: {
    getTask(id: string): { task_id: string; mission_id: string; repo_id?: string } | undefined;
    getExecution(id: string): { task_id: string } | undefined;
    getMission(id: string): { mission_id: string; repository: string; base_ref: string } | undefined;
  },
  host: ForkHostSources,
): ForkRuntimeSources {
  return {
    ...host,
    getTask: (id) => {
      const t = store.getTask(id);
      return t
        ? { task_id: t.task_id, work_id: t.mission_id, ...(t.repo_id ? { repo_id: t.repo_id } : {}) }
        : undefined;
    },
    getExecution: (id) => store.getExecution(id),
    getScope: (workId) => {
      const m = store.getMission(workId);
      return m ? { work_id: m.mission_id, repository: m.repository, base_ref: m.base_ref } : undefined;
    },
  };
}

/** Where a Mission-less piece of work lives. Supplied by whatever holds the session's checkout facts. */
export interface WorkScopeFacts {
  repository: string;
  base_ref: string;
  repo_id?: string;
}

/**
 * Adapter over the Phase-2 work read model (src/work/*). The graph gives task and run identity (it never stores a
 * repository), so the checkout facts come from `scopeOf`, keyed by the root work task id. A session id also names its
 * task, so a handoff addressed by session works with no Mission present.
 */
export function workForkSources(
  graph: () => Pick<WorkGraph, "tasks" | "runs" | "sessions">,
  scopeOf: (workId: string) => WorkScopeFacts | undefined | Promise<WorkScopeFacts | undefined>,
  host: ForkHostSources,
): ForkRuntimeSources {
  const rootOf = (g: ReturnType<typeof graph>, id: string): string => {
    let cur = g.tasks.find((t) => t.id === id);
    for (let hops = 0; cur?.parent_id && hops < 64; hops++) {
      const parent = g.tasks.find((t) => t.id === cur?.parent_id);
      if (!parent) break;
      cur = parent;
    }
    return cur?.id ?? id;
  };
  const taskIdOf = (g: ReturnType<typeof graph>, id: string): string | undefined => {
    if (g.tasks.some((t) => t.id === id)) return id;
    return g.sessions.find((s) => s.id === id)?.task_ids[0];
  };
  return {
    ...host,
    getTask: async (id) => {
      const g = graph();
      const taskId = taskIdOf(g, id);
      if (!taskId) return undefined;
      const workId = rootOf(g, taskId);
      const repoId = (await scopeOf(workId))?.repo_id;
      return { task_id: taskId, work_id: workId, ...(repoId ? { repo_id: repoId } : {}) };
    },
    getExecution: (id) => {
      const run = graph().runs.find((r) => r.id === id);
      return run ? { task_id: run.task_id } : undefined;
    },
    getScope: async (workId) => {
      const f = await scopeOf(workId);
      return f ? { work_id: workId, repository: f.repository, base_ref: f.base_ref } : undefined;
    },
  };
}

/**
 * Mission-backed work first, the generic work read model as the fallback. A Mission id or task is answered by the
 * Mission store exactly as before; anything it does not know (a Ledger work item, a Mission-less session) falls through
 * to `fallback`. A node the Mission store knows is never re-resolved by the fallback, so a shared id cannot change
 * meaning. `getScope` is routed by whichever source recognises the work id as a task root.
 */
export function withFallbackForkSources(primary: ForkRuntimeSources, fallback: ForkRuntimeSources): ForkRuntimeSources {
  const primaryWork = new Set<string>();
  return {
    ...primary,
    getTask: async (id) => {
      const t = await primary.getTask(id);
      if (t) {
        primaryWork.add(t.work_id);
        return t;
      }
      return fallback.getTask(id);
    },
    getExecution: (id) => primary.getExecution(id) ?? fallback.getExecution(id),
    getScope: async (workId) => {
      if (primaryWork.has(workId)) return await primary.getScope(workId);
      return (await primary.getScope(workId)) ?? (await fallback.getScope(workId));
    },
  };
}

/** The active PR links of every task that depends, directly or not, on `taskId` (a pure read of the ledger). */
export function downstreamPrNodes(
  store: {
    listTasks(): Array<{ task_id: string; mission_id: string; depends_on: string[] }>;
    listGithubLinks(missionId?: string): Array<{
      status: string;
      targetKind: string;
      target: string;
      subject: { kind: string; id: string };
    }>;
  },
  taskId: string,
): string[] {
  const tasks = store.listTasks();
  const dependents = new Set<string>();
  const frontier = [taskId];
  while (frontier.length) {
    const cur = frontier.pop() as string;
    for (const t of tasks) {
      if (t.depends_on.includes(cur) && !dependents.has(t.task_id)) {
        dependents.add(t.task_id);
        frontier.push(t.task_id);
      }
    }
  }
  const out = new Set<string>();
  for (const l of store.listGithubLinks())
    if (l.status === "active" && l.targetKind === "pr" && l.subject.kind === "task" && dependents.has(l.subject.id))
      out.add(l.target);
  return [...out];
}

const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\-]*(?:\/[A-Za-z0-9][A-Za-z0-9._\-]*)*$/;

export interface ForkRuntime {
  port: ForkSteeringPort;
  manager: ForkManager;
  stop(): void;
}

export async function createForkRuntime(input: {
  agentDir: string;
  stateDir: string;
  sources: ForkRuntimeSources;
  lineage: ForkLineage | null;
  log?: (message: string) => void;
}): Promise<ForkRuntime | null> {
  const settings = await loadForkSettings(input.agentDir);
  for (const n of settings.notes) input.log?.(n);
  if (!settings.enabled) return null;
  const registry = new ForkRegistry(join(input.stateDir, "forks.json"));
  let promote = null;
  if (settings.promote) {
    const g = settings.promote.github;
    const cfg = {
      enabled: true,
      ...(g.hosts ? { hosts: g.hosts } : {}),
      ...(g.defaultRepo ? { defaultRepo: g.defaultRepo } : {}),
      ...(g.ghPath ? { ghPath: g.ghPath } : {}),
    };
    const client = createGithubClient(cfg);
    if (client) {
      const refCfg = refConfigOf(cfg);
      const [owner, name] = g.defaultRepo ? g.defaultRepo.split("/") : [];
      const host = g.hosts?.[0] ?? "github.com";
      const defaultRepo = owner && name ? normaliseRepo(host, owner, name, refCfg) : undefined;
      const remote: RemotePin | null = settings.promote.remoteUrl
        ? { exact: settings.promote.remoteUrl }
        : defaultRepo
          ? { slug: defaultRepo }
          : null;
      if (!remote)
        input.log?.(
          "forks: promotion off: set forks.promote.remote_url or github.default_repo to pin the push destination",
        );
      else
        promote = {
          client,
          store: input.sources.links,
          refCfg,
          draft: settings.promote.draft,
          remote,
          ...(defaultRepo ? { defaultRepo } : {}),
        };
    }
  }
  const manager = new ForkManager({
    registry,
    git: (root) => new CliForkGit(root),
    lineage: input.lineage,
    limits: settings.limits,
    promote,
    ...(input.sources.downstreamPrs ? { downstreamPrs: input.sources.downstreamPrs } : {}),
    ...(input.sources.onPrLinked ? { onPrLinked: input.sources.onPrLinked } : {}),
    ...(input.log ? { log: input.log } : {}),
  });
  const s = input.sources;
  const resolveOrigin = async (nodeId: string): Promise<OriginResolution> => {
    const i = nodeId.indexOf(":");
    const kind = nodeId.slice(0, i);
    const id = nodeId.slice(i + 1);
    let task: ForkTaskRef | undefined;
    let knownRoot: string | null = null;
    if (kind === "task" || kind === "agent") task = await s.getTask(id);
    else if (kind === "attempt") {
      const ex = s.getExecution(id);
      task = ex ? await s.getTask(ex.task_id) : undefined;
    } else if (kind === "approach") {
      const rec = registry.get(id);
      task = rec ? await s.getTask(rec.taskId) : undefined;
      knownRoot = rec?.repoRoot ?? null;
      if (rec && !task) return { unresolvable: "the mission of that approach is no longer known here" };
    } else return null;
    if (!task) return null;
    const mission = await s.getScope(task.work_id);
    if (!mission) return { unresolvable: "the mission is not known on this host" };
    if (!SAFE_BRANCH.test(mission.base_ref)) return { unresolvable: "the mission base ref is not a plain branch name" };
    let repoRoot = knownRoot;
    if (!repoRoot && task.repo_id) {
      try {
        repoRoot = s.boundRoot(task.repo_id);
      } catch {
        repoRoot = null;
      }
    }
    if (!repoRoot && isAbsolute(mission.repository) && existsSync(mission.repository))
      repoRoot = await s.openRoot(mission.repository);
    if (!repoRoot) return { unresolvable: "the repository of that mission is not available on this host" };
    const origin: ForkOrigin = {
      nodeId,
      missionId: mission.work_id,
      taskId: task.task_id,
      repoRoot,
      baseBranch: mission.base_ref,
    };
    return origin;
  };
  const port: ForkSteeringPort = {
    knows: async (item) =>
      item.action === "promote" ? manager.knowsApproach(item.nodeId) : (await resolveOrigin(item.nodeId)) !== null,
    apply: async (item) => {
      if (item.action === "promote") return manager.promote(item);
      const origin = await resolveOrigin(item.nodeId);
      return origin ? manager.create(item, origin) : { outcome: "stale", note: "the origin is no longer known here" };
    },
  };
  const timer = setInterval(() => void manager.refreshAll(), settings.refreshMs);
  timer.unref?.();
  return { port, manager, stop: () => clearInterval(timer) };
}
