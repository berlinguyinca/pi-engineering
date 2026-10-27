import type { MissionStatus } from "../orchestration/types.ts";
import { redactSecrets } from "../platform/redact.ts";
import type { RuntimeMissionActivityEvent } from "../runtime/EngineeringRuntime.ts";
import { missionActivityAge } from "../tools/missionReport.ts";
import { formatMissionActivity } from "./missionActivity.ts";

/** How a mission's percentage was obtained; "inferred" must never read as measured. */
export type PresenceBasis = "weighted_dag" | "inferred";

export interface PresenceRow {
  missionId: string;
  title: string;
  marker: string;
  token: string;
  percent: string;
  unit: string;
  age: string;
  attention: boolean;
  /** Why this mission deserves attention, when there is a fact that says so. */
  attentionReason?: string;
}

export interface PresenceView {
  header: string;
  rows: PresenceRow[];
  overflow: string | null;
  /** The one-line story for the mission that owns the working line. */
  workingLine: string | null;
  /** Which mission that line belongs to, so a caller can substitute its own text. */
  workingMissionId: string | null;
}

/** States that mean the operator is the next actor, not the runtime. */
const NEEDS_YOU = new Set(["NEEDS_ATTENTION", "WAITING_FOR_USER"]);
/** States where automatic progress has stopped and will not resume itself. */
const PARKED = new Set(["BLOCKED", "PAUSED_INFRASTRUCTURE"]);
const TERMINAL = new Set(["COMPLETE", "CANCELED", "FAILED"]);
const QUEUED = new Set(["NEW", "CLASSIFYING", "PLANNING", "READY", "QUEUED"]);

const HEALTH_RANK: Record<string, number> = {
  blocked: 0,
  failed: 0,
  stalled: 1,
  slow: 2,
  waiting: 3,
  active: 4,
  complete: 5,
};
const HEALTH_TIE = 6;

/**
 * Attention order, lowest first. Derived from the mission's own state and the
 * health the observability service already computed — presence never re-derives
 * health, it only orders by it.
 */
/**
 * Attention severity → rank. Attention can only raise a mission, never demote
 * one: a mission the operator must act on is already rank 0, and a mission that
 * is merely looping should not be pushed below one that has genuinely stopped.
 */
const ATTENTION_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 5 };

export function presenceRank(event: RuntimeMissionActivityEvent): number {
  const stateRank = statePresenceRank(event);
  const severity = event.attention?.severity;
  if (!severity) return stateRank;
  // The strongest fact wins. A mission that looks active but whose counters say
  // it has repeated the same tool call seven times outranks one merely waiting.
  return Math.min(stateRank, ATTENTION_RANK[severity] ?? 5);
}

function statePresenceRank(event: RuntimeMissionActivityEvent): number {
  if (NEEDS_YOU.has(event.state)) return 0;
  if (PARKED.has(event.state)) return 1;
  if (event.health === "stalled") return 2;
  if (event.state.startsWith("WAITING_") || event.state.startsWith("RECOVERING_") || event.health === "waiting")
    return 3;
  if (TERMINAL.has(event.state)) return 4;
  return 5;
}

/** ASCII-first row markers; every glyph is one cell wide so columns cannot drift. */
export function presenceMarker(event: RuntimeMissionActivityEvent): string {
  if (NEEDS_YOU.has(event.state)) return "!";
  if (PARKED.has(event.state)) return "#";
  if (event.state === "COMPLETE") return "v";
  if (event.state === "FAILED" || event.state === "CANCELED") return "x";
  if (event.health === "stalled") return "*";
  if (presenceRank(event) === 3) return "~";
  return ">";
}

function progressStamp(event: RuntimeMissionActivityEvent): number {
  const stamp = event.lastMeaningfulProgressAt ? Date.parse(event.lastMeaningfulProgressAt) : Number.NaN;
  return Number.isFinite(stamp) ? stamp : Number.NEGATIVE_INFINITY;
}

/** Total order: attention, then health, then oldest proven progress, then id. */
function comparePresence(a: RuntimeMissionActivityEvent, b: RuntimeMissionActivityEvent): number {
  const rank = presenceRank(a) - presenceRank(b);
  if (rank !== 0) return rank;
  const health = (HEALTH_RANK[a.health] ?? HEALTH_TIE) - (HEALTH_RANK[b.health] ?? HEALTH_TIE);
  if (health !== 0) return health;
  const age = progressStamp(a) - progressStamp(b);
  if (age !== 0) return age;
  return a.missionId.localeCompare(b.missionId);
}

