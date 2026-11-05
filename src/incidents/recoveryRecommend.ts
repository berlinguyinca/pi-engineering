/**
 * Recovery recommendation (R06): one read-only answer — retry | hold | failover | stop | review — composed from the retry budget (R03), the endpoint circuit
 * (R04) and replay safety (R05) over the failureClassifier class. It is neither recovery proof (recoveryOutcome.ts answers what happened) nor the ladder step
 * for a class (InferenceFailureAction): it answers what recovery should do given budget, circuit and replay-safety state, and executes, schedules, logs or
 * mutates nothing (`nowMs` is data: no clock, RNG, timer, env or file). Order: invalid_input > permanent_class > unclassified > server-wait hold (the larger of
 * `retry_after_ms` and the budget wait, stopping when R03 stops) > circuit (fail over when the gate blocks and a switch exists, else stop with the gate's own
 * reason — no_probe_slot for a taken probe, circuit_open for a blocked endpoint; the gate is asked at RECOVERY_CIRCUIT_COOLDOWN_MS because this unit owns no
 * cooldown policy and never takes the one probe for a caller) > not_replayable review > budget retry/stop. PERMANENT_CLASSES are refusals no further attempt can
 * fix: `model_not_found` is the 404 whose retry counts are granted twice today (RETRY_OWNERS.md conflict 4), and because this unit never adds a retry grant a
 * 404 stops even at attempt 1 of maxAttempts 5.
 */
import type { InferenceFailureClass } from "../inference/failureClassifier.ts";
import { type EndpointCircuitSnapshot, evaluateEndpointCircuit } from "../inference/endpointCircuit.ts";
import { type RetryBudgetInput, evaluateRetryBudget } from "../inference/retryBudget.ts";
import { type ToolAction, classifyReplaySafety } from "../inference/recoverySafety.ts";
export type RecoveryRecommendation = "retry" | "hold" | "failover" | "stop" | "review";
export interface RecoveryRecommendInput { failure?: { class: InferenceFailureClass; retryAfterMs?: number }; budget?: RetryBudgetInput; circuit?: EndpointCircuitSnapshot; action?: ToolAction; nowMs: number; switchAvailable?: boolean }
export interface RecoveryRecommendResult { recommendation: RecoveryRecommendation; reason: "permanent_class" | "budget_exhausted" | "server_wait" | "circuit_open" | "no_probe_slot" | "not_replayable" | "unclassified" | "within_budget" | "invalid_input"; waitMs: number | null; source: "retryBudget" | "endpointCircuit" | "recoverySafety" | "class" | "input" }
export const PERMANENT_CLASSES: ReadonlySet<InferenceFailureClass> = new Set<InferenceFailureClass>(["authentication", "authorization", "billing", "invalid_request", "model_not_found", "request_too_large"]);
/** Validation mirror only: this Record fails the build if failureClassifier.ts drifts, and classification stays there. */
const KNOWN: Record<InferenceFailureClass, true> = { incomplete_stream: true, rate_limited: true, queue_saturated: true, capacity_unavailable: true, model_activating: true, model_unavailable: true, no_workers: true, worker_evicted: true, worker_restarting: true, gateway_unavailable: true, network_interruption: true, routing_stale: true, model_not_found: true, context_overflow: true, request_too_large: true, authentication: true, authorization: true, quota: true, billing: true, invalid_request: true, unknown: true };
const SERVER_WAIT: ReadonlySet<InferenceFailureClass> = new Set<InferenceFailureClass>(["rate_limited", "queue_saturated", "model_activating"]);
const NO_GRANT: RetryBudgetInput = { maxAttempts: 1, attempt: 1, elapsedMs: 0, baseBackoffMs: 0 };
export const RECOVERY_CIRCUIT_COOLDOWN_MS = 60_000;
const stopped = (reason: RecoveryRecommendResult["reason"], source: RecoveryRecommendResult["source"]): RecoveryRecommendResult => ({ recommendation: "stop", reason, waitMs: null, source });
const blocked = (reason: RecoveryRecommendResult["reason"], recommendation: RecoveryRecommendation): RecoveryRecommendResult => ({ recommendation, reason, waitMs: null, source: "endpointCircuit" });
/** Recommend what recovery should do next; the recommendation is the whole output — nothing is executed. */
export function recommendRecovery(input: RecoveryRecommendInput): RecoveryRecommendResult {
  const failure = input?.failure;
  if (failure === null || typeof failure !== "object" || !Number.isFinite(input?.nowMs ?? Number.NaN) || typeof failure.class !== "string" || !Object.hasOwn(KNOWN, failure.class)) return stopped("invalid_input", "input");
  if (PERMANENT_CLASSES.has(failure.class)) return stopped("permanent_class", "class");
  if (failure.class === "unknown") return stopped("unclassified", "class");
  const advertised = [failure.retryAfterMs, input.budget?.retryAfterMs].filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms >= 0);
  const budget: RetryBudgetInput = { ...NO_GRANT, ...input.budget, ...(advertised.length > 0 ? { retryAfterMs: Math.max(...advertised) } : {}) };
  if (SERVER_WAIT.has(failure.class)) {
    const priced = evaluateRetryBudget(budget);
    return priced.action === "stop" ? stopped("budget_exhausted", "retryBudget") : { recommendation: "hold", reason: advertised.length > 0 ? "server_wait" : "within_budget", waitMs: priced.waitMs, source: "retryBudget" };
  }
  if (input.circuit !== undefined) {
    const gate = evaluateEndpointCircuit({ snapshot: input.circuit, nowMs: input.nowMs, threshold: Math.max(1, input.circuit.consecutiveFailures), cooldownMs: RECOVERY_CIRCUIT_COOLDOWN_MS });
    if (!gate.allowAttempt && input.switchAvailable === true) return blocked("circuit_open", "failover");
    if (!gate.allowAttempt) return blocked(gate.reason === "probe_in_flight" ? "no_probe_slot" : "circuit_open", "stop");
  }
  if (input.action !== undefined && classifyReplaySafety(input.action).replayAllowed !== true) return { recommendation: "review", reason: "not_replayable", waitMs: null, source: "recoverySafety" };
  const granted = evaluateRetryBudget(budget);
  return granted.action === "retry" ? { recommendation: "retry", reason: "within_budget", waitMs: granted.waitMs, source: "retryBudget" } : stopped("budget_exhausted", "retryBudget");
}
