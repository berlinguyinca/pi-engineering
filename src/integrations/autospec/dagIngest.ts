/**
 * AutoSpec task DAG -> Pi plan tasks (T04).
 *
 * Optional adapter, pure (no I/O). AutoSpec supplies a DAG and issue linkage;
 * Pi remains the execution authority, so the result is only a PLAN: it still goes
 * through the plan-review gate (planBinding.ts) and then Pi's own leases,
 * worktrees and review. Nothing here copies authority from AutoSpec
 * (fencing tokens, generations, recovery or candidate fields).
 *
 * Fail closed on: invalid records, a mission that is not pre-execution, tasks
 * that are not yet-to-start, `autospec-managed` executors (Pi does not hand work
 * to a second executor here), duplicate task ids/sequences, mission_id
 * mismatch, missing dependencies, cycles, shared exclusivity keys, unsafe
 * paths, unqualified or malformed issue refs, and any REQUIRED extension that
 * is not in {@link KNOWN_REQUIRED_EXTENSIONS}.
 */

import type { PlanTaskInput } from "../../orchestration/orchestrator.ts";
import { type ProtocolRejection, parseMission, parseTask } from "./protocol.ts";

/** The one extension Pi understands: repo-qualified issue linkage. */
export const ISSUE_REFS_EXTENSION = "autospec.issue_refs";
export const KNOWN_REQUIRED_EXTENSIONS: readonly string[] = [ISSUE_REFS_EXTENSION];

const ISSUE_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]{0,9}$/;
const INGESTABLE_MISSION_STATES = ["CREATED", "PLANNED", "READY"];
const INGESTABLE_TASK_STATES = ["DEFINED", "BLOCKED", "READY"];

export type DagRejectionCode =
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "SCHEMA_VIOLATION"
  | "MISSING_FIELD"
  | "INVALID_FIELD"
  | "UNKNOWN_REQUIRED_FIELD"
  | "UNKNOWN_FIELD"
  | "MISSION_NOT_INGESTABLE"
  | "TASK_NOT_INGESTABLE"
  | "EXECUTOR_NOT_SUPPORTED"
  | "MISSION_ID_MISMATCH"
  | "DUPLICATE_TASK"
  | "SEQUENCE_GAP"
  | "IDEMPOTENCY_KEY_REUSED"
  | "MISSING_DEPENDENCY"
  | "CYCLE"
  | "EXCLUSIVITY_CONFLICT"
  | "UNSAFE_PATH"
  | "INVALID_ISSUE_REF"
  | "EMPTY_DAG"
  | "NO_SURFACES";

export type DagIngestResult =
  | {
      ok: true;
      missionId: string;
      goal: string;
      tasks: PlanTaskInput[];
      /** task_id -> sorted repo-qualified issue refs ("owner/repo#N"). */
      issueRefs: Record<string, string[]>;
      /** Names of optional, non-required extension keys that were NOT carried over. */
      ignoredExtensions: string[];
    }
  | { ok: false; code: DagRejectionCode; message: string };

const reject = (code: DagRejectionCode, message: string): DagIngestResult => ({ ok: false, code, message });

class Reject extends Error {
  readonly code: DagRejectionCode;
  constructor(code: DagRejectionCode, message: string) {
    super(message);
    this.code = code;
  }
}

function safeDomain(path: string, taskId: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((seg) => seg === ".." || seg === ".")
  ) {
    throw new Reject("UNSAFE_PATH", `task ${taskId}: unsafe affected path ${JSON.stringify(path)}`);
  }
  // A directory surface ("schemas/") means everything beneath it.
  return path.endsWith("/") ? `${path}**` : path;
}

function checkExtensions(
  rec: { required_extensions: string[]; extensions?: Record<string, unknown> },
  where: string,
  ignored: Set<string>,
): void {
  for (const name of rec.required_extensions) {
    if (!KNOWN_REQUIRED_EXTENSIONS.includes(name)) {
      throw new Reject("UNKNOWN_REQUIRED_FIELD", `${where}: required extension "${name}" is not understood`);
    }
    if (rec.extensions?.[name] === undefined) {
      throw new Reject("MISSING_FIELD", `${where}: required extension "${name}" is absent from extensions`);
    }
  }
  for (const key of Object.keys(rec.extensions ?? {})) {
    if (key !== ISSUE_REFS_EXTENSION) ignored.add(key);
  }
}

function issueRefsOf(ext: Record<string, unknown> | undefined, taskId: string): string[] {
  const raw = ext?.[ISSUE_REFS_EXTENSION];
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    throw new Reject("INVALID_ISSUE_REF", `task ${taskId}: ${ISSUE_REFS_EXTENSION} must be an array`);
  const out = new Set<string>();
  for (const ref of raw) {
    if (typeof ref !== "string" || !ISSUE_REF.test(ref)) {
      throw new Reject(
        "INVALID_ISSUE_REF",
        `task ${taskId}: issue ref ${JSON.stringify(ref)} must be repo-qualified "owner/repo#N"`,
      );
    }
    out.add(ref);
  }
  return [...out].sort();
}

/** First dependency cycle as a path (a -> b -> a), or null. Deterministic. */
export function findCycle(deps: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const next of [...(deps.get(id) ?? [])].sort()) {
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of [...deps.keys()].sort())
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  return null;
}

export interface DagIngestInput {
  mission: unknown;
  tasks: readonly unknown[];
  /** The mission record carries no goal; supplied by the caller. Default is deterministic. */
  goal?: string;
}

