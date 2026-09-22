/**
 * APS Phase 1 — progress evaluation over a bounded action history.
 *
 * `ProgressEvaluator` keeps a bounded (ring) window of `AgentAction`s and
 * derives a `ProgressVector`: how long the tail of the history has been
 * repeating itself with no state change (`noProgressTurns`), which
 * fingerprints repeat (`repeatedCalls`), and how often a tool re-returned the
 * same result it already returned for the same inputs (`staleToolResults`).
 *
 * `classify(action)` records the action and returns a loop-candidate verdict.
 * Detection only: nothing here acts on the verdict.
 */

import { canonicalJson } from "./fingerprint.ts";
import type { AgentAction, LoopVerdict, ProgressThresholds, ProgressVector } from "./types.ts";
import { DEFAULT_PROGRESS_THRESHOLDS } from "./types.ts";

export interface ProgressEvaluatorOptions {
  /** Maximum number of actions kept in the window. Default 50. */
  historySize?: number;
  /** Override any of the default detection thresholds. */
  thresholds?: Partial<ProgressThresholds>;
}

export class ProgressEvaluator {
  private readonly historySize: number;
  private readonly thresholds: ProgressThresholds;
  private history: AgentAction[] = [];

  constructor(options: ProgressEvaluatorOptions = {}) {
    this.historySize = Math.max(2, options.historySize ?? 50);
    this.thresholds = { ...DEFAULT_PROGRESS_THRESHOLDS, ...options.thresholds };
  }

  /** Append an action to the bounded history (oldest evicted first). */
  record(action: AgentAction): void {
    this.history.push(action);
    while (this.history.length > this.historySize) this.history.shift();
  }

  /**
   * Record `action` and classify the updated history.
   *
   * Verdicts:
   *  - `no_progress_turns`  — the trailing run of exactly-repeated actions
   *    (identical fingerprints: same intent + target + no state change)
   *    reached the threshold.
   *  - `repeated_call`      — the latest action's fingerprint has repeated
   *    within the window at least the threshold times.
   *  - `stale_tool_results` — the window holds at least the threshold number
   *    of actions that re-returned an already-seen identical result.
   */
  classify(action: AgentAction): LoopVerdict {
    this.record(action);
    const vector = this.vector();
    if (vector.noProgressTurns >= this.thresholds.noProgressTurns) {
      return { loop_candidate: true, reason: "no_progress_turns" };
    }
    const last = this.history[this.history.length - 1];
    if (last !== undefined) {
      const count = vector.repeatedCalls[last.contentFingerprint];
      if (count !== undefined && count >= this.thresholds.repeatedCalls) {
        return { loop_candidate: true, reason: "repeated_call" };
      }
    }
    if (vector.staleToolResults >= this.thresholds.staleToolResults && this.lastActionIsStale()) {
      return { loop_candidate: true, reason: "stale_tool_results" };
    }
    return { loop_candidate: false };
  }

  /**
   * True when the most recent action re-returned a result that an earlier
   * in-window action already returned for the same (tool, arguments). A loop
   * is only declared on this rule when the LATEST action is itself stale —
   * a fresh action after a stale run is progress, not a loop.
   */
  private lastActionIsStale(): boolean {
    const last = this.history[this.history.length - 1];
    if (last === undefined) return false;
    const lastArgs = canonicalJson(last.normalizedArguments);
    const lastResult = last.toolResultSummary.replace(/\s+/g, " ").trim();
    for (let i = this.history.length - 2; i >= 0; i--) {
      const earlier = this.history[i];
      if (earlier === undefined) continue;
      if (earlier.tool === last.tool && canonicalJson(earlier.normalizedArguments) === lastArgs) {
        return earlier.toolResultSummary.replace(/\s+/g, " ").trim() === lastResult;
      }
    }
    return false;
  }

  /** Progress metrics over the current bounded window. */
  vector(): ProgressVector {
    const n = this.history.length;

    let noProgressTurns = 0;
    for (let i = n - 1; i > 0; i--) {
      const current = this.history[i];
      const previous = this.history[i - 1];
      if (
        current !== undefined &&
        previous !== undefined &&
        current.contentFingerprint === previous.contentFingerprint
      ) {
        noProgressTurns += 1;
      } else {
        break;
      }
    }

    const counts = new Map<string, number>();
    const lastResultByKey = new Map<string, string>();
    let staleToolResults = 0;
    for (const action of this.history) {
      counts.set(action.contentFingerprint, (counts.get(action.contentFingerprint) ?? 0) + 1);
      const key = `${action.tool} ${canonicalJson(action.normalizedArguments)}`;
      const result = action.toolResultSummary.replace(/\s+/g, " ").trim();
      const previous = lastResultByKey.get(key);
      if (previous !== undefined && previous === result) staleToolResults += 1;
      lastResultByKey.set(key, result);
    }

    const repeatedCalls: Record<string, number> = {};
    for (const [fingerprint, count] of counts) {
      if (count >= 2) repeatedCalls[fingerprint] = count;
    }

    return {
      totalActions: n,
      noProgressTurns,
      repeatedCalls,
      staleToolResults,
      lastFingerprint: n > 0 ? (this.history[n - 1]?.contentFingerprint ?? null) : null,
    };
  }

  /** Number of actions currently retained. */
  get size(): number {
    return this.history.length;
  }
}
