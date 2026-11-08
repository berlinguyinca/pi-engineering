/**
 * Runtime operations view — the read side of "what is this runtime doing right now, and what did each
 * task produce".
 *
 * WHY THIS EXISTS
 *
 * The operator's questions at 2 a.m. are not "what does the code do" but "is the thing I started still
 * alive, what is it blocked on, and did the tasks that finished leave the evidence they promised". The
 * durable stores already answer those: the orchestration event log holds every mission and task
 * transition, the ledger holds claims and evidence, the Task Contract holds authorization, the handoff
 * trail holds completion proof. What was missing was one read-only surface over them that says, for each
 * piece, either the answer or why it could not be had — instead of a UI that redraws state and a human
 * inferring liveness from the absence of noise.
 *
 * CONTRACT
 *
 * 1. READ-ONLY. Every store is opened through its read-only path (`JsonlEventStore.openReadOnly`), so a
 *    status call works while a live session holds the writer lock and can never advance state. Nothing
 *    here appends, transitions, retries, cancels or re-runs: those stay on the existing write APIs, where
 *    their authority checks live. A status view that could also act would need the same authorization
 *    story as the CLI, and would be a second way to do the same thing.
 * 2. NEVER THROWS FOR MISSING DATA. A runtime that has not run yet, a store that is mid-rotation, a config
 *    pointing at a path that moved: each becomes `{ available: false, reason }` on that section. One
 *    unreadable section must not cost the operator the other three.
 * 3. BOUNDED. Objective text, artifact lists and event windows are capped; this output goes into a
 *    terminal or a model context, and a runtime status that dumps 40k events is not a status.
 * 4. NO INVENTED LIVENESS. A heartbeat timestamp older than `staleAfterMs` is reported `stale`, and a
 *    mission with no heartbeat record is `unknown`, not "fine". Absence of evidence is printed as absence.
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { version as nodeVersion } from "node:process";
import { citationSummary, fileSystemReader, gitObjectReader, resolveCitations, type CitationReport } from "../ledger/citations.ts";
import { JsonlEventStore } from "../platform/eventstore/jsonl.ts";
import { MissionStore } from "../orchestration/missionStore.ts";
import type { Mission, OrchestrationTask, TaskStatus } from "../orchestration/types.ts";
import { resolveStateRoot } from "../runtime/isolation/stateDir.ts";
import { discoverSessions } from "../sessionControl/SessionControl.ts";

/** Where the operator's config lives, in precedence order. */
export const RUNTIME_OPS_CONFIG_ENV = "PI_ENGINEERING_RUNTIME_OPS";

export interface RuntimeOpsConfig {
  /** Repository the view reports on. */
  repoRoot: string;
  /** Machine-local runtime state (`<root>/registry.db`, `<root>/worktrees/<id>/...`). */
  stateRoot: string;
  /** Orchestration store: a directory containing `orchestration.jsonl`, or that file. */
  orchestrationStore: string | null;
  /** Document tree whose citations are checked for tasks that changed it. */
  specsDir: string;
  /** A heartbeat older than this is reported stale rather than alive. */
  staleAfterMs: number;
  limits: { missions: number; tasks: number; activityEvents: number; textChars: number };
}

export interface ConfigResolution {
  config: RuntimeOpsConfig;
  /** `arg`, `env`, `repo-config`, `defaults` — which rule produced the config, or `error`. */
  source: string;
  problems: string[];
}

export interface Unavailable {
  available: false;
  reason: string;
}
export interface Available<T> {
  available: true;
  data: T;
}
/** A section is either data or the reason there is no data — never a silent empty array. */
export type Section<T> = Unavailable | Available<T>;

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface HealthReport {
  ok: boolean;
  checkedAt: string;
  configSource: string;
  checks: HealthCheck[];
}

export interface MissionSummary {
  missionId: string;
  status: string;
  title: string;
  repository: string;
  updatedAt: string;
  taskCount: number;
  blockedReason: string | null;
}

export interface ActivityEvent {
  eventId: string;
  missionId: string;
  timestamp: string;
  type: string;
  actor: string;
}

/**
 * Liveness of a session, stated as what the evidence supports. `fresh` means a heartbeat inside the stale
 * window; `stale` means a heartbeat older than it, which is NOT "dead" — a session can be wedged, or its
 * host clock skew, or the writer paused mid-thing. `unknown` means no heartbeat was recorded at all.
 */
export type SessionLiveness = "fresh" | "stale" | "unknown";

