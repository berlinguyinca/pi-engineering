import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Test progress watchdog (autospec R-WATCH, issue #146).
 *
 * Tells a test stage that is progressing from one that is quiet or stalled.
 * Progress is a test start/finish line, new output, I/O growth in the stage's
 * process group, or a change in that group's child processes. Heartbeats and CPU
 * time are NOT progress: a process spinning in a loop is exactly what this must
 * catch. Silence is measured from the last progress: warn (quiet) at 2 min,
 * investigate at 5, stalled at 10.
 *
 * The classification is pure and takes an explicit clock, in the style of
 * `src/resilience/watchdog.ts`. Acting on it (capturing evidence, signalling the
 * Verifier-spawned process group) happens in `runWithInactivityGuard`, whose
 * 15 minute no-output guard stays as the backstop.
 *
 * `wallMs` (30 min by default here) is a total-duration limit and is applied
 * only when a stage opts in with an explicit value: missions are not bound by
 * fixed wall-clock windows (docs/mission-time-limits.md), so no stage is cut off
 * for running long while it keeps making progress.
 */

export interface TestWatchdogConfig {
  /** Silence after which the stage is `quiet`. */
  warnMs: number;
  /** Silence after which the stage is `investigate`. */
  investigateMs: number;
  /** Silence after which the stage is `stalled`. */
  stallMs: number;
  /** Total-duration limit; only enforced when set explicitly on the stage. */
  wallMs?: number | undefined;
}

export const DEFAULT_TEST_WATCHDOG: Readonly<TestWatchdogConfig> = {
  warnMs: 120_000,
  investigateMs: 300_000,
  stallMs: 600_000,
  wallMs: 1_800_000,
};

/** Per-stage settings: any threshold may be overridden; `sampleMs` is how often the group is sampled. */
export interface WatchdogSettings extends Partial<TestWatchdogConfig> {
  sampleMs?: number;
}

export const DEFAULT_SAMPLE_MS = 5_000;

/** What counted as progress (mirrors the protocol event's `progress_kind`). */
export type ProgressKind = "test_event" | "output" | "io" | "children";

/** One reading of the stage. Counters are cumulative; `cpuMs` is accepted and ignored. */
export interface ProgressSample {
  outputBytes: number;
  testEvents: number;
  ioBytes: number;
  /** Signature of the live child set (see {@link childSignature}). */
  children: string;
  cpuMs?: number;
}

export interface TestWatchdogState {
  startedAtMs: number;
  /** Protocol name: `last_progress_at`. */
  lastProgressAtMs: number;
  /** Protocol name: `progress_kind`; null before any progress. */
  lastProgressKind: ProgressKind | null;
  last: ProgressSample | null;
}

export type WatchdogLevel = "progressing" | "quiet" | "investigate" | "stalled";

export function initialWatchdogState(nowMs: number): TestWatchdogState {
  return { startedAtMs: nowMs, lastProgressAtMs: nowMs, lastProgressKind: null, last: null };
}

/**
 * Fold a sample in. The first sample is only a baseline. A counter that moves
 * backwards (a restarted child) is not progress.
 */
export function observe(state: TestWatchdogState, sample: ProgressSample, nowMs: number): TestWatchdogState {
  const prev = state.last;
  if (!prev) return { ...state, last: sample };
  let kind: ProgressKind | null = null;
  if (sample.testEvents > prev.testEvents) kind = "test_event";
  else if (sample.outputBytes > prev.outputBytes) kind = "output";
  else if (sample.ioBytes > prev.ioBytes) kind = "io";
  else if (sample.children !== prev.children) kind = "children";
  if (kind === null) return { ...state, last: sample };
  return { ...state, last: sample, lastProgressAtMs: nowMs, lastProgressKind: kind };
}

export function classify(state: TestWatchdogState, nowMs: number, cfg: TestWatchdogConfig): WatchdogLevel {
  const silent = nowMs - state.lastProgressAtMs;
  if (silent >= cfg.stallMs) return "stalled";
  if (silent >= cfg.investigateMs) return "investigate";
  if (silent >= cfg.warnMs) return "quiet";
  return "progressing";
}

/** True only when a wall limit is configured and the stage has run that long. */
export function isWallExceeded(state: TestWatchdogState, nowMs: number, cfg: TestWatchdogConfig): boolean {
  return cfg.wallMs !== undefined && nowMs - state.startedAtMs >= cfg.wallMs;
}

const TEST_EVENT_LINE =
  /^(?:\s*(?:# Subtest:|ok \d+|not ok \d+)|test \S.* \.\.\. \S+|\S+::\S+ (?:PASSED|FAILED|SKIPPED|ERROR)|(?:--- )?(?:PASS|FAIL|RUN)[: ] ?\S+)/;

/** Test start/finish lines in a chunk of runner output (node:test, cargo, pytest, go test). */
export function countTestEvents(chunk: string): number {
  let count = 0;
  for (const line of chunk.split("\n")) if (TEST_EVENT_LINE.test(line)) count++;
  return count;
}

/** The thresholds a stage runs under, or undefined for no watchdog. */
export function resolveStageWatchdog(stage: {
  name: string;
  watchdog?: false | WatchdogSettings | undefined;
}): (TestWatchdogConfig & { sampleMs: number }) | undefined {
  if (stage.watchdog === false) return undefined;
  const isTestStage = stage.name === "test" || stage.name.startsWith("test:");
  if (!isTestStage && stage.watchdog === undefined) return undefined;
  // The default wall limit is NOT inherited: a wall is an explicit opt-in.
  const { wallMs: _defaultWall, ...thresholds } = DEFAULT_TEST_WATCHDOG;
  const merged = { ...thresholds, ...stage.watchdog };
  return { ...merged, sampleMs: stage.watchdog?.sampleMs ?? DEFAULT_SAMPLE_MS };
}

// --- process-group sampling and evidence ------------------------------------

export interface GroupProcess {
  pid: number;
  ppid: number;
  /** `ps` state, e.g. `S`, `R`, `Z`. */
  state: string;
  /** Start time as `ps` reports it: with the pid, identifies this exact process. */
  started: string;
  command: string;
}

/**
 * Every process in a process group (zombies included, flagged by state).
 * Null when `ps` is unavailable.
 */
export function listProcessGroup(pgid: number): GroupProcess[] | null {
  try {
    const listing = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart=,args="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    const members: GroupProcess[] = [];
    for (const line of listing.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (Number(parts[2]) !== pgid) continue;
      members.push({
        pid: Number(parts[0]),
        ppid: Number(parts[1]),
        state: parts[3] ?? "",
        started: parts.slice(4, 9).join(" "),
        command: parts.slice(9).join(" "),
      });
    }
    return members;
  } catch {
    return null;
  }
}

/** Signature of the live child set: changes when a process starts or exits. */
export function childSignature(members: GroupProcess[]): string {
  return members
    .filter((m) => !m.state.startsWith("Z"))
    .map((m) => `${m.pid}:${m.started}`)
    .sort()
    .join(",");
}

/** Bytes read plus written by a process (`/proc/<pid>/io`); 0 where unreadable or not Linux. */
function processIoBytes(pid: number): number {
  try {
    const text = readFileSync(`/proc/${pid}/io`, "utf8");
    const field = (name: string): number => Number(text.match(new RegExp(`^${name}: (\\d+)`, "m"))?.[1] ?? 0);
    return field("rchar") + field("wchar");
  } catch {
    return 0;
  }
}

/** One reading of the stage's process group, with the caller's output counters. */
export function sampleGroup(pgid: number, outputBytes: number, testEvents: number): ProgressSample {
  const members = listProcessGroup(pgid) ?? [];
  return {
    outputBytes,
    testEvents,
    ioBytes: members.reduce((sum, m) => sum + processIoBytes(m.pid), 0),
    children: childSignature(members),
  };
}

export interface StallEvidence {
  pgid: number;
  capturedAt: string;
  /** The process tree at the moment of capture (before any signal). */
  processes: GroupProcess[];
  /** The last output lines (50). */
  lastLines: string[];
}

export const EVIDENCE_TAIL_LINES = 50;

export function captureEvidenceSync(pgid: number, output = "", tailLines = EVIDENCE_TAIL_LINES): StallEvidence {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return {
    pgid,
    capturedAt: new Date().toISOString(),
    processes: listProcessGroup(pgid) ?? [],
    lastLines: lines.slice(-tailLines),
  };
}

export async function captureEvidence(
  pgid: number,
  output = "",
  tailLines = EVIDENCE_TAIL_LINES,
): Promise<StallEvidence> {
  return captureEvidenceSync(pgid, output, tailLines);
}
