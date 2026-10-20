/**
 * The one concrete `AutoSpecAdapter` (name `"autospec"`).
 *
 * It adapts pi-engineering's OWN external mission entry
 * (src/orchestration/externalEntry.ts) as the "AutoSpec" execution system.
 * The external entry is a JSON CLI; this adapter is the in-process seam that
 * hands it work and watches or stops it. The entry's envelope validation and
 * store plumbing are REUSED, not duplicated: this adapter only applies the
 * AutoSpec contract on top (idempotency, fencing, state mapping, monotonic
 * sequence).
 *
 * All dependencies are injected (no singletons, no global state), so the
 * adapter is trivially unit-testable. It never mutates mission state directly;
 * it only reads a snapshot (observe dependency) and drives submit/cancel
 * through the existing entry paths.
 *
 * Re-exported from the public surface (`src/index.ts`) so runtime wiring can
 * construct it; nothing else imports this module directly.
 */
import {
  type AutoSpecAdapter,
  type AutoSpecCancelResult,
  type AutoSpecHandle,
  type AutoSpecObservation,
  type AutoSpecOwner,
  type AutoSpecRunState,
  type AutoSpecSubmission,
  StaleFencingTokenError,
  isStaleAutoSpecOwner,
} from "./Adapters.ts";

/**
 * The mission lifecycle as the observation dependency reports it. This is the
 * canonical projection (CanonicalLifecycleState) of a persisted mission plus
 * the last time the external system showed progress (RFC 3339 when known).
 */
export interface AutoSpecMissionSnapshot {
  readonly missionId: string;
  readonly canonicalState: string;
  /** RFC 3339 time of the mission's last recorded activity; absent before any. */
  readonly lastProgressAt?: string;
}

/** The external-entry submit path: creates the mission and returns its receipt. */
export type AutoSpecSubmitFn = (
  sub: AutoSpecSubmission,
) => Promise<{ missionId: string; fencingToken: number; created: boolean }>;

/** The external-entry observe path: reads a mission snapshot (read-only). */
export type AutoSpecObserveFn = (missionId: string) => Promise<AutoSpecMissionSnapshot>;

/** The external-entry cancel path: cancels a mission; a terminal run is a no-op. */
export type AutoSpecCancelFn = (
  missionId: string,
  owner: AutoSpecOwner,
  reason: string,
) => Promise<{ cancelled: boolean }>;

/** One registered run: its mission, who holds it, and how far reads have advanced. */
interface RegisteredRun {
  readonly externalId: string;
  readonly missionId: string;
  holder: AutoSpecOwner;
  sequence: number;
}

/**
 * Map a canonical mission lifecycle state onto the AutoSpec run-state
 * vocabulary. This mirrors the `state` enum of `autospec-protocol-mission.v1`.
 */
function mapRunState(canonical: string): AutoSpecRunState {
  switch (canonical) {
    // Not yet executing: created/planned/ready all wait for dispatch.
    case "CREATED":
    case "PLANNED":
    case "READY":
    case "PAUSED":
      return "queued";
    // Actively executing or moving through post-execution phases.
    case "RUNNING":
    case "VALIDATING":
    case "REVIEWING":
    case "REPAIRING":
    case "RECOVERING":
    case "MERGE_QUEUED":
    case "MERGING":
    case "FINALIZING":
      return "running";
    // COMPLETE projects to MERGED; the mission is done and its output counts.
    case "MERGED":
    case "ARCHIVED":
      return "succeeded";
    case "FAILED":
    case "BLOCKED":
    case "RETAINED_FOR_DIAGNOSTICS":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      // An unknown canonical state is safest read as still in flight.
      return "running";
  }
}

/**
 * Constructor options: the external-entry submit/observe/cancel functions and
 * a clock for stable progress timestamps in tests.
 */
export interface AutoSpecAdapterOptions {
  submit: AutoSpecSubmitFn;
  observe: AutoSpecObserveFn;
  cancel: AutoSpecCancelFn;
  now?: () => Date;
}