/** Terminal-safe text: a title or sentence from anywhere in the stack may carry secrets. */
function safe(text: string, max: number): string {
  const flat = redactSecrets(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function percentOf(event: RuntimeMissionActivityEvent, basis?: PresenceBasis): string {
  const measured = event.acceptanceCoverage.total > 0 || event.workflowProgress.total > 0;
  if (!measured) return "—";
  return `~${event.approximatePercent}%${basis === "inferred" ? " (inferred)" : ""}`;
}

function unitOf(event: RuntimeMissionActivityEvent): string {
  const coverage = event.acceptanceCoverage;
  if (coverage.total > 0) return `acc ${coverage.completed}/${coverage.total}`;
  return `workers ${event.activeWorkers}a/${event.waitingWorkers}w/${event.failedWorkers}f`;
}

function ageOf(event: RuntimeMissionActivityEvent, now: number): string {
  const stamp = event.lastMeaningfulProgressAt ?? event.lastHeartbeatAt;
  return stamp ? `${missionActivityAge(stamp, now)} ago` : "no proof of life yet";
}

function rowOf(event: RuntimeMissionActivityEvent, now: number, basis?: PresenceBasis): PresenceRow {
  const attention = event.attention;
  return {
    missionId: event.missionId,
    title: safe(event.title, 40),
    marker: presenceMarker(event),
    token: safe(formatMissionActivity(event).missionStatus.token, 24),
    percent: percentOf(event, basis),
    unit: unitOf(event),
    age: ageOf(event, now),
    attention: presenceRank(event) <= 1,
    // Carried so a surface can say *why* without re-deriving it from narration.
    ...(attention && attention.severity !== "info" ? { attentionReason: safe(attention.reason, 80) } : {}),
  };
}

function headerOf(events: readonly RuntimeMissionActivityEvent[]): string {
  const running = events.filter((event) => presenceRank(event) === 5).length;
  const needsYou = events.filter((event) => presenceRank(event) === 0).length;
  const queued = events.filter((event) => QUEUED.has(event.state)).length;
  return `Missions · ${running} running · ${needsYou} needs you${queued > 0 ? ` · ${queued} queued` : ""}`;
}

function workingLineOf(
  rows: readonly PresenceRow[],
  events: readonly RuntimeMissionActivityEvent[],
): { line: string | null; missionId: string | null } {
  const live = events.find((event) => !TERMINAL.has(event.state));
  const row = rows.find((candidate) => candidate.missionId === live?.missionId);
  if (!live || !row) return { line: null, missionId: null };
  // Lead with the evidence when there is any: "why look now" beats "what it is
  // called" for the one line the operator actually reads.
  const head = row.attentionReason ?? row.title;
  const line = `Mission · ${row.missionId} · ${head} · ${row.age} · ${safe(live.phase, 20)} ${row.percent}`;
  return { line: line.length > 240 ? `${line.slice(0, 239)}…` : line, missionId: row.missionId };
}

/** Project live missions into the strip. Pure: no clock, no I/O, no runtime imports. */
export function projectPresence(
  events: readonly RuntimeMissionActivityEvent[],
  budget: number,
  now: number,
  basis?: ReadonlyMap<string, PresenceBasis>,
): PresenceView {
  const sorted = [...events].sort(comparePresence);
  const limit = Math.max(0, budget);
  const shown = sorted.slice(0, limit);
  const hidden = sorted.slice(limit);
  const rows = shown.map((event) => rowOf(event, now, basis?.get(event.missionId)));
  const overflow =
    hidden.length === 0
      ? null
      : `${hidden.length} more · worst ${hidden[0]!.missionId} (${safe(hidden[0]!.title, 30)})`;
  const working = workingLineOf(rows, shown);
  return { header: headerOf(events), rows, overflow, workingLine: working.line, workingMissionId: working.missionId };
}

/** Render the strip: header, one line per mission, then the overflow line. */
export function renderWidgetLines(view: PresenceView): string[] {
  const columns = view.rows.map((row) =>
    [
      `${row.marker} ${row.missionId}`,
      row.title.padEnd(28).slice(0, 28),
      row.token.padEnd(20).slice(0, 20),
      row.percent.padEnd(12),
      row.unit.padEnd(14),
      row.age,
    ].join("  "),
  );
  return [view.header, ...columns, ...(view.overflow ? [view.overflow] : [])];
}

/**
 * A mission the observability service has no state for still belongs in the
 * strip: it shows what the store knows and nothing it does not.
 */
export function storeOnlyEvent(mission: {
  mission_id: string;
  title: string;
  status: MissionStatus;
}): RuntimeMissionActivityEvent {
  return {
    missionId: mission.mission_id,
    title: mission.title,
    phase: mission.status,
    state: mission.status,
    health: "waiting",
    approximatePercent: 0,
    acceptanceCoverage: { completed: 0, total: 0, approximatePercent: 0 },
    workflowProgress: { completed: 0, total: 0, approximatePercent: 0 },
    summary: "",
    activeWorkers: 0,
    waitingWorkers: 0,
    failedWorkers: 0,
    lastMeaningfulProgressAt: null,
    action: "OBSERVE",
    reason: "",
    recovery: { attempt: 0, maxAttempts: 0 },
    nextAction: "",
    nextActionAt: null,
    owner: null,
    repository: null,
    task: null,
    preservedWork: [],
  };
}