export interface SessionSummary {
  sessionId: string;
  instanceId: string;
  pid: number;
  cwd: string;
  startedAt: string;
  heartbeatAt: string;
  /** Milliseconds between the heartbeat and this read; null when the timestamp is unreadable. */
  ageMs: number | null;
  liveness: SessionLiveness;
  /** Whether the recorded pid still exists. False with a fresh heartbeat is a contradiction worth seeing. */
  processAlive: boolean;
}

export interface RuntimeStatusReport {
  checkedAt: string;
  staleAfterMs: number;
  node: string;
  stateRoot: Section<{ path: string; namespaces: { name: string; modifiedAt: string }[] }>;
  sessions: Section<{ total: number; fresh: number; stale: number; unknown: number; items: SessionSummary[] }>;
  missions: Section<{ total: number; byStatus: Record<string, number>; active: MissionSummary[] }>;
  activity: Section<{ windowMs: number; events: ActivityEvent[]; newest: string | null }>;
}

export interface TaskSummary {
  taskId: string;
  missionId: string;
  kind: string;
  role: string;
  status: TaskStatus;
  objective: string;
  dependsOn: string[];
  attempt: number;
  maxAttempts: number;
  startedAt: string | null;
  completedAt: string | null;
  artifactCount: number;
}

export interface TaskListReport {
  checkedAt: string;
  filter: { missionId: string | null; statuses: string[]; limit: number };
  total: number;
  tasks: TaskSummary[];
  truncated: boolean;
}

export interface CitationDriftReport {
  status: "checked" | "not_applicable";
  reason?: string;
  atRef: string;
  documents?: string[];
  summary?: string;
  report?: CitationReport;
}

export interface TaskDetailReport {
  checkedAt: string;
  taskId: string;
  found: boolean;
  reason?: string;
  task?: TaskSummary;
  mission?: Section<{ missionId: string; status: string; title: string; acceptanceCriteria: { criterion: string; status: string; evidence?: string }[] }>;
  lifecycle?: Section<{ stages: string[]; current: string | null }>;
  /** Evidence the task left: artifact refs, split by whether they exist on disk. */
  artifacts?: { repoRelative: string[]; absolute: string[]; missing: string[] };
  citationDrift?: CitationDriftReport;
}

const DEFAULT_LIMITS = { missions: 200, tasks: 200, activityEvents: 200, textChars: 240 };

function readConfigFile(file: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSyncSafe(file) ?? "{}") as Record<string, unknown>;
  return raw && typeof raw === "object" ? raw : {};
}

function readFileSyncSafe(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/**
 * Resolve the config: an explicit path wins, then `$PI_ENGINEERING_RUNTIME_OPS`, then
 * `<repoRoot>/config/runtime-ops.json`, then defaults built from `resolveStateRoot()`. A file that exists
 * but does not parse is reported as a problem and the defaults are used -- status must still work, because
 * the most common reason to run status is that something is broken.
 */
export function resolveRuntimeOpsConfig(options: {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string | null;
  cwd?: string;
}): ConfigResolution {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = resolve(options.repoRoot);
  const problems: string[] = [];

  const explicit = options.configPath ?? env[RUNTIME_OPS_CONFIG_ENV]?.trim() ?? null;
  const repoFile = join(repoRoot, "config", "runtime-ops.json");
  const file = explicit ? resolve(cwd, explicit) : existsSync(repoFile) ? repoFile : null;
  const source = options.configPath ? "arg" : explicit ? "env" : file ? "repo-config" : "defaults";

  let raw: Record<string, unknown> = {};
  if (file !== null) {
    const text = readFileSyncSafe(file);
    if (text === null) {
      problems.push(`${file} was named but cannot be read; defaults are used`);
    } else {
      try {
        raw = JSON.parse(text) as Record<string, unknown>;
      } catch (error) {
        problems.push(`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); defaults are used`);
      }
    }
  }

  const stateRoot = str(raw.stateRoot, resolveStateRoot(env));
  const store = typeof raw.orchestrationStore === "string" && raw.orchestrationStore.trim() !== "" ? resolve(cwd, raw.orchestrationStore) : null;

  return {
    config: {
      repoRoot,
      stateRoot: resolve(cwd, stateRoot),
      orchestrationStore: store,
      specsDir: resolve(cwd, str(raw.specsDir, "docs/specs")),
      staleAfterMs: typeof raw.staleAfterMs === "number" && raw.staleAfterMs > 0 ? raw.staleAfterMs : 5 * 60_000,
      limits: { ...DEFAULT_LIMITS, ...(typeof raw.limits === "object" && raw.limits !== null ? (raw.limits as Partial<typeof DEFAULT_LIMITS>) : {}) },
    },
    source,
    problems,
  };
}

/** The orchestration file inside a configured store, or null when nothing plausible is configured. */
export function resolveOrchestrationFile(config: RuntimeOpsConfig): { file: string | null; reason: string } {
  const candidates: string[] = [];
  if (config.orchestrationStore !== null) candidates.push(config.orchestrationStore);
  // A store is per worktree namespace under the state root; look there before calling it absent.
  for (const dir of [join(config.stateRoot, "control-plane"), join(config.repoRoot, ".pi-eng")]) {
    if (existsSync(dir)) {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name === "orchestration.jsonl") candidates.push(join(dir, entry.name));
          if (entry.isDirectory()) {
            const nested = join(dir, entry.name, "orchestration.jsonl");
            if (existsSync(nested)) candidates.push(nested);
          }
        }
      } catch {
        // Unreadable directory: covered by the "no store" reason below.
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const info = statSync(candidate);
      if (info.isDirectory()) {
        const nested = join(candidate, "orchestration.jsonl");
        if (existsSync(nested)) return { file: nested, reason: "" };
        continue;
      }
      if (info.isFile()) return { file: candidate, reason: "" };
    } catch {
      // try the next candidate
    }
  }
  return {
    file: null,
    reason: `no orchestration store: config names ${config.orchestrationStore ?? "nothing"} and neither ${join(config.stateRoot, "control-plane")} nor ${join(config.repoRoot, ".pi-eng")} holds orchestration.jsonl`,
  };
}

