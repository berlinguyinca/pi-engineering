/**
 * The invocation identity of the model call in flight (fault-tolerance spec
 * §21/§23).
 *
 * The resilient layer is installed ONCE per `ModelRuntime`, but a runtime
 * serves many roles concurrently — a planner turn, an implementer session, a
 * vision review, a background compaction summary. Each provider call still has
 * to know WHO it belongs to, because that identity decides:
 *
 *   * the capability envelope a fallback must satisfy (the router role),
 *   * whether interactive or worker fallback policy applies (§21),
 *   * the correlation fields on every telemetry event (mission, worker, role).
 *
 * AsyncLocalStorage is what keeps that identity correct under concurrent
 * workers instead of a mutable "current role" field that the last session to
 * start would win. A call with no context (a bare script, a helper that never
 * opted in) keeps the installer's defaults and is still fully classified.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutedActionTracker } from "./recovery.ts";

export interface InferenceInvocation {
  /** Worker/router role of the invocation ("implementer", "planner", ...). */
  role: string;
  missionId?: string;
  workerId?: string;
  /** Interactive turns keep their own fallback policy (opt-in, spec §21). */
  interactive?: boolean;
  /**
   * The tracker of the tool calls THIS invocation already executed (spec §6).
   * Per invocation because a retried worker session must list — never replay —
   * the edits/commits of the generation that was cut.
   */
  actions?: ExecutedActionTracker;
  /** Output cap that keeps prompt budget + max_tokens inside the model's slot (issue #180). */
  maxOutputTokens?: number;
  /**
   * True when this invocation is being driven by the unified resilient
   * runtime layer (spec: one canonical retry authority). Admission observes
   * (saturation + gate) but must not add a second retry loop when set.
   */
  resilient?: boolean;
}

const storage = new AsyncLocalStorage<InferenceInvocation>();

/** The invocation the current async chain belongs to, when one is active. */
export function currentInferenceInvocation(): InferenceInvocation | undefined {
  return storage.getStore();
}

/** Run `fn` as one logical inference invocation (its provider calls inherit it). */
export function runWithInferenceInvocation<T>(invocation: InferenceInvocation, fn: () => T): T {
  return storage.run(invocation, fn);
}
