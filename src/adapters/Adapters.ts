/**
 * Optional external adapters (backlog B-103 AutoSpec, B-104 InferWeave).
 *
 * Project constraint (AGENTS.md): core MUST NOT require AutoSpec, InferWeave,
 * a distributed cluster, multiple models, or GitHub. These adapters are
 * OPTIONAL seams: they are never invoked by core, never imported by core, and
 * default to `null`. An operator who installs one of these external systems may
 * plug it in to feed the runtime with planning/architecture artifacts or to
 * offload cross-session reasoning — but the runtime is fully standalone without
 * any of them.
 */
/**
 * Who is asking. `fencingToken` is the mission lease's token
 * (`MissionLease.fencingToken`, src/orchestration/ownership.ts): it only grows,
 * so a call from a superseded owner carries a lower one and is refused.
 */
export interface AutoSpecOwner {
  readonly ownerId: string;
  readonly fencingToken: number;
}

/** One unit of work Pi hands to AutoSpec. Pi owns the mission; AutoSpec only executes. */
export interface AutoSpecSubmission {
  readonly missionId: string;
  readonly taskId: string;
  /** What to do, in the words the task was given. */
  readonly request: string;
  /** The commit the work starts from. */
  readonly baseSha: string;
  readonly owner: AutoSpecOwner;
  /** Redelivering the same key must return the same handle, not start a second run. */
  readonly idempotencyKey: string;
}

export interface AutoSpecHandle {
  /** AutoSpec's id for the run; pass it to `observe` and `cancel`. */
  readonly externalId: string;
  readonly accepted: boolean;
  /** Why the submission was not accepted (for example a stale fencing token). */
  readonly reason?: string;
}

export type AutoSpecRunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** One verification stage as AutoSpec reports it. The output is what makes it evidence; an exit code alone is not. */
export interface AutoSpecStageReport {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  /** The stage's captured output. Empty or absent output is not evidence. */
  readonly output: string;
  readonly durationMs?: number;
}

export interface AutoSpecObservation {
  readonly state: AutoSpecRunState;
  /** A short account of the run, when AutoSpec gives one. */
  readonly summary?: string;
  /** For a verification run: the stages it ran. */
  readonly stages?: readonly AutoSpecStageReport[];
  /** RFC 3339 time of AutoSpec's last sign of progress; absent before any. */
  readonly lastProgressAt?: string;
  /** Increases with every observable change; a reader ignores a lower one than it has seen. */
  readonly sequence: number;
}

export interface AutoSpecCancelResult {
  readonly cancelled: boolean;
  /** The caller's fencing token is behind the run's owner: nothing was cancelled. */
  readonly stale: boolean;
}

/** Thrown by `observe` when the caller's fencing token is behind the run's owner. */
export class StaleFencingTokenError extends Error {
  readonly externalId: string;
  readonly caller: AutoSpecOwner;
  readonly holder: AutoSpecOwner;
  constructor(externalId: string, caller: AutoSpecOwner, holder: AutoSpecOwner) {
    super(
      `stale fencing token for ${externalId}: ${caller.ownerId}@${caller.fencingToken} is behind ${holder.ownerId}@${holder.fencingToken}`,
    );
    this.name = "StaleFencingTokenError";
    this.externalId = externalId;
    this.caller = caller;
    this.holder = holder;
  }
}

/**
 * The one rule every implementation applies: a caller is stale when its token
 * is lower than the holder's, or equal but from a different owner (two owners
 * must never share a token). A higher token is a newer owner taking over.
 */
export function isStaleAutoSpecOwner(holder: AutoSpecOwner, caller: AutoSpecOwner): boolean {
  if (caller.fencingToken !== holder.fencingToken) return caller.fencingToken < holder.fencingToken;
  return caller.ownerId !== holder.ownerId;
}

/**
 * Pi dispatches to AutoSpec; AutoSpec never owns the mission. Every call
 * carries the owner and its fencing token, and an implementation MUST refuse
 * (`accepted: false`, `stale: true`, or `StaleFencingTokenError`) one whose
 * token is stale per `isStaleAutoSpecOwner`. Core never imports an
 * implementation; it is installed through `AdapterRegistry`.
 */
export interface AutoSpecAdapter {
  readonly name: "autospec";
  submit(submission: AutoSpecSubmission): Promise<AutoSpecHandle>;
  observe(externalId: string, owner: AutoSpecOwner): Promise<AutoSpecObservation>;
  cancel(externalId: string, owner: AutoSpecOwner, reason: string): Promise<AutoSpecCancelResult>;
}

export interface InferWeaveAdapter {
  readonly name: "inferweave";
  /** Retrieve a relevant knowledge slice for a goal (null if absent). */
  retrieve(goal: string): Promise<string | null>;
  /** Record a learned invariant/hypothesis. */
  record(hypothesis: string, evidenceRef: string): Promise<void>;
}

/** Registry of optional adapters. Empty by default — core is standalone. */
export class AdapterRegistry {
  private readonly autospec: AutoSpecAdapter | null;
  private readonly inferweave: InferWeaveAdapter | null;

  constructor(opts: { autospec?: AutoSpecAdapter | null; inferweave?: InferWeaveAdapter | null } = {}) {
    this.autospec = opts.autospec ?? null;
    this.inferweave = opts.inferweave ?? null;
  }

  get autospecAdapter(): AutoSpecAdapter | null {
    return this.autospec;
  }

  get inferweaveAdapter(): InferWeaveAdapter | null {
    return this.inferweave;
  }

  /** True when any optional adapter is installed. */
  get hasAdapters(): boolean {
    return this.autospec !== null || this.inferweave !== null;
  }
}
