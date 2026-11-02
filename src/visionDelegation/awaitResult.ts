/**
 * Waits for one request's result file. Polls `results/<requestId>.json`,
 * accepts only a file for this request id, and stops on a valid or invalid
 * result, the abort signal, the deadline (`waitSeconds` from when the wait
 * starts), or a pane that is definitely gone. Never throws: an unexpected
 * error becomes an `invalid` outcome. Shows "analyzing image…" meanwhile.
 */

import { readFile } from "node:fs/promises";

import { type VisionRequest, type VisionResult, isRecord, parseResult } from "./protocol.ts";

export type WaitOutcome =
  | { kind: "result"; result: VisionResult }
  | { kind: "invalid"; reason: string }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "pane_dead" };

export interface AwaitResultOptions {
  file: string;
  request: VisionRequest;
  /** True only when the pane is definitely gone; a transient error must answer false. */
  paneGone: () => Promise<boolean>;
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

export async function awaitResult(o: AwaitResultOptions): Promise<WaitOutcome> {
  o.status?.("analyzing image…");
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
  for (let n = 1; ; n++) {
    if (o.signal?.aborted) return { kind: "cancelled" };
    const seen = await check();
    if (seen) return seen;
    // R12: a result written just before the pane exited still counts.
    if (n % PANE_CHECK_EVERY === 0 && (await o.paneGone())) return (await check()) ?? { kind: "pane_dead" };
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