/**
 * Open the orchestration store read-only. Read-only matters twice over: it must work while a worker holds
 * the writer lock, and a status command must not create an empty store for a mistyped path and then report
 * "no missions".
 */
async function openStore(file: string): Promise<{ store: MissionStore; events: ActivityEvent[] } | { reason: string }> {
  try {
    const backend = await JsonlEventStore.openReadOnly(file);
    const store = MissionStore.open(backend);
    const events: ActivityEvent[] = [];
    for (const event of backend.all() as unknown as Record<string, unknown>[]) {
      events.push({
        eventId: String(event.event_id ?? ""),
        missionId: String(event.mission_id ?? ""),
        timestamp: String(event.timestamp ?? ""),
        type: String(event.type ?? ""),
        actor: String(event.actor ?? ""),
      });
    }
    return { store, events };
  } catch (error) {
    return { reason: `${file} could not be opened read-only: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function taskSummary(task: OrchestrationTask, textChars: number): TaskSummary {
  return {
    taskId: task.task_id,
    missionId: task.mission_id,
    kind: String(task.kind),
    role: task.role,
    status: task.status,
    objective: truncate(task.objective ?? "", textChars),
    dependsOn: [...(task.depends_on ?? [])],
    attempt: task.attempt ?? 0,
    maxAttempts: task.max_attempts ?? 0,
    startedAt: task.started_at ?? null,
    completedAt: task.completed_at ?? null,
    artifactCount: (task.artifacts ?? []).length,
  };
}

/** Why a mission sits where it sits. Only a durable BLOCKED episode counts; otherwise null. */
function blockedReason(mission: Mission): string | null {
  if (!mission.status.startsWith("BLOCKED") && mission.status !== "WAITING_FOR_USER") return null;
  const reason = (mission as unknown as { blocked_reason?: string; failure_reason?: string | null }).blocked_reason ?? mission.failure_reason;
  return typeof reason === "string" && reason !== "" ? truncate(reason, 320) : `status ${mission.status}${mission.blocked_at ? ` since ${mission.blocked_at}` : ""}`;
}

/** Documents under specsDir that a task can be attributed to, from its own declared outputs. */
function attributableSpecs(task: OrchestrationTask, config: RuntimeOpsConfig): string[] {
  const names = new Set<string>();
  const consider = (value: string | undefined): void => {
    if (typeof value !== "string") return;
    const clean = value.replace(/^\.\/+/u, "").split("#")[0]!.trim();
    if (clean === "" || !clean.endsWith(".md")) return;
    const abs = isAbsoluteish(clean) ? clean : join(config.repoRoot, clean);
    const rel = relative(config.repoRoot, abs).replace(/\\/gu, "/");
    if (!rel.startsWith(config.specsDir.replace(/\\/gu, "/") + "/") && !rel.startsWith("docs/specs/")) return;
    if (existsSync(abs)) names.add(rel);
  };
  for (const artifact of task.artifacts ?? []) consider(artifact);
  for (const deliverable of task.deliverables ?? []) consider(deliverable);
  return [...names].sort();
}

function isAbsoluteish(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:\//u.test(path);
}

/**
 * Citation drift for a finished task: the docs it says it produced, re-resolved against the tree. A task
 * that touched no document is `not_applicable` with a reason -- it is not "clean", because nothing was
 * checked. The ref defaults to `HEAD` so the answer does not depend on whose dirty worktree is open; pass
 * `atRef: "worktree"` to check uncommitted edits.
 */
export async function citationDriftForTask(
  task: OrchestrationTask,
  config: RuntimeOpsConfig,
  opts: { atRef?: string } = {},
): Promise<CitationDriftReport> {
  const docs = attributableSpecs(task, config);
  if (docs.length === 0) {
    return {
      status: "not_applicable",
      reason: "the task declares no docs/specs document in its artifacts or deliverables",
      atRef: opts.atRef ?? "HEAD",
    };
  }
  const atRef = opts.atRef ?? "HEAD";
  const reader = atRef === "worktree" ? fileSystemReader(config.repoRoot) : gitObjectReader(config.repoRoot, atRef);
  const reports: CitationReport[] = [];
  for (const doc of docs) {
    try {
      reports.push(await resolveCitations(readFileSync(join(config.repoRoot, doc), "utf8"), reader, { atRef }));
    } catch (error) {
      return {
        status: "checked",
        reason: `${doc} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        atRef,
        documents: docs,
      };
    }
  }
  const checked = reports.reduce((sum, report) => sum + report.checked, 0);
  const resolved = reports.reduce((sum, report) => sum + report.resolved, 0);
  const unresolved = reports.flatMap((report) => report.unresolved);
  return {
    status: "checked",
    atRef,
    documents: docs,
    summary: `${checked} citation(s), ${resolved} resolved, ${unresolved.length} unresolved across ${docs.length} document(s)`,
    report: { atRef, checked, resolved, unresolved, checks: reports.flatMap((report) => report.checks) },
  };
}