export function ingestAutoSpecDag(input: DagIngestInput): DagIngestResult {
  try {
    return ingest(input);
  } catch (e) {
    if (e instanceof Reject) return reject(e.code, e.message);
    const code = (e as ProtocolRejection)?.code;
    if (typeof code === "string") return reject(code as DagRejectionCode, (e as Error).message);
    throw e;
  }
}

function ingest(input: DagIngestInput): DagIngestResult {
  const mission = parseMission(input.mission);
  const ignored = new Set<string>();
  checkExtensions(mission, `mission ${mission.mission_id}`, ignored);
  if (!INGESTABLE_MISSION_STATES.includes(mission.state)) {
    throw new Reject(
      "MISSION_NOT_INGESTABLE",
      `mission ${mission.mission_id} is ${mission.state}; only a mission that has not started can be planned`,
    );
  }
  if (input.tasks.length === 0) throw new Reject("EMPTY_DAG", "the mission has no tasks");

  const parsed = input.tasks.map((t) => parseTask(t));
  parsed.sort((a, b) => a.sequence - b.sequence);
  const ids = new Set<string>();
  const keys = new Map<string, number>();
  const exclusivity = new Map<string, string>();
  parsed.forEach((t, i) => {
    const where = `task ${t.task_id}`;
    if (t.mission_id !== mission.mission_id) {
      throw new Reject("MISSION_ID_MISMATCH", `${where} belongs to mission ${t.mission_id}, not ${mission.mission_id}`);
    }
    if (t.sequence !== i + 1) {
      throw new Reject("SEQUENCE_GAP", `${where}: expected sequence ${i + 1}, got ${t.sequence}`);
    }
    if (keys.has(t.idempotency_key)) {
      throw new Reject("IDEMPOTENCY_KEY_REUSED", `${where}: idempotency key reused at sequence ${t.sequence}`);
    }
    keys.set(t.idempotency_key, t.sequence);
    if (ids.has(t.task_id)) throw new Reject("DUPLICATE_TASK", `duplicate task_id ${t.task_id}`);
    ids.add(t.task_id);
    checkExtensions(t, where, ignored);
    if (!INGESTABLE_TASK_STATES.includes(t.state)) {
      throw new Reject(
        "TASK_NOT_INGESTABLE",
        `${where} is ${t.state}; only tasks that have not started can be planned`,
      );
    }
    if (t.executor !== "pi-local") {
      throw new Reject(
        "EXECUTOR_NOT_SUPPORTED",
        `${where} has executor ${t.executor}; Pi executes every ingested task itself (executor must be pi-local)`,
      );
    }
    if (t.affected_surfaces.length === 0) {
      throw new Reject("NO_SURFACES", `${where} declares no affected surfaces`);
    }
    if (t.exclusivity !== undefined) {
      const owner = exclusivity.get(t.exclusivity);
      if (owner)
        throw new Reject("EXCLUSIVITY_CONFLICT", `${where} and task ${owner} share exclusivity key "${t.exclusivity}"`);
      exclusivity.set(t.exclusivity, t.task_id);
    }
  });

  const deps = new Map<string, string[]>();
  for (const t of parsed) {
    const unique = [...new Set(t.depends_on)];
    for (const d of unique) {
      if (!ids.has(d)) throw new Reject("MISSING_DEPENDENCY", `task ${t.task_id} depends on unknown task ${d}`);
    }
    deps.set(t.task_id, unique);
  }
  const cycle = findCycle(deps);
  if (cycle) throw new Reject("CYCLE", `dependency cycle: ${cycle.join(" -> ")}`);

  const issueRefs: Record<string, string[]> = {};
  const tasks: PlanTaskInput[] = parsed.map((t) => {
    const refs = issueRefsOf(t.extensions, t.task_id);
    issueRefs[t.task_id] = refs;
    const paths = t.affected_surfaces.map((s) => s.path);
    const symbols = t.affected_surfaces
      .filter((s) => s.symbols?.length)
      .map((s) => ({ path: s.path, symbols: [...(s.symbols ?? [])].sort() }));
    return {
      task_id: t.task_id,
      kind: "agent",
      role: "implementer",
      objective: `AutoSpec task ${t.task_id}: implement changes in ${paths.join(", ")}${refs.length ? ` (issues: ${refs.join(", ")})` : ""}`,
      // Dependent -> prerequisite, as AutoSpec states it.
      depends_on: deps.get(t.task_id) ?? [],
      priority: 0,
      mutates_repo: true,
      write_domains: [...new Set(t.affected_surfaces.map((s) => safeDomain(s.path, t.task_id)))].sort(),
      isolation: "worktree",
      max_attempts: 3,
      failure_policy: "retry",
      // Explicit data, covered by the plan digest. No authority fields from AutoSpec.
      execution_requirements: {
        autospec: {
          mission_id: mission.mission_id,
          task_id: t.task_id,
          ...(t.exclusivity ? { exclusivity: t.exclusivity } : {}),
          issue_refs: refs,
          ...(symbols.length ? { symbols } : {}),
        },
      },
    };
  });

  return {
    ok: true,
    missionId: mission.mission_id,
    goal: input.goal?.trim() || `AutoSpec mission ${mission.mission_id}`,
    tasks,
    issueRefs,
    ignoredExtensions: [...ignored].sort(),
  };
}
