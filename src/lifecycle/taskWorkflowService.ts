/**
 * Task workflow — the two questions that bracket a task's life, answered from the files that already exist.
 *
 * 1. MATERIALIZE: "the plan lists 20 tasks; what are they, in what order, do they depend on things that
 *    exist, and what would each one's Task Contract say?" A plan is prose. The runtime runs contracts. The
 *    gap between them is where duplicate ids, typos in `Depends on`, and tasks that were written twice get
 *    discovered -- in production, after the workers started. Materializing turns the prose into a checked
 *    manifest before anything is dispatched.
 * 2. HANDOFF-CHECK: "did this task finish and prove it?" The handoff trail is the proof: one record per
 *    planned task, schema-valid, hash-stamped, with every declared artifact present and committed, and
 *    nothing of the run still alive. That verification already exists for the bootstrapping audit trail;
 *    this exposes it as a normal runtime query for any trail, without reimplementing its rules.
 *
 * Both are read-only by default. Materializing a contract *draft* is not granting authorization: the
 * contract file a worker runs under stays an explicit, reviewed artifact, and files are written only when
 * the caller passes `writeDir`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  GENERATION_ORDER,
  matchLiveRunners,
  selectCanonical,
  unreadGenerations,
  verifyTrail,
  type LiveProcess,
  type TrailIssue,
  type TrailRecordGeneration,
  type TrailVerdict,
} from "../bootstrap/trailVerifier.ts";
import { contractHash, parseContract, type TaskContract } from "../taskDiscipline/contract.ts";

/** A task pulled out of a plan document or a trail manifest. */
export interface MaterializedTask {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  /** Where it came from, so a duplicate or a bad dependency is traceable to a line. */
  sources: string[];
}

export interface ContractDraft {
  taskId: string;
  ok: boolean;
  /** The validated contract, only when `ok`. */
  contract?: TaskContract;
  /** Authorization hash of the draft, only when `ok` -- the value a handoff record binds. */
  hash?: string;
  error?: string;
}

export interface MaterializeReport {
  ok: boolean;
  checkedAt: string;
  inputs: string[];
  tasks: MaterializedTask[];
  /** Task ids appearing more than once, with each source. */
  duplicates: { id: string; sources: string[] }[];
  /** `Depends on` names that no task defines. */
  unknownDependencies: { taskId: string; dependency: string }[];
  /** Dependency cycles, each as a path like `A -> B -> A`. */
  cycles: string[];
  /** Contract drafts and whether they validate. Empty with `contractReason` when there is no template. */
  contracts: ContractDraft[];
  contractReason?: string;
  problems: string[];
  /** Files written, only when `writeDir` was given. */
  written?: string[];
}

const HEADING = /^#{1,6}\s+(?:Task|TASK)\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*[:\-–]\s*(.+?)\s*$/u;
const DEPENDS = /^\s*(?:[-*]\s*)?(?:\*\*)?Depends on(?:\*\*)?\s*:\s*(.+)$/iu;
const DEPENDS_SPLIT = /[,;&/]|\band\b|\bthen\b/ui;

function splitDependencies(value: string): string[] {
  return value
    .split(DEPENDS_SPLIT)
    .map((token) => token.trim().replace(/[.*`]/gu, ""))
    .filter((token) => token !== "" && token !== "none" && token !== "None")
    .filter((token) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(token));
}

/** Read a plan markdown file into tasks: a heading opens a task, a `Depends on:` line closes its edges. */
export function parsePlanFile(file: string): { tasks: MaterializedTask[]; problems: string[] } {
  const problems: string[] = [];
  const tasks: MaterializedTask[] = [];
  let current: MaterializedTask | null = null;
  const lines = readFileSync(file, "utf8").split(/\r?\n/u);
  lines.forEach((line, index) => {
    const where = `${basename(file)}:${index + 1}`;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      current = { id: heading[1]!, title: heading[2]!.trim(), objective: heading[2]!.trim(), dependsOn: [], sources: [where] };
      tasks.push(current);
      return;
    }
    const depends = DEPENDS.exec(line);
    if (depends !== null && current !== null) {
      const found = splitDependencies(depends[1]!);
      if (found.length === 0 && depends[1]!.trim() !== "" && !/none/iu.test(depends[1]!)) {
        problems.push(`${where}: "Depends on" lists ${depends[1]!.trim()}, which names no task id`);
      }
      current.dependsOn.push(...found);
    }
  });
  return { tasks, problems };
}

/** A trail manifest (`manifests/tasks.json`) is a machine-readable plan; it wins over prose. */
export function parseTrailManifest(file: string): { tasks: MaterializedTask[]; problems: string[] } {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { tasks?: { id?: unknown; title?: unknown; objective?: unknown; dependsOn?: unknown }[] };
  const problems: string[] = [];
  const tasks: MaterializedTask[] = [];
  for (const entry of raw.tasks ?? []) {
    if (typeof entry.id !== "string" || entry.id === "") {
      problems.push(`${file}: a manifest entry has no id`);
      continue;
    }
    tasks.push({
      id: entry.id,
      title: typeof entry.title === "string" ? entry.title : entry.id,
      objective: typeof entry.objective === "string" ? entry.objective : typeof entry.title === "string" ? entry.title : entry.id,
      dependsOn: Array.isArray(entry.dependsOn) ? entry.dependsOn.filter((dep): dep is string => typeof dep === "string") : [],
      sources: [`${basename(file)}#${entry.id}`],
    });
  }
  return { tasks, problems };
}

