/**
 * What `/gateway` shows.
 *
 * The admission controller already knows everything worth knowing — how many
 * slots are in flight, how far the concurrency limit has been clamped, how long
 * the cooldown has left, and what the gateway last said. None of it was
 * reachable from the session, so "why has this been sitting here for ninety
 * seconds?" had no answer short of reading stderr telemetry.
 *
 * The two facts operators actually need are the ones a spinner cannot carry:
 * the queue POSITION (30th of 100 is a wait; 3rd of 100 is a hiccup) and the
 * concurrency CLAMP, which is invisible by construction — when the gateway
 * reports `active_limit`, the runtime quietly shrinks its own parallelism, and
 * a run that suddenly went serial looks identical to one that got slow.
 *
 * Pure: formatting only, so the command handler is a printer and this is
 * testable without a session.
 */

import type { AdmissionStatus } from "./AdmissionController.ts";

export interface GatewayReportConfig {
  enabled: boolean;
  maxConcurrency: number;
  reservedSlots: number;
  maxWaitMs: number;
  maxRetries: number;
  maxElapsedMs?: number;
}

export interface GatewayReportInput {
  status: AdmissionStatus;
  config: GatewayReportConfig;
  /** `provider:api` pairs whose transport is wrapped for bounded waiting. */
  installs: readonly string[];
  /** The session's model, when one is resolved. */
  model?: { id: string; provider: string; api: string; contextWindow: number } | undefined;
  /** Context tokens in use; `null` when Pi does not know (just after compaction). */
  contextTokens?: number | null;
  /**
   * Gateway-reported per-model readiness, when available. This is what actually
   * explains a `503 no worker for model`: the refusing model is the one with no
   * free slots, and no retry counter can show that.
   */
  health?: ReadonlyMap<string, { state?: string; slots?: number }>;
  /** Whether those readings are current, so a stale view is not read as live. */
  healthFresh?: boolean;
}

function seconds(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s >= 10 ? `${Math.round(s)}s` : `${Math.round(s * 10) / 10}s`;
}

function limit(value: number): string {
  return Number.isFinite(value) ? String(value) : "unlimited";
}

/** Render the report as lines. Never throws; every field is optional upstream. */
export function renderGatewayReport(input: GatewayReportInput): string[] {
  const { status, config } = input;
  const lines: string[] = [];

  if (!config.enabled) {
    return [
      "Gateway admission control is disabled (PI_GATEWAY_ADMISSION_ENABLED=0).",
      "Waits are Pi's own, and bounded.",
    ];
  }

  lines.push(
    status.cooldownMs > 0
      ? `Holding — ${seconds(status.cooldownMs)} left on the shared cooldown.`
      : "Open — no cooldown in effect.",
  );

  // The clamp is the invisible one: a run that silently went serial reads as
  // "slow" unless the number is on screen next to what it started from.
  //
  // Compared against `baseConcurrency`, NOT the configured maximum: the
  // unclamped limit is already `maxConcurrency - reservedSlots`, so comparing
  // against the maximum reports a clamp on every healthy session and makes the
  // one signal this line exists for worthless.
  const clamped = status.concurrency < status.baseConcurrency;
  const clampNote = clamped ? ` (clamped down from ${status.baseConcurrency} by the gateway)` : "";
  const reserveNote = config.reservedSlots > 0 ? `, ${config.reservedSlots} reserved for your turn` : "";
  lines.push(
    `Slots: ${status.active} active, ${status.waiting} waiting, limit ${status.concurrency}${clampNote}${reserveNote}`,
  );

  const signal = status.lastSignal;
  if (signal) {
    const parts: string[] = [`last refusal: ${signal.status ?? "?"}`];
    if (signal.reason) parts.push(signal.reason);
    if (signal.queued != null) {
      parts.push(`position ${signal.queued}${signal.queueLimit != null ? `/${signal.queueLimit}` : ""} in the queue`);
    }
    if (signal.activeLimit != null) parts.push(`gateway admits ${signal.activeLimit} at once`);
    parts.push(
      signal.source === "body"
        ? `asked for ${seconds(signal.retryAfterMs)}`
        : `no wait advertised — using ${seconds(signal.retryAfterMs)}`,
    );
    lines.push(parts.join(" · "));
    if (signal.requestId) lines.push(`request id: ${signal.requestId}`);
  } else {
    lines.push("No refusal seen this session.");
  }

  lines.push(
    input.installs.length > 0
      ? `Bounded admission retry installed for: ${[...input.installs].sort().join(", ")}`
      : "Admission retry NOT installed — this turn uses Pi's own retry budget.",
  );

  if (input.model) {
    const used = input.contextTokens;
    const ctx =
      used == null ? `context unknown of ${input.model.contextWindow}` : `context ${used}/${input.model.contextWindow}`;
    lines.push(`Model: ${input.model.provider}/${input.model.id} (${input.model.api}) · ${ctx}`);
  }

  if (input.health && input.health.size > 0) {
    lines.push(input.healthFresh ? "Models (live):" : "Models (last known):");
    for (const [id, health] of [...input.health].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const slots = health.slots !== undefined ? `${health.slots} slot(s)` : "slots unknown";
      const state = health.state ? ` · ${health.state}` : "";
      // The line that answers "why is this one refusing?".
      const note = health.slots === 0 ? "  ← no capacity" : "";
      const marker = input.model && id === input.model.id ? "*" : " ";
      lines.push(`  ${marker} ${id} — ${slots}${state}${note}`);
    }
  }

  const elapsed = config.maxElapsedMs === undefined ? "default" : seconds(config.maxElapsedMs);
  lines.push(`Policy: server minimums preserved, retry cap ${limit(config.maxRetries)}, elapsed cap ${elapsed}`);
  return lines;
}