/** Whether a pid exists. EPERM means it exists and belongs to someone else — still alive. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class RuntimeOpsView {
  readonly config: RuntimeOpsConfig;
  readonly configSource: string;
  readonly configProblems: string[];

  private constructor(config: RuntimeOpsConfig, configSource: string, configProblems: string[]) {
    this.config = config;
    this.configSource = configSource;
    this.configProblems = configProblems;
  }

  static open(resolution: ConfigResolution): RuntimeOpsView {
    return new RuntimeOpsView(resolution.config, resolution.source, resolution.problems);
  }

  /** The first read of the day costs one store open; later reads reuse it. */
  private cached?: Promise<{ store: MissionStore; events: ActivityEvent[] } | { reason: string }>;
  private store(): Promise<{ store: MissionStore; events: ActivityEvent[] } | { reason: string }> {
    if (this.cached === undefined) {
      const { file, reason } = resolveOrchestrationFile(this.config);
      this.cached = file === null ? Promise.resolve({ reason }) : openStore(file);
    }
    return this.cached;
  }

  async health(): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    const push = (name: string, ok: boolean, detail: string): void => {
      checks.push({ name, ok, detail });
    };

    push("config", this.configProblems.length === 0, `source=${this.configSource}${this.configProblems.length > 0 ? `; ${this.configProblems.join("; ")}` : ""}`);
    let writable = false;
    try {
      statSync(this.config.stateRoot);
      accessSync(this.config.stateRoot, constants.W_OK);
      writable = true;
    } catch {
      // reported below
    }
    push("stateRoot", writable, `${this.config.stateRoot} ${writable ? "exists and is writable" : "is missing or not writable"}`);
    const { file, reason } = resolveOrchestrationFile(this.config);
    // Absent-because-nothing-has-run is a known state; configured-but-unreadable is a failure.
    const storeAbsent = file === null && reason.includes("no orchestration store");
    push("orchestrationStore", file !== null || storeAbsent, file ?? (storeAbsent ? reason : reason));
    const opened = file !== null ? await this.store() : { reason };
    push("orchestrationReadable", storeAbsent || !("reason" in opened), storeAbsent ? "no store yet — nothing has run here, which is a known state, not a failure" : "reason" in opened ? opened.reason : `read-only open succeeded (a live writer lock does not block status)`);
    push("specsDir", existsSync(this.config.specsDir), this.config.specsDir);
    push("gitRef", true, `citation checks resolve against HEAD unless --at-ref worktree is passed (node ${nodeVersion})`);
    for (const problem of this.configProblems) push("configProblem", false, problem);

    return { ok: checks.every((check) => check.ok), checkedAt: new Date().toISOString(), configSource: this.configSource, checks };
  }

  async runtimeStatus(options: { windowMs?: number } = {}): Promise<RuntimeStatusReport> {
    const windowMs = options.windowMs ?? 15 * 60_000;
    const now = Date.now();

    const namespaces: { name: string; modifiedAt: string }[] = [];
    let stateRootReason = "";
    try {
      for (const entry of readdirSync(this.config.stateRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) namespaces.push({ name: entry.name, modifiedAt: statSync(join(this.config.stateRoot, entry.name)).mtime.toISOString() });
        if (namespaces.length >= 50) break;
      }
    } catch (error) {
      stateRootReason = `${this.config.stateRoot}: ${error instanceof Error ? error.message : String(error)}`;
    }

    const opened = await this.store();
    const openedStore = "reason" in opened ? undefined : opened.store;
    const events = "reason" in opened ? [] : opened.events;

    // Session liveness comes from the session-control descriptors the runtime itself writes; the view adds
    // nothing to them. A heartbeat older than the stale window is reported stale, never alive.
    let sessionsSection: RuntimeStatusReport["sessions"] = { available: false, reason: "session discovery returned nothing" };
    try {
      const descriptors = await discoverSessions();
      const all = descriptors.map((descriptor) => {
        const at = Date.parse(descriptor.heartbeatAt);
        const ageMs = Number.isFinite(at) ? now - at : null;
        const liveness: SessionLiveness = ageMs === null ? "unknown" : ageMs <= this.config.staleAfterMs ? "fresh" : "stale";
        return {
          sessionId: descriptor.sessionId,
          instanceId: descriptor.instanceId,
          pid: descriptor.pid,
          cwd: descriptor.cwd,
          startedAt: descriptor.startedAt,
          heartbeatAt: descriptor.heartbeatAt,
          ageMs,
          liveness,
          processAlive: pidAlive(descriptor.pid),
        };
      });
      sessionsSection = all.length === 0
        ? { available: false, reason: "no session descriptor is registered under the session-control roots (nothing is running here)" }
        : {
            available: true,
            data: {
              total: all.length,
              fresh: all.filter((item) => item.liveness === "fresh").length,
              stale: all.filter((item) => item.liveness === "stale").length,
              unknown: all.filter((item) => item.liveness === "unknown").length,
              // The counts cover every descriptor; only the list is bounded, so a summary can never read as
              // "50 sessions, 14 fresh" when 147 are registered. Dead-and-stale rows are still counted.
              items: all.filter((item) => item.liveness !== "stale" || item.processAlive).slice(0, 50),
            },
          };
    } catch (error) {
      sessionsSection = { available: false, reason: `session discovery failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    const missionsSection: RuntimeStatusReport["missions"] = openedStore
      ? (() => {
          const all = openedStore.listMissions().slice(0, this.config.limits.missions);
          const byStatus: Record<string, number> = {};
          for (const mission of all) byStatus[mission.status] = (byStatus[mission.status] ?? 0) + 1;
          const active = all
            .filter((mission) => !["COMPLETE", "FAILED", "CANCELED"].includes(mission.status))
            .map((mission) => ({
              missionId: mission.mission_id,
              status: mission.status,
              title: truncate(mission.title, this.config.limits.textChars),
              repository: mission.repository,
              updatedAt: mission.updated_at,
              taskCount: (mission.task_ids ?? []).length,
              blockedReason: blockedReason(mission),
            }))
            .slice(0, 50);
          return { available: true as const, data: { total: all.length, byStatus, active } };
        })()
      : { available: false as const, reason: (opened as Unavailable & { reason: string }).reason };

    const cutoff = now - windowMs;
    const recent = events
      .filter((event) => {
        const at = Date.parse(event.timestamp);
        return Number.isFinite(at) && at >= cutoff;
      })
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, this.config.limits.activityEvents);
    const activitySection: RuntimeStatusReport["activity"] =
      "reason" in opened
        ? { available: false, reason: opened.reason }
        : { available: true, data: { windowMs, events: recent, newest: events.map((event) => event.timestamp).sort().at(-1) ?? null } };

    return {
      checkedAt: new Date(now).toISOString(),
      staleAfterMs: this.config.staleAfterMs,
      node: nodeVersion,
      stateRoot: namespaces.length > 0 ? { available: true, data: { path: this.config.stateRoot, namespaces } } : { available: false, reason: stateRootReason || `${this.config.stateRoot} holds no worktree namespace yet` },
      sessions: sessionsSection,
      missions: missionsSection,
      activity: activitySection,
    };
  }

  async tasks(filter: { missionId?: string | null; statuses?: string[]; limit?: number } = {}): Promise<TaskListReport> {
    const limit = Math.min(filter.limit ?? this.config.limits.tasks, this.config.limits.tasks);
    const statuses = (filter.statuses ?? []).map((status) => status.toUpperCase());
    const opened = await this.store();
    if ("reason" in opened) {
      return { checkedAt: new Date().toISOString(), filter: { missionId: filter.missionId ?? null, statuses, limit }, total: 0, tasks: [], truncated: false };
    }
    const all = opened.store.listTasks(filter.missionId ?? undefined).map((task) => taskSummary(task, this.config.limits.textChars));
    const filtered = statuses.length > 0 ? all.filter((task) => statuses.includes(task.status)) : all;
    return {
      checkedAt: new Date().toISOString(),
      filter: { missionId: filter.missionId ?? null, statuses, limit },
      total: filtered.length,
      tasks: filtered.slice(0, limit),
      truncated: filtered.length > limit,
    };
  }

  async taskDetail(taskId: string, opts: { atRef?: string } = {}): Promise<TaskDetailReport> {
    const opened = await this.store();
    if ("reason" in opened) {
      return { checkedAt: new Date().toISOString(), taskId, found: false, reason: opened.reason };
    }
    const task = opened.store.getTask(taskId);
    if (task === undefined) {
      // Say what exists, so a typo is answerable without another command.
      const near = opened.store
        .listTasks()
        .map((entry) => entry.task_id)
        .filter((id) => id.toUpperCase().includes(taskId.toUpperCase().slice(0, 4)))
        .slice(0, 5);
      return {
        checkedAt: new Date().toISOString(),
        taskId,
        found: false,
        reason: near.length > 0 ? `no task ${taskId}; similar ids: ${near.join(", ")}` : `no task ${taskId} in this store`,
      };
    }

    const mission = opened.store.getMission(task.mission_id);
    const lifecycle = opened.store.getCanonicalLifecycle(task.mission_id);
    const artifacts = (task.artifacts ?? []).map((artifact) => ({
      value: artifact,
      absolute: isAbsoluteish(artifact) ? artifact : join(this.config.repoRoot, artifact),
    }));
    const missing = artifacts.filter((artifact) => !existsSync(artifact.absolute)).map((artifact) => artifact.value);

    return {
      checkedAt: new Date().toISOString(),
      taskId,
      found: true,
      task: taskSummary(task, this.config.limits.textChars),
      mission: mission
        ? {
            available: true,
            data: {
              missionId: mission.mission_id,
              status: mission.status,
              title: truncate(mission.title, this.config.limits.textChars),
              acceptanceCriteria: (mission.acceptance_criteria ?? []).map((criterion) => ({
                criterion: truncate(criterion.criterion, this.config.limits.textChars),
                status: criterion.status,
                ...(criterion.evidence !== undefined ? { evidence: criterion.evidence } : {}),
              })),
            },
          }
        : { available: false, reason: `mission ${task.mission_id} is not in this store` },
      lifecycle: lifecycle
        ? {
            available: true,
            data: {
              stages: Object.keys(lifecycle as unknown as Record<string, unknown>),
              current: String((lifecycle as unknown as { current?: string }).current ?? "") || null,
            },
          }
        : { available: false, reason: `no canonical lifecycle for mission ${task.mission_id}` },
      artifacts: {
        repoRelative: artifacts.filter((artifact) => !isAbsoluteish(artifact.value)).map((artifact) => artifact.value),
        absolute: artifacts.filter((artifact) => isAbsoluteish(artifact.value)).map((artifact) => artifact.value),
        missing,
      },
      citationDrift: await citationDriftForTask(task, this.config, opts),
    };
  }

  /** Reuse the ledger's own summary text so the CLI and the runtime agree on what "unresolved" means. */
  static citationSummaryText(report: CitationDriftReport): string {
    return report.summary ?? report.reason ?? "nothing checked";
  }
}
