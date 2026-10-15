/**
 * `/mission why <id>`: one answer to "why is this mission not finishing?".
 *
 * Pure projection over durable store entities (tasks, executions, failure
 * classifications, recovery decisions, leases, stops). Also owns the typed
 * per-task accounting (`TaskUsage`) and per-model error rollups so the same
 * numbers appear in the published snapshot and in `why`.
 */
import type { MissionStore } from "./missionStore.ts";
import { PLANNER_CLARIFICATION_CATEGORY } from "./types.ts";
import type {
  Execution,
  FailureClassification,
  OrchestrationTask,
  RecoveryDecision,
  ValidationEvidence,
} from "./types.ts";

/** Wall time of one task, split by where it was spent. */
export interface TaskWallTime {
  totalMs: number;
  queuedMs: number;
  admittedMs: number;
  inferenceMs: number;
  toolsMs: number;
  verifierMs: number;
}

/** Typed replacement for the untyped `Execution.usage` record, per task. */
export interface TaskUsage {
  taskId: string;
  role: string;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  wall: TaskWallTime;
  attempts: number;
  streamResumes: number;
  /** Thinking policy for the task (thinkingPolicy.ts: mission roles run off; the planner may think). */
  thinking: "off" | "on";
}

export type ModelErrorKind = "429" | "404" | "connect-refused" | "stream-stall" | "takeover" | "grammar-400";
export const MODEL_ERROR_KINDS: readonly ModelErrorKind[] = [
  "429",
  "404",
  "connect-refused",
  "stream-stall",
  "takeover",
  "grammar-400",
];

export interface ModelErrorRollup {
  model: string;
  endpoint: string;
  counts: Partial<Record<ModelErrorKind, number>>;
}

export interface VerifierStageTiming {
  name: string;
  durationMs: number | null;
  reused: boolean | null;
}

export interface ExecutionModeRecord {
  mode: string;
  reason: string;
}