/** Depth-first cycle detection over `dependsOn`, reported as concrete paths. */
function findCycles(tasks: readonly MaterializedTask[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cycles: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const walk = (id: string): void => {
    const mark = state.get(id);
    if (mark === "done") return;
    if (mark === "visiting") {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id].join(" -> "));
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency)) walk(dependency);
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const task of tasks) walk(task.id);
  return [...new Set(cycles)];
}

function loadContractTemplate(input: { trailDir?: string | null; template?: Record<string, unknown> | null }): { template: Record<string, unknown> | null; reason: string } {
  if (input.template !== null && input.template !== undefined) return { template: input.template, reason: "" };
  if (typeof input.trailDir === "string") {
    const file = join(input.trailDir, "templates", "task-contract.json");
    if (existsSync(file)) return { template: JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>, reason: "" };
    return { template: null, reason: `${file} does not exist, so no contract drafts could be built` };
  }
  return { template: null, reason: "no contract template was supplied (--template or a trail templates/task-contract.json)" };
}

/**
 * Turn plan prose / trail manifests into a checked task list plus validated contract drafts.
 *
 * The plan manifest wins over prose when both exist, because the runtime already treats `manifests/tasks.json`
 * as the ordered truth (the trail verifier reads record order from it, never from the records).
 */
