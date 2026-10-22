#!/usr/bin/env node
/**
 * Read-only weekly report on how well Pi sessions survive inference failures.
 *
 *   node scripts/pi-session-report.ts [--dir ~/.pi/agent/sessions] [--since YYYY-MM-DD] [--json]
 *
 * The number to watch is `stalls resumed by a person`: failures that sat until
 * the operator typed "retry". It was the common case before in-session settle
 * recovery and the restart launcher, and should fall towards zero once both are
 * deployed. Nothing here writes to a session.
 *
 * A "stall" is an error followed by 10 minutes of silence. "Automatic" counts
 * a next event that is not a person, which includes the gateway wrapper
 * holding a request for a long time, not only a revival.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hasVisibleOutput } from "../src/gateway/afterOutputRetry.ts";
import { SESSION_RECOVERY_MARKER } from "../src/gateway/sessionAutoResume.ts";
import { recoverableFailure } from "../src/gateway/settleRecovery.ts";

/** An error followed by silence this long counts as a stall. */
export const STALL_GAP_MS = 10 * 60_000;
/** Pi's retry budget is three; a run of four consecutive errors means it was spent. */
export const EXHAUSTED_RUN = 4;
/** The error Pi shows when a response stream closes without a terminal frame. */
const STREAM_CUT = /finish_reason/;
/** A pre-output cut this long after its request fits a 30 s freshness or 60 s idle bound somewhere on the path. */
export const IDLE_BOUND_MIN_MS = 25_000;
export const IDLE_BOUND_MAX_MS = 70_000;
/** Recovery slower than this means a person, not Pi's retries, got the session going again. */
export const SLOW_RECOVERY_MS = 30 * 60_000;
/** A short message that only asks the agent to try again. */
const HUMAN_RETRY = /^\s*(please\s+)?(re-?try|try again|continue|go on)\b[^\n]{0,40}$/i;

export interface WeekStats {
  week: string;
  sessions: number;
  errors: number;
  recoverableBeforeOutput: number;
  afterOutput: number;
  final: number;
  exhaustedRuns: number;
  stalls: number;
  stallsResumedByPerson: number;
  stallsResumedAutomatically: number;
  stallsUnresumed: number;
  humanRetryMessages: number;
  automaticRecoveryPrompts: number;
  /** Responses that ended without a terminal frame ("Stream ended without finish_reason"). */
  cuts: number;
  cutsBeforeOutput: number;
  /** Before any output, after 25-70 s: the signature of an idle or freshness bound. */
  cutsNearIdleBound: number;
  /** No good turn followed within 30 minutes (or ever). */
  cutsSlowRecovery: number;
  cutsByProvider: Record<string, number>;
}

interface Event {
  at: number;
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  content?: unknown;
  text: string;
}

function mondayOf(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
    .join(" ");
}

export function parseSession(raw: string): Event[] {
  const events: Event[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o: { type?: string; timestamp?: string; message?: Record<string, unknown> };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "message" || !o.message) continue;
    const at = Date.parse(o.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    const m = o.message;
    events.push({
      at,
      role: m.role as string,
      stopReason: m.stopReason as string | undefined,
      errorMessage: m.errorMessage as string | undefined,
      provider: typeof m.provider === "string" ? m.provider : undefined,
      content: m.content,
      text: textOf(m.content),
    });
  }
  return events;
}

const isAutomaticPrompt = (e: Event) => e.role === "user" && e.text.includes(SESSION_RECOVERY_MARKER);

const blank = (week: string): WeekStats => ({
  week,
  sessions: 0,
  errors: 0,
  recoverableBeforeOutput: 0,
  afterOutput: 0,
  final: 0,
  exhaustedRuns: 0,
  stalls: 0,
  stallsResumedByPerson: 0,
  stallsResumedAutomatically: 0,
  stallsUnresumed: 0,
  humanRetryMessages: 0,
  automaticRecoveryPrompts: 0,
  cuts: 0,
  cutsBeforeOutput: 0,
  cutsNearIdleBound: 0,
  cutsSlowRecovery: 0,
  cutsByProvider: {},
});

/** Classify one "ended without finish_reason" turn: where it was cut, and how long recovery took. */
function countCut(w: WeekStats, events: Event[], i: number): void {
  const e = events[i]!;
  w.cuts++;
  const provider = e.provider ?? "unknown";
  w.cutsByProvider[provider] = (w.cutsByProvider[provider] ?? 0) + 1;
  if (!hasVisibleOutput(e as never)) {
    w.cutsBeforeOutput++;
    const ran = i > 0 ? e.at - events[i - 1]!.at : Number.NaN;
    if (ran >= IDLE_BOUND_MIN_MS && ran <= IDLE_BOUND_MAX_MS) w.cutsNearIdleBound++;
  }
  const good = events.slice(i + 1).find((n) => n.role === "assistant" && n.stopReason !== "error");
  if (!good || good.at - e.at > SLOW_RECOVERY_MS) w.cutsSlowRecovery++;
}