export interface MissionWhy {
  missionId: string;
  title: string;
  status: string;
  blocking: {
    taskId: string | null;
    taskStatus: string | null;
    objective: string | null;
    failureCategory: string | null;
    reason: string | null;
  };
  holders: Array<{ scope: string; owner: string; since: string | null }>;
  custody: { holder: string; waitedMs: number | null } | null;
  cooldown: {
    scope: string;
    action: string;
    attempt: number;
    maxAttempts: number;
    nextActionAt: string;
    remainingMs: number;
  } | null;
  counters: {
    probeAttempt: number;
    probeMax: number;
    zeroToolRetries: number;
    zeroToolCap: number;
    zeroToolClass: string | null;
  };
  inheritedFailures: string[];
  stranded: string[];
  executionMode: ExecutionModeRecord | null;
  usage: TaskUsage[];
  usageByRole: Record<string, { promptTokens: number; completionTokens: number }>;
  modelErrors: ModelErrorRollup[];
  remedies: string[];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ms(from: string | null, to: string | null): number {
  if (!from || !to) return 0;
  const delta = Date.parse(to) - Date.parse(from);
  return Number.isFinite(delta) && delta > 0 ? delta : 0;
}

/** Typed accounting for one task from its executions (existing data only). */
export function buildTaskUsage(task: OrchestrationTask, executions: Execution[]): TaskUsage {
  let prompt = 0;
  let completion = 0;
  let resumes = 0;
  const wall: TaskWallTime = { totalMs: 0, queuedMs: 0, admittedMs: 0, inferenceMs: 0, toolsMs: 0, verifierMs: 0 };
  let thinking: "off" | "on" = task.role === "planner" ? "on" : "off";
  let model: string | null = null;
  for (const ex of executions) {
    const u = ex.usage ?? {};
    prompt += num(u.input) || num(u.promptTokens);
    completion += num(u.output) || num(u.completionTokens);
    resumes += num(u.streamResumes);
    const total = ms(ex.started_at, ex.ended_at);
    const queued = num(u.queuedMs);
    const admitted = num(u.admittedMs);
    const tools = num(u.toolsMs);
    const verifierBackend = ex.backend === "validation" || ex.backend === "integration";
    const verifier = num(u.verifierMs) || (verifierBackend ? total : 0);
    const inference =
      num(u.inferenceMs) || (ex.backend === "agent" ? Math.max(0, total - queued - admitted - tools) : 0);
    wall.totalMs += total;
    wall.queuedMs += queued;
    wall.admittedMs += admitted;
    wall.toolsMs += tools;
    wall.verifierMs += verifier;
    wall.inferenceMs += inference;
    const declared = u.thinking ?? ex.thinking_level;
    if (
      declared === true ||
      declared === "on" ||
      (typeof declared === "string" && !["off", "false"].includes(declared))
    ) {
      thinking = "on";
    }
    if (ex.model) model = ex.model;
  }
  return {
    taskId: task.task_id,
    role: task.role,
    model,
    promptTokens: prompt,
    completionTokens: completion,
    wall,
    attempts: task.attempt,
    streamResumes: resumes,
    thinking,
  };
}

const KIND_PATTERNS: Array<[ModelErrorKind, RegExp]> = [
  ["grammar-400", /\b400\b[^\n]*(grammar|gbnf|json.?schema|response_format)|grammar[^\n]*\b400\b/i],
  ["429", /\b429\b|too many requests|rate.?limit/i],
  ["404", /\b404\b|model[^\n]*not found/i],
  ["connect-refused", /ECONNREFUSED|connection refused|connect refused/i],
  ["stream-stall", /stream[^\n]*(stall|stalled|idle|cut|terminated)|no output for|inactivity/i],
  ["takeover", /take.?over|taken over|custody of another/i],
];

export function classifyModelError(text: string): ModelErrorKind | null {
  for (const [kind, pattern] of KIND_PATTERNS) if (pattern.test(text)) return kind;
  return null;
}

function endpointOf(text: string): string {
  const url = /https?:\/\/([^\s/"')]+)/.exec(text);
  return url?.[1] ?? "unknown";
}

/** Roll failure text up per model and endpoint. */
export function buildModelErrorRollups(
  executions: Execution[],
  classifications: FailureClassification[],
): ModelErrorRollup[] {
  const rows = new Map<string, ModelErrorRollup>();
  const count = (model: string, text: string): void => {
    const kind = classifyModelError(text);
    if (!kind) return;
    const endpoint = endpointOf(text);
    const key = `${model}\u0000${endpoint}`;
    const row = rows.get(key) ?? { model, endpoint, counts: {} };
    row.counts[kind] = (row.counts[kind] ?? 0) + 1;
    rows.set(key, row);
  };
  const byExecution = new Map(executions.map((e) => [e.execution_id, e] as const));
  const seen = new Set<string>();
  for (const c of classifications) {
    const ex = c.executionId ? byExecution.get(c.executionId) : undefined;
    if (ex) seen.add(ex.execution_id);
    count(ex?.model ?? "unknown", `${c.summary} ${c.evidenceRefs.join(" ")}`);
  }
  for (const ex of executions) if (ex.error && !seen.has(ex.execution_id)) count(ex.model ?? "unknown", ex.error);
  return [...rows.values()].sort((a, b) => `${a.model}${a.endpoint}`.localeCompare(`${b.model}${b.endpoint}`));
}

/**
 * Verifier stage timings from validation evidence, read defensively:
 * `durationMs` / `reused` are optional (#185 adds `reused`).
 */
type EvidenceSummaries = ReadonlyArray<Pick<ValidationEvidence, "testSummary">>;

export function buildVerifierStages(evidenceList: EvidenceSummaries): VerifierStageTiming[] {
  const out: VerifierStageTiming[] = [];
  for (const evidence of evidenceList) {
    const summary = evidence.testSummary as { stages?: unknown } | undefined;
    const stages = Array.isArray(summary?.stages) ? (summary.stages as Array<Record<string, unknown>>) : [];
    for (const stage of stages) {
      out.push({
        name: String(stage.name ?? "?"),
        durationMs: typeof stage.durationMs === "number" ? stage.durationMs : null,
        reused:
          typeof stage.reused === "boolean" ? stage.reused : typeof stage.reuse === "boolean" ? stage.reuse : null,
      });
    }
  }
  return out;
}

/** Failures that also fail on the candidate's base commit (baseline subtraction). */
export function inheritedFailuresOf(evidenceList: EvidenceSummaries): string[] {
  const out = new Set<string>();
  for (const evidence of evidenceList) {
    const list = (evidence.testSummary as { inheritedFailures?: unknown } | undefined)?.inheritedFailures;
    if (Array.isArray(list)) for (const f of list) out.add(String(f));
  }
  return [...out];
}

const CUSTODY = /custody of another live session \(((?:[^()]|\([^)]*\))*)\)/i;

export interface ExplainOptions {
  now?: number;
  executionMode?: ExecutionModeRecord | null;
}

export function explainMission(store: MissionStore, missionId: string, options: ExplainOptions = {}): MissionWhy {
  const mission = store.getMission(missionId);
  if (!mission) throw new Error(`unknown mission ${missionId}`);
  const now = options.now ?? Date.now();
  const tasks = store.listTasks(missionId);
  const executions = store.listExecutions(missionId);
  const classifications = store.listFailureClassifications(missionId);
  const recoveries = store.listRecoveryDecisions(missionId);
  const stop = store.listMissionStops(missionId).at(-1);

  const blockingTask =
    tasks.find((t) => t.status === "FAILED" || t.status === "BLOCKED") ??
    tasks.find((t) => t.status === "WAITING" || t.status === "RETRYING") ??
    null;
  const classification =
    [...classifications].reverse().find((c) => blockingTask && c.taskId === blockingTask.task_id) ??
    classifications.at(-1) ??
    null;
  const reason = blockingTask?.failure_reason ?? classification?.summary ?? stop?.reason ?? null;

  const holders: MissionWhy["holders"] = [];
  const missionLease = store.getLatestMissionLease(missionId);
  if (missionLease)
    holders.push({ scope: `mission ${missionId}`, owner: missionLease.ownerId, since: missionLease.acquiredAt });
  for (const lease of store.listRepositoryLeases(missionId)) {
    holders.push({ scope: `repository ${lease.repoId}`, owner: lease.ownerId, since: lease.acquiredAt });
  }
  for (const ex of executions) {
    if (ex.status === "RUNNING") {
      holders.push({
        scope: `lane ${ex.backend} (task ${ex.task_id})`,
        owner: `session ${ex.session_id ?? "?"} pid ${ex.pid ?? "?"}`,
        since: ex.started_at,
      });
    }
  }

  const texts = [
    reason ?? "",
    stop?.reason ?? "",
    ...classifications.map((c) => c.summary),
    ...executions.map((e) => e.error ?? ""),
  ];
  let custody: MissionWhy["custody"] = null;
  for (const text of texts) {
    const match = CUSTODY.exec(text);
    if (match?.[1]) {
      custody = { holder: match[1], waitedMs: stop ? ms(stop.stoppedAt, new Date(now).toISOString()) : null };
      break;
    }
  }

  const pending = recoveries
    .filter((r) => r.status === "planned" || r.status === "started")
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0] as RecoveryDecision | undefined;
  const cooldown: MissionWhy["cooldown"] = pending
    ? {
        scope:
          classification && classification.classificationId === pending.classificationId
            ? classification.category
            : pending.classificationId,
        action: pending.action,
        attempt: pending.attempt,
        maxAttempts: pending.maxAttempts,
        nextActionAt: pending.nextActionAt,
        remainingMs: Math.max(0, Date.parse(pending.nextActionAt) - now),
      }
    : null;

  const usage = tasks.map((t) =>
    buildTaskUsage(
      t,
      executions.filter((e) => e.task_id === t.task_id),
    ),
  );
  const usageByRole: MissionWhy["usageByRole"] = {};
  for (const u of usage) {
    const row = usageByRole[u.role] ?? { promptTokens: 0, completionTokens: 0 };
    usageByRole[u.role] = row;
    row.promptTokens += u.promptTokens;
    row.completionTokens += u.completionTokens;
  }

  const inherited = new Set<string>(inheritedFailuresOf(store.listValidationEvidence(missionId)));
  for (const ex of executions) {
    const list = (ex as unknown as { inheritedFailures?: unknown }).inheritedFailures ?? ex.usage?.inheritedFailures;
    if (Array.isArray(list)) for (const f of list) inherited.add(String(f));
  }
  const stranded = new Set<string>(stop?.preservedWork ?? []);
  for (const f of store.listFindings(missionId)) {
    if (f.category === "stranded_worker_work" && f.status === "open" && f.evidence) stranded.add(f.evidence);
  }

  const structured = pending?.zeroToolWait;
  const zeroTool = structured
    ? null
    : /(\d+)\/(\d+) zero-tool-call retries \(([^)]*)\)/.exec(pending?.expectedMaterialChange ?? "");