export function materializeTasks(input: {
  /** A plan markdown file. */
  planFile?: string | null;
  /** A trail directory: reads `manifests/tasks.json` and `templates/task-contract.json`. */
  trailDir?: string | null;
  /** A specs directory: every trail inside it is materialized. */
  specsDir?: string | null;
  repoRoot: string;
  template?: Record<string, unknown> | null;
  /** Write `<id>.contract.json` + `tasks.json` here. Absent means read-only. */
  writeDir?: string | null;
}): MaterializeReport {
  const repoRoot = resolve(input.repoRoot);
  const inputs: string[] = [];
  const problems: string[] = [];
  const collected: MaterializedTask[] = [];

  const trailDir = typeof input.trailDir === "string" ? resolve(input.trailDir) : null;
  const manifest = trailDir !== null ? join(trailDir, "manifests", "tasks.json") : null;
  if (manifest !== null && existsSync(manifest)) {
    inputs.push(manifest);
    try {
      collected.push(...parseTrailManifest(manifest).tasks);
    } catch (error) {
      problems.push(`${manifest}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (typeof input.specsDir === "string") {
    const specsDir = resolve(input.specsDir);
    for (const entry of existsSync(specsDir) ? readdirSync(specsDir, { withFileTypes: true }) : []) {
      if (!entry.isDirectory()) continue;
      const candidate = join(specsDir, entry.name, "manifests", "tasks.json");
      if (!existsSync(candidate)) continue;
      inputs.push(candidate);
      try {
        collected.push(...parseTrailManifest(candidate).tasks);
      } catch (error) {
        problems.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (typeof input.planFile === "string") {
    const planFile = resolve(input.planFile);
    inputs.push(planFile);
    try {
      const parsed = parsePlanFile(planFile);
      collected.push(...parsed.tasks);
      problems.push(...parsed.problems);
    } catch (error) {
      problems.push(`${planFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Deduplicate: the first occurrence wins, and every later source is recorded against the id.
  const byId = new Map<string, MaterializedTask>();
  const duplicates: { id: string; sources: string[] }[] = [];
  for (const task of collected) {
    const existing = byId.get(task.id);
    if (existing === undefined) {
      byId.set(task.id, { ...task, dependsOn: [...new Set(task.dependsOn)] });
      continue;
    }
    existing.sources.push(...task.sources);
    duplicates.push({ id: task.id, sources: existing.sources });
  }
  const tasks = [...byId.values()];

  const known = new Set(tasks.map((task) => task.id));
  const unknownDependencies: { taskId: string; dependency: string }[] = [];
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!known.has(dependency)) unknownDependencies.push({ taskId: task.id, dependency });
      if (dependency === task.id) problems.push(`${task.id} depends on itself`);
    }
  }
  const cycles = findCycles(tasks);
  const selfLoops = cycles.filter((cycle) => cycle.split(" -> ").length === 2);

  const { template, reason } = loadContractTemplate({ trailDir, template: input.template ?? null });
  const contracts: ContractDraft[] = [];
  let contractReason = reason;
  if (template !== null) {
    for (const task of tasks) {
      const draft = { ...template, taskId: task.id, objective: task.objective };
      try {
        const contract = parseContract(draft);
        contracts.push({ taskId: task.id, ok: true, contract, hash: contractHash(contract) });
      } catch (error) {
        contracts.push({ taskId: task.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (contracts.some((draft) => !draft.ok)) contractReason = "one or more drafts failed validation; see contracts[]";
  }

  const written: string[] = [];
  if (typeof input.writeDir === "string") {
    const writeDir = resolve(input.writeDir);
    mkdirSync(writeDir, { recursive: true });
    const manifestFile = join(writeDir, "tasks.json");
    writeFileSync(manifestFile, `${JSON.stringify({ tasks: tasks.map((task) => ({ id: task.id, title: task.title, objective: task.objective, dependsOn: task.dependsOn })) }, null, 2)}\n`);
    written.push(manifestFile);
    // Only validated drafts are written: an invalid contract must not reach a worker.
    for (const draft of contracts.filter((entry) => entry.ok)) {
      const file = join(writeDir, `${draft.taskId}.contract.json`);
      writeFileSync(file, `${JSON.stringify(draft.contract, null, 2)}\n`);
      written.push(file);
    }
  }

  return {
    ok: duplicates.length === 0 && unknownDependencies.length === 0 && cycles.length === 0 && contracts.every((draft) => draft.ok) && problems.length === 0,
    checkedAt: new Date().toISOString(),
    inputs,
    tasks,
    duplicates,
    unknownDependencies,
    cycles: [...selfLoops, ...cycles],
    contracts,
    ...(contractReason !== "" ? { contractReason } : {}),
    problems,
    ...(typeof input.writeDir === "string" ? { written } : {}),
  };
}

export interface HandoffCheckReport {
  ok: boolean;
  trail: string;
  rev: string;
  planned: number;
  canonical: number;
  superseded: number;
  /** Generation directories the reader cannot rank -- a new directory is never quietly skipped. */
  unreadGenerations: string[];
  issues: TrailIssue[];
  /** Processes still alive that the audited checkout started. */
  liveRunners: number;
  unattributedRunners: number;
  verdict?: TrailVerdict;
  reason?: string;
}

function liveProcesses(recorded: readonly string[], root: string): { processes: LiveProcess[]; error: string | null } {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 10_000 });
    const processes: LiveProcess[] = [];
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
      if (match === null) continue;
      const command = match[2]!;
      if (recorded.length > 0 && !recorded.some((entry) => command.includes(entry))) continue;
      // An unreadable cwd is never attributed; report it as such by leaving cwd null.
      processes.push({ pid: Number(match[1]), command, cwd: null });
    }
    return { processes, error: null };
  } catch (error) {
    return { processes: [], error: `process table unreadable (${error instanceof Error ? error.message : String(error)}); the liveness gate was skipped` };
  }
}

/**
 * Verify a handoff trail: every planned task has exactly one canonical record, that record satisfies the
 * trail's schema and its own stamped hash, its declared artifacts exist and are committed, and nothing it
 * started is still running. Rules come from `src/bootstrap/trailVerifier.ts` — this function only does I/O,
 * so a trail verified here and verified by the audit script cannot disagree.
 */
export function checkHandoffTrail(input: { trail: string; repoRoot?: string; rev?: string; checkCommitted?: boolean; checkLive?: boolean }): HandoffCheckReport {
  const trail = resolve(input.trail);
  const rev = input.rev ?? "HEAD";
  const trailName = trail.replace(/\/+$/u, "");
  const empty: HandoffCheckReport = { ok: false, trail: trailName, rev, planned: 0, canonical: 0, superseded: 0, unreadGenerations: [], issues: [], liveRunners: 0, unattributedRunners: 0 };

  if (!existsSync(trailName) || !statSync(trailName).isDirectory()) return { ...empty, reason: `${trailName} is not a directory` };
  const manifestFile = join(trailName, "manifests", "tasks.json");
  const schemaFile = join(trailName, "templates", "handoff.schema.json");
  if (!existsSync(manifestFile)) return { ...empty, reason: `${manifestFile} is missing: record order must come from the plan, never from the records` };
  if (!existsSync(schemaFile)) return { ...empty, reason: `${schemaFile} is missing: records cannot be validated without the trail's own schema` };

  let order: string[];
  let schema: unknown;
  try {
    order = ((JSON.parse(readFileSync(manifestFile, "utf8")) as { tasks: { id: string }[] }).tasks ?? []).map((task) => task.id);
    schema = JSON.parse(readFileSync(schemaFile, "utf8"));
  } catch (error) {
    return { ...empty, reason: `${error instanceof Error ? error.message : String(error)}` };
  }

  const root = (() => {
    try {
      return resolve(input.repoRoot ?? execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
    } catch {
      return resolve(input.repoRoot ?? dirname(trailName));
    }
  })();
  /** A record names artifacts repo-relative; an older trail named them trail-relative. Accept both. */
  const candidates = (path: string): string[] => [...new Set([path, relative(root, join(trailName, path)).replace(/\\/gu, "/")])];
  const artifactExists = (path: string): boolean => candidates(path).some((candidate) => existsSync(resolve(root, candidate)));
  const committed = (path: string): boolean =>
    candidates(path).some((candidate) => {
      try {
        execFileSync("git", ["cat-file", "-e", `${rev}:${candidate}`], { cwd: root, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    });

  const records: TrailRecordGeneration[] = [];
  const unread: string[] = [];
  const skip = new Set(["manifests", "templates", "logs", "out"]);
  const taskDirs = readdirSync(trailName, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !skip.has(entry.name));
  const dirNames = new Map<string, string[]>();
  for (const entry of taskDirs) dirNames.set(entry.name, readdirSync(join(trailName, entry.name), { withFileTypes: true }).filter((sub) => sub.isDirectory()).map((sub) => sub.name));
  for (const [task, names] of dirNames) unread.push(...[...new Set(unreadGenerations(names))].map((name) => `${task}/${name}`));

  for (const entry of taskDirs) {
    GENERATION_ORDER.forEach((generation, rank) => {
      const nested = join(trailName, entry.name, generation, `${entry.name}.handoff.json`);
      const flat = join(trailName, entry.name, `${entry.name}.handoff.json`);
      const file = generation === "" ? flat : nested;
      if (!existsSync(file)) return;
      try {
        records.push({ taskId: entry.name, generation: rank, record: JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> });
      } catch (error) {
        unread.push(`${entry.name}/${generation || "."} (unreadable: ${error instanceof Error ? error.message : String(error)})`);
      }
    });
  }

  const canonical = selectCanonical(records);
  const commands = [...new Set(canonical.flatMap((entry) => (Array.isArray(entry.record.commands) ? entry.record.commands : []).flatMap((command) => command !== null && typeof command === "object" && typeof (command as Record<string, unknown>).command === "string" ? [(command as Record<string, unknown>).command as string] : [])))];

  let liveRunners = 0;
  let unattributedRunners = 0;
  let liveSkippedReason = "";
  let liveRunnersList: readonly string[] | undefined;
  if (input.checkLive !== false) {
    const { processes, error } = liveProcesses(commands, root);
    if (error !== null) {
      liveSkippedReason = error;
    } else {
      const match = matchLiveRunners(processes, commands, root);
      liveRunners = match.attributed.length;
      unattributedRunners = match.unattributed;
      liveRunnersList = match.attributed;
    }
  }

  const verdict = verifyTrail({
    schema,
    order,
    records: canonical,
    artifactExists,
    ...(input.checkCommitted === false ? {} : { committed }),
    ...(liveRunnersList !== undefined && liveRunnersList.length > 0 ? { liveRunners: liveRunnersList } : {}),
  });

  return {
    ok: verdict.ok && unread.length === 0,
    trail: trailName,
    rev,
    planned: order.length,
    canonical: canonical.length,
    superseded: records.length - canonical.length,
    unreadGenerations: [...new Set(unread)].sort(),
    // The verdict is the shared verifier's, unchanged; unranked generations are surfaced in their own field
    // and flip `ok`, so a new generation directory can never be verified past quietly.
    issues: [...verdict.issues],
    liveRunners,
    unattributedRunners,
    verdict,
    ...(liveSkippedReason !== "" ? { reason: liveSkippedReason } : {}),
  };
}
