/**
 * Endpoint circuit (R04): whether an endpoint may be attempted at all — never whether to retry (that is
 * RETRY_OWNERS.md's question) and never a transport. Pure like retryBudget.ts: `nowMs`, `threshold` and
 * `cooldownMs` arrive as data, so no clock, RNG, environment or timer is read, and every transition
 * returns a NEW snapshot over `closed` / `open` / `half_open`. The state names echo the mutable
 * mission-scoped breaker in src/resilience in spirit only; `probeInFlight` is the one probe the open
 * circuit allows, and the cooldown is the endpoint-health error-backoff idea carried in as data.
 */
export type EndpointCircuitState = "closed" | "open" | "half_open";
export type EndpointFailureClass = "model_not_found" | "upstream_failure" | "unhealthy_response";
/** Memory for one endpoint; never mutated in place, each decision carries a fresh one. */
export interface EndpointCircuitSnapshot { state: EndpointCircuitState; endpointId: string; consecutiveFailures: number; openedAtMs: number | null; probeInFlight: boolean; observedAtMs: number }
/** Bound on how many endpoints a caller tracks at once; keys past it are evicted oldest-first. */
export const ENDPOINT_CIRCUIT_MAX_KEYS = 64;
/** One gate check. `threshold` is the consecutive failures that open the circuit; `probeLimit` is 1 because probe memory is a single flag. */
export interface EndpointCircuitInput { snapshot: EndpointCircuitSnapshot; nowMs: number; threshold: number; cooldownMs: number; failure?: EndpointFailureClass | null; success?: boolean; probeLimit?: 1 }
/** The gate answer plus the snapshot to carry to the next call. */
export interface EndpointCircuitDecision { state: EndpointCircuitState; allowAttempt: boolean; probe: boolean; snapshot: EndpointCircuitSnapshot; reason: "closed" | "opening" | "opened" | "cooldown_pending" | "probe_in_flight" | "probe_allowed" | "probe_success" | "probe_failure" | "invalid_input" }

/** Append an endpoint id and, past `max`, drop the oldest keys (FIFO). Pure: returns a new array. */
export function noteEndpointKey(keys: readonly string[], endpointId: string, max: number = ENDPOINT_CIRCUIT_MAX_KEYS): string[] {
  const next = keys.includes(endpointId) ? [...keys] : [...keys, endpointId];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Decide whether this endpoint may be attempted now, and what the circuit remembers afterwards. */
export function evaluateEndpointCircuit(input: EndpointCircuitInput): EndpointCircuitDecision {
  const { snapshot, nowMs, threshold, cooldownMs } = input;
  const known = snapshot.state === "closed" || snapshot.state === "open" || snapshot.state === "half_open";
  if (!Number.isFinite(nowMs) || !Number.isFinite(threshold) || threshold < 1 || !Number.isFinite(cooldownMs) || cooldownMs < 0 || !known) return { state: known ? snapshot.state : "open", allowAttempt: false, probe: false, snapshot, reason: "invalid_input" };
  const seen = (state: EndpointCircuitState, failures: number, openedAtMs: number | null, probeInFlight: boolean, allowAttempt: boolean, probe: boolean, reason: EndpointCircuitDecision["reason"]): EndpointCircuitDecision =>
    ({ state, allowAttempt, probe, reason, snapshot: { state, endpointId: snapshot.endpointId, consecutiveFailures: Math.min(threshold, Math.max(0, failures)), openedAtMs, probeInFlight, observedAtMs: nowMs } });
  const success = input.success === true, failed = input.failure !== undefined && input.failure !== null;
  if (snapshot.state === "open" && snapshot.openedAtMs !== null && nowMs - snapshot.openedAtMs < cooldownMs) return seen("open", threshold, snapshot.openedAtMs, snapshot.probeInFlight, false, false, failed ? "opened" : "cooldown_pending");
  if (snapshot.state === "open" || snapshot.state === "half_open") {
    if (success) return seen("closed", 0, null, false, true, false, "probe_success");
    if (failed) return seen("open", threshold, nowMs, false, false, false, "probe_failure");
    if (snapshot.probeInFlight) return seen("half_open", snapshot.consecutiveFailures, snapshot.openedAtMs, true, false, false, "probe_in_flight");
    return seen("half_open", snapshot.consecutiveFailures, snapshot.openedAtMs ?? nowMs, true, true, true, "probe_allowed");
  }
  if (success) return seen("closed", 0, null, false, true, false, "closed");
  if (failed) return snapshot.consecutiveFailures + 1 >= threshold ? seen("open", threshold, nowMs, false, false, false, "opening") : seen("closed", snapshot.consecutiveFailures + 1, null, false, true, false, "closed");
  return seen("closed", snapshot.consecutiveFailures, null, false, true, false, "closed");
}