  const remedies: string[] = [];
  const terminal = ["COMPLETE", "FAILED", "CANCELED"].includes(mission.status);
  if (!terminal) {
    const named = [stop?.resumeCondition, pending?.operatorGuidance].filter((t): t is string => Boolean(t));
    const waiting = cooldown && cooldown.remainingMs > 0 ? cooldown : null;
    if (custody) {
      remedies.push(
        `waiting on custody held by ${custody.holder}; the mission continues when that session releases it (close that session if it is idle)`,
      );
    } else if (waiting) {
      remedies.push(
        `waiting for ${waiting.scope} until ${waiting.nextActionAt} (${duration(waiting.remainingMs)} remaining); after that: /mission resume ${missionId}`,
      );
    } else {
      remedies.push(`/mission resume ${missionId}`);
    }
    // Releasing a pin helps only when the mission carries one and the stop or decision names it.
    if (!custody && !waiting && mission.operator_model_pin && named.some((t) => /pin/i.test(t))) {
      remedies.push(`/mission resume ${missionId} --model auto`);
    }
    remedies.push(`/mission cancel ${missionId}`);
    if (stop?.resumeCondition) remedies.push(`resume condition: ${stop.resumeCondition}`);
    if (pending?.operatorGuidance) remedies.push(`operator question: ${pending.operatorGuidance}`);
    const asked = store
      .listFindings(missionId)
      .filter((f) => f.category === PLANNER_CLARIFICATION_CATEGORY && f.status === "open")
      .at(-1)?.evidence;
    if (asked && !pending?.operatorGuidance?.includes(asked)) remedies.push(`planner question: ${asked}`);
    if (pending && pending.action === "PROBE_AND_BACKOFF") remedies.push(`wait: ${pending.expectedMaterialChange}`);
  }

