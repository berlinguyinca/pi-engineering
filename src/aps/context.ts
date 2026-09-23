/**
 * APS Phase 2 — context-utilization helper (observability only).
 *
 * Computes how much of the session's configured context budget is consumed,
 * as a number in [0, 1], from the usage data the provider reports. The value
 * is an EVENT FIELD for the `agent.loop_candidate` event (and dashboards that
 * may consume it later); it has no control effect here — APS is detect-only.
 */

/**
 * Compute context utilization as input tokens vs the configured
 * `max_context_tokens`, clamped to [0, 1].
 *
 * Returns `null` (rather than a guess) when the data is not available: no
 * usable token count, or no positive configured budget.
 *
 * @param inputTokens  Input tokens of the latest assistant turn (the context
 *                     actually sent to the model). Falls back to
 *                     `totalTokens` when the provider did not report `input`.
 * @param maxContextTokens  Configured context budget in tokens (e.g.
 *                     `WorkerRequest.maxContextTokens`).
 */
export function contextUtilization(
  inputTokens: number | null | undefined,
  maxContextTokens: number | null | undefined,
): number | null {
  if (!isFiniteNumber(inputTokens) || !isFiniteNumber(maxContextTokens) || (maxContextTokens as number) <= 0) {
    return null;
  }
  const ratio = (inputTokens as number) / (maxContextTokens as number);
  return Math.min(1, Math.max(0, ratio));
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