/** The concrete AutoSpec adapter backed by the external mission entry. */
export class ConcreteAutoSpecAdapter implements AutoSpecAdapter {
  readonly name = "autospec" as const;

  private readonly submitFn: AutoSpecSubmitFn;
  private readonly observeFn: AutoSpecObserveFn;
  private readonly cancelFn: AutoSpecCancelFn;
  private readonly now: () => Date;

  /** externalId by `${missionId}:${idempotencyKey}` — idempotent redelivery. */
  private readonly byKey = new Map<string, string>();
  private readonly runs = new Map<string, RegisteredRun>();
  /** Current fencing holder by missionId (for stale-submit checks). */
  private readonly holders = new Map<string, AutoSpecOwner>();

  constructor(opts: AutoSpecAdapterOptions) {
    this.submitFn = opts.submit;
    this.observeFn = opts.observe;
    this.cancelFn = opts.cancel;
    this.now = opts.now ?? (() => new Date());
  }

  async submit(submission: AutoSpecSubmission): Promise<AutoSpecHandle> {
    const key = `${submission.missionId}:${submission.idempotencyKey}`;
    const seen = this.byKey.get(key);
    if (seen !== undefined) return { externalId: seen, accepted: true };

    const holder = this.holders.get(submission.missionId);
    if (holder && isStaleAutoSpecOwner(holder, submission.owner)) {
      return {
        externalId: "",
        accepted: false,
        reason: `stale fencing token: ${submission.owner.ownerId}@${submission.owner.fencingToken} is behind ${holder.ownerId}@${holder.fencingToken}`,
      };
    }

    const receipt = await this.submitFn(submission);
    const externalId = receipt.missionId;
    this.byKey.set(key, externalId);
    this.runs.set(externalId, {
      externalId,
      missionId: submission.missionId,
      holder: { ownerId: submission.owner.ownerId, fencingToken: receipt.fencingToken },
      sequence: 1,
    });
    this.holders.set(submission.missionId, {
      ownerId: submission.owner.ownerId,
      fencingToken: receipt.fencingToken,
    });
    return { externalId, accepted: true };
  }

  async observe(externalId: string, owner: AutoSpecOwner): Promise<AutoSpecObservation> {
    const run = this.runs.get(externalId);
    if (run && isStaleAutoSpecOwner(run.holder, owner)) {
      throw new StaleFencingTokenError(externalId, owner, run.holder);
    }
    const snapshot = await this.observeFn(externalId);
    const state = mapRunState(snapshot.canonicalState);
    let sequence: number;
    let lastProgressAt: string | undefined;
    if (run) {
      // An observer must NOT adopt fencing-holder ownership: a read-only
      // caller that became run.holder would fence out the legitimate writer
      // with its token. Only write paths (submit/cancel) move the holder.
      // The sequence is strictly monotonic: every observable read advances it
      // so a reader can tell this observation apart from the one before.
      run.sequence += 1;
      sequence = run.sequence;
      lastProgressAt = snapshot.lastProgressAt;
    } else {
      // An observation for a run this adapter did not register: report the
      // snapshot as-is at sequence 1.
      sequence = 1;
      lastProgressAt = snapshot.lastProgressAt;
    }
    return { state, sequence, lastProgressAt };
  }

  async cancel(externalId: string, owner: AutoSpecOwner, reason: string): Promise<AutoSpecCancelResult> {
    const run = this.runs.get(externalId);
    if (run && isStaleAutoSpecOwner(run.holder, owner)) return { cancelled: false, stale: true };
    const result = await this.cancelFn(externalId, owner, reason);
    if (result.cancelled && run) {
      run.holder = owner;
      this.holders.set(run.missionId, owner);
    }
    return { cancelled: result.cancelled, stale: false };
  }
}

/** Single construction surface for a future runtime wiring point. */
export function createConcreteAutoSpecAdapter(options: AutoSpecAdapterOptions): ConcreteAutoSpecAdapter {
  return new ConcreteAutoSpecAdapter(options);
}