export function accumulate(weeks: Map<string, WeekStats>, events: Event[], nowMs = Date.now()): void {
  const touched = new Set<string>();
  const stats = (at: number) => {
    const week = mondayOf(at);
    const existing = weeks.get(week);
    const w = existing ?? blank(week);
    if (!existing) weeks.set(week, w);
    touched.add(week);
    return w;
  };
  let run = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const w = stats(e.at);
    if (e.role === "user") {
      // Pi's retry budget starts over with every new request.
      run = 0;
      if (isAutomaticPrompt(e)) w.automaticRecoveryPrompts++;
      else if (HUMAN_RETRY.test(e.text)) w.humanRetryMessages++;
    }
    if (e.role !== "assistant") continue;
    if (e.stopReason !== "error") {
      run = 0;
      continue;
    }
    // A long silence ends the streak as well: Pi's budget is per request.
    if (i > 0 && e.at - events[i - 1]!.at >= STALL_GAP_MS) run = 0;
    w.errors++;
    run++;
    if (run === EXHAUSTED_RUN) w.exhaustedRuns++;
    if (STREAM_CUT.test(e.errorMessage ?? "")) countCut(w, events, i);
    let final = false;
    if (hasVisibleOutput(e as never)) w.afterOutput++;
    else if (recoverableFailure(e as never)) w.recoverableBeforeOutput++;
    else {
      w.final++;
      final = true;
    }

    // A refusal that waiting cannot fix is not a stall: nothing was waiting to be recovered.
    if (final) continue;
    const next = events[i + 1];
    if (next ? next.at - e.at < STALL_GAP_MS : nowMs - e.at < STALL_GAP_MS) continue;
    w.stalls++;
    if (!next) w.stallsUnresumed++;
    else if (next.role === "user" && !isAutomaticPrompt(next)) w.stallsResumedByPerson++;
    else w.stallsResumedAutomatically++;
  }
  for (const week of touched) weeks.get(week)!.sessions++;
}

function* sessionFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    try {
      if (statSync(path).isDirectory()) yield* sessionFiles(path);
      else if (entry.endsWith(".jsonl")) yield path;
    } catch {
      // A broken symlink or a file that vanished must not abort the whole report.
    }
  }
}

export function buildReport(dir: string, since?: string): WeekStats[] {
  const weeks = new Map<string, WeekStats>();
  for (const file of sessionFiles(dir)) accumulate(weeks, parseSession(readFileSync(file, "utf8")));
  return [...weeks.values()].filter((w) => !since || w.week >= since).sort((a, b) => a.week.localeCompare(b.week));
}

export function renderTable(rows: WeekStats[]): string {
  const cols: Array<[string, (w: WeekStats) => number | string]> = [
    ["week of", (w) => w.week],
    ["sessions", (w) => w.sessions],
    ["errors", (w) => w.errors],
    ["recoverable", (w) => w.recoverableBeforeOutput],
    ["after output", (w) => w.afterOutput],
    ["final", (w) => w.final],
    ["budget spent", (w) => w.exhaustedRuns],
    ["stalls", (w) => w.stalls],
    ["by person", (w) => w.stallsResumedByPerson],
    ["automatic", (w) => w.stallsResumedAutomatically],
    ["unresumed", (w) => w.stallsUnresumed],
    ["'retry' msgs", (w) => w.humanRetryMessages],
    ["auto prompts", (w) => w.automaticRecoveryPrompts],
  ];
  const head = `| ${cols.map(([n]) => n).join(" | ")} |`;
  const rule = `|${cols.map(() => "---").join("|")}|`;
  const body = rows.map((w) => `| ${cols.map(([, f]) => f(w)).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

export function renderCuts(rows: WeekStats[]): string {
  const cols: Array<[string, (w: WeekStats) => number | string]> = [
    ["week of", (w) => w.week],
    ["cuts", (w) => w.cuts],
    ["before output", (w) => w.cutsBeforeOutput],
    ["25-70s silent", (w) => w.cutsNearIdleBound],
    ["slow recovery", (w) => w.cutsSlowRecovery],
    [
      "by provider",
      (w) =>
        Object.entries(w.cutsByProvider)
          .sort((a, b) => b[1] - a[1])
          .map(([p, n]) => `${p}:${n}`)
          .join(" ") || "-",
    ],
  ];
  const head = `| ${cols.map(([n]) => n).join(" | ")} |`;
  const rule = `|${cols.map(() => "---").join("|")}|`;
  const body = rows.map((w) => `| ${cols.map(([, f]) => f(w)).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

function main(argv: string[]): void {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = get("--dir") ?? join(homedir(), ".pi", "agent", "sessions");
  const rows = buildReport(dir, get("--since"));
  process.stdout.write(
    argv.includes("--json")
      ? `${JSON.stringify(rows, null, 2)}\n`
      : `${renderTable(rows)}\n\nStream cuts (responses that ended without finish_reason)\n${renderCuts(rows)}\n`,
  );
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) main(process.argv.slice(2));