  return {
    missionId,
    title: mission.title,
    status: mission.status,
    blocking: {
      taskId: blockingTask?.task_id ?? null,
      taskStatus: blockingTask?.status ?? null,
      objective: blockingTask?.objective ?? null,
      failureCategory: classification?.category ?? null,
      reason,
    },
    holders,
    custody,
    cooldown,
    counters: {
      probeAttempt: pending?.attempt ?? 0,
      probeMax: pending?.maxAttempts ?? 0,
      zeroToolRetries: structured?.retries ?? (zeroTool ? Number(zeroTool[1]) : 0),
      zeroToolCap: structured?.cap ?? (zeroTool ? Number(zeroTool[2]) : 0),
      zeroToolClass: structured?.failureClass ?? zeroTool?.[3] ?? null,
    },
    inheritedFailures: [...inherited],
    stranded: [...stranded],
    executionMode: options.executionMode ?? mission.execution_mode ?? null,
    usage,
    usageByRole,
    modelErrors: buildModelErrorRollups(executions, classifications),
    remedies,
  };
}

function duration(msValue: number): string {
  const s = Math.round(msValue / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export function formatModelErrors(rows: ModelErrorRollup[]): string[] {
  return rows.map(
    (r) =>
      `  ${r.model} @ ${r.endpoint}: ${MODEL_ERROR_KINDS.filter((k) => r.counts[k])
        .map((k) => `${k}=${r.counts[k]}`)
        .join(" ")}`,
  );
}

export function formatMissionWhy(why: MissionWhy): string {
  const lines = [`Mission ${why.missionId} [${why.status}] ${why.title}`];
  const b = why.blocking;
  lines.push(
    b.taskId
      ? `Blocking task: ${b.taskId} [${b.taskStatus}] ${b.objective}`
      : "Blocking task: none (no failed or waiting task)",
  );
  lines.push(`Failure: ${b.failureCategory ?? "unclassified"} - ${b.reason ?? "no reason recorded"}`);
  for (const h of why.holders) lines.push(`Held: ${h.scope} by ${h.owner}${h.since ? ` since ${h.since}` : ""}`);
  if (why.custody) {
    lines.push(
      `Custody: waiting on ${why.custody.holder}${why.custody.waitedMs !== null ? ` (waited ${duration(why.custody.waitedMs)})` : ""}`,
    );
  }
  if (why.cooldown) {
    const c = why.cooldown;
    lines.push(
      `Cooldown: ${c.scope} ${c.action} attempt ${c.attempt}/${c.maxAttempts}, nextActionAt ${c.nextActionAt} (${duration(c.remainingMs)} remaining)`,
    );
  }
  const c = why.counters;
  lines.push(
    `Retries: probe ${c.probeAttempt}/${c.probeMax}, zero-tool ${c.zeroToolRetries}/${c.zeroToolCap}${c.zeroToolClass ? ` (${c.zeroToolClass})` : ""}`,
  );
  if (why.inheritedFailures.length) lines.push(`Inherited failures: ${why.inheritedFailures.join(", ")}`);
  if (why.stranded.length) lines.push(`Stranded work: ${why.stranded.join(", ")}`);
  lines.push(
    why.executionMode
      ? `Execution mode: ${why.executionMode.mode} (${why.executionMode.reason})`
      : "Execution mode: not recorded",
  );
  if (why.usage.length) {
    lines.push("Usage:");
    for (const u of why.usage) {
      lines.push(
        `  ${u.taskId} ${u.role} prompt=${u.promptTokens} completion=${u.completionTokens} attempts=${u.attempts} resumes=${u.streamResumes} thinking=${u.thinking} wall=${duration(u.wall.totalMs)} (queued ${duration(u.wall.queuedMs)}, admitted ${duration(u.wall.admittedMs)}, inference ${duration(u.wall.inferenceMs)}, tools ${duration(u.wall.toolsMs)}, verifier ${duration(u.wall.verifierMs)})`,
      );
    }
  }
  if (why.modelErrors.length) lines.push("Model errors:", ...formatModelErrors(why.modelErrors));
  lines.push(
    "Remedy:",
    ...(why.remedies.length ? why.remedies.map((r) => `  ${r}`) : ["  none (mission is terminal)"]),
  );
  return `${lines.join("\n")}\n`;
}
