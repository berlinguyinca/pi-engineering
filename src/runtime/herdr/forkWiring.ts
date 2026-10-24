/**
 * Runtime wiring for forks (T13): build the fork manager, the steering port and a head/diff refresher from the global
 * YAML. Returns null (nothing constructed, no timer, no network) unless `forks.enabled` is true, so standalone Pi,
 * with or without Herdr or AutoSpec, behaves exactly as before.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CliForkGit } from "../../git/forkGit.ts";
import { type GithubLinkStore, createGithubClient, normaliseRepo, refConfigOf } from "../../github/index.ts";
import {
  type ForkLineage,
  ForkManager,
  type ForkOrigin,
  ForkRegistry,
  type OriginResolution,
  type RemotePin,
} from "../../orchestration/forks.ts";
import type { ForkSteeringPort } from "../../orchestration/steering.ts";
import { loadForkSettings } from "./forkSettings.ts";

/** The slice of MissionStore + RepositoryRegistry the wiring reads. Injected so tests need neither. */
export interface ForkRuntimeSources {
  getTask(taskId: string): { task_id: string; mission_id: string; repo_id?: string } | undefined;
  getExecution(executionId: string): { task_id: string } | undefined;
  getMission(missionId: string): { mission_id: string; repository: string; base_ref: string } | undefined;
  /** Repository root bound to a task's repo id (throws when no manifest is active). */
  boundRoot(repoId: string): string | null;
  /** Root of the git repository at `path`, or null. */
  openRoot(path: string): Promise<string | null>;
  links: GithubLinkStore;
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
    ...(input.log ? { log: input.log } : {}),
  });
  const s = input.sources;
  const resolveOrigin = async (nodeId: string): Promise<OriginResolution> => {
    const i = nodeId.indexOf(":");
    const kind = nodeId.slice(0, i);
    const id = nodeId.slice(i + 1);
    let task: ReturnType<ForkRuntimeSources["getTask"]>;
    let knownRoot: string | null = null;
    if (kind === "task" || kind === "agent") task = s.getTask(id);
    else if (kind === "attempt") {
      const ex = s.getExecution(id);
      task = ex ? s.getTask(ex.task_id) : undefined;
    } else if (kind === "approach") {
      const rec = registry.get(id);
      task = rec ? s.getTask(rec.taskId) : undefined;
      knownRoot = rec?.repoRoot ?? null;
      if (rec && !task) return { unresolvable: "the mission of that approach is no longer known here" };
    } else return null;
    if (!task) return null;
    const mission = s.getMission(task.mission_id);
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
      missionId: mission.mission_id,
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
