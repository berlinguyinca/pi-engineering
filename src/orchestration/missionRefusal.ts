/**
 * A refusal that says what to do next (issue #511).
 *
 * `Orchestrator.orchestrate()` used to throw `new Error("runtime maintenance is
 * draining missions")` while its sibling entry points (`runSubmittedMission`)
 * returned `{ started: false, reason: "runtime_maintenance" }`. A caller that
 * catches errors generically saw an unlabelled failure and silently absorbed
 * work that was supposed to be delegated — observed three times in one session,
 * with no retry hint and no artifact saying "delegation blocked".
 *
 * The typed refusal carries what the caller needs to act: why, when to retry,
 * how much is still draining, and how to resume.
 */

/** Why a mission was refused. Kept to the reason strings the return-shaped entry points already use. */
export type MissionRefusalReason = "runtime_maintenance";

/** Floor for `retryAfterMs`: maintenance ends when the operator ends it, so the wait is a poll interval, not a promise. */
export const MISSION_REFUSAL_POLL_MS = 1_000;

export class MissionRefusedError extends Error {
  readonly reason: MissionRefusalReason;
  /** Milliseconds to wait before retrying. A retry can still be refused: maintenance ends when the operator ends it. */
  readonly retryAfterMs: number;
  /** How the refused work is started again. */
  readonly resumeHint: string;
  /** Live runs still draining. */
  readonly draining: number;

  constructor(reason: MissionRefusalReason, fields: { retryAfterMs: number; resumeHint: string; draining: number }) {
    super(
      `runtime maintenance is draining missions (${fields.draining} live run(s) draining, retry in ${fields.retryAfterMs}ms): ${fields.resumeHint}`,
    );
    this.name = "MissionRefusedError";
    this.reason = reason;
    this.retryAfterMs = fields.retryAfterMs;
    this.resumeHint = fields.resumeHint;
    this.draining = fields.draining;
  }
}

/**
 * The caller-facing line for a refused delegation. The point of the wording is
 * that the caller keeps working read-only instead of treating the refusal as a
 * failure of the work itself.
 */
export const missionRefusalText = (error: MissionRefusedError): string =>
  `delegation blocked; continuing read-only — ${error.message}`;
