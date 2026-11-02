/**
 * Waits for one request's result file. Polls `results/<requestId>.json`,
 * accepts only a file for this request id, and stops on a valid or invalid
 * result, the abort signal, the deadline (`waitSeconds` from when the wait
 * starts), a pane that is definitely gone, or (R26) a vision agent that has
 * sat idle without writing a result. Never throws: an unexpected error becomes
 * an `invalid` outcome. Shows "analyzing image (up to <waitSeconds>s)…" meanwhile.
 *
 * The wait starts right after delivery, so "since delivery" is "since the wait began".
 */

import { readFile } from "node:fs/promises";

import { type VisionRequest, type VisionResult, isRecord, parseResult } from "./protocol.ts";

export type WaitOutcome =
  | { kind: "result"; result: VisionResult }
  | { kind: "invalid"; reason: string }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "pane_dead" }
  /** R26: the agent sat idle (or done) without writing a result. */
  | { kind: "stopped" };

/**
 * One pane check's verdict: `gone` only when the agent is definitely gone; `stopped` when herdr reports it
 * `idle` or `done`; `busy` for any other status; `unknown` when herdr could not answer (a transient error,
 * ignored: it neither counts toward nor breaks an idle streak).
 */
export type AgentState = "gone" | "stopped" | "busy" | "unknown";

export interface AwaitResultOptions {
  file: string;
  request: VisionRequest;
  /** Asked every `PANE_CHECK_EVERY` polls. Must not throw; a transient error answers `unknown`. */
  agentState: () => Promise<AgentState>;
  waitSeconds: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Must not throw. */
  status?: (text: string | undefined) => void;
}

const POLL_MS = 500;
/** Every Nth poll asks whether the vision pane still exists. */
const PANE_CHECK_EVERY = 5;
/** R26: this many consecutive pane checks must report the agent idle or done... */
export const STOPPED_CHECKS = 4;
/** ...and at least this long must have passed since delivery, before the wait ends as "stopped". */
export const STOPPED_MIN_MS = 30_000;

export async function awaitResult(o: AwaitResultOptions): Promise<WaitOutcome> {
  o.status?.(`analyzing image (up to ${o.waitSeconds}s)…`);
  try {
    return await poll(o);
  } catch (err) {
    return { kind: "invalid", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    o.status?.(undefined);
  }
}

async function poll(o: AwaitResultOptions): Promise<WaitOutcome> {
  const deadline = o.now() + o.waitSeconds * 1000;
  // Missing, half-written, unparseable, or for another request: undefined, keep waiting.
  const check = async (): Promise<WaitOutcome | undefined> => {
    const seen = await readResult(o.file);
    if (seen === undefined || !isRecord(seen) || seen.request_id !== o.request.requestId) return undefined;
    const parsed = parseResult(seen, o.request);
    return parsed.ok ? { kind: "result", result: parsed.result } : { kind: "invalid", reason: parsed.reason };
  };
  const started = o.now();
  let idleStreak = 0;
  for (let n = 1; ; n++) {
    if (o.signal?.aborted) return { kind: "cancelled" };
    const seen = await check();
    if (seen) return seen;
    if (n % PANE_CHECK_EVERY === 0) {
      const agent = await o.agentState();
      // R12: a result written just before the pane exited (or went idle) still counts.
      if (agent === "gone") return (await check()) ?? { kind: "pane_dead" };
      if (agent === "stopped") idleStreak += 1;
      else if (agent === "busy") idleStreak = 0;
      if (idleStreak >= STOPPED_CHECKS && o.now() - started >= STOPPED_MIN_MS) {
        return (await check()) ?? { kind: "stopped" };
      }
    }
    if (o.now() >= deadline) return { kind: "timeout" };
    await o.sleep(POLL_MS);
  }
}

async function readResult(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}
