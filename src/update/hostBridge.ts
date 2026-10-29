/**
 * The seam between the legacy `/update` command and the runtime host.
 *
 * `/update` lives in the legacy extension, whose only update mechanism is a
 * strict fast-forward of a git checkout. An installed runtime is not a
 * checkout: it is a version directory under an install root with `current` /
 * `previous` pointers, a transaction journal, and no version-control metadata
 * at all. Asking git what to do with that tree can only ever answer "not a git
 * checkout" — which is true, useless, and was exactly what an operator hit while
 * a real update was pending.
 *
 * The machinery that CAN move an installed runtime (fetch the channel, stage a
 * candidate, validate, activate at a safe point, health-check, commit, keep
 * `previous` for rollback) belongs to the host's UpdateManager, and only the
 * host may activate a generation. So the host publishes this bridge when it
 * installs, and `/update` asks the bridge whether it owns the tree Pi loaded
 * from. When it does, `/update` drives the transaction; when it does not, the
 * checkout path runs unchanged.
 *
 * Formatting stays with the host: one place owns the wording of a runtime
 * update, and the bridge hands back lines rather than structures the caller
 * would have to re-derive.
 */

/** A read-only answer about the pending commit. */
export interface RuntimeUpdateCheckReport {
  /** Formatted lines describing current versus available. */
  lines: string[];
  /** True when the channel holds a commit the runtime does not. */
  pending: boolean;
  /** Why the check could not answer, when it could not. */
  failure?: string;
}

/** The result of driving the transaction. */
export interface RuntimeUpdateApplyReport {
  /** Phase lines as they happened (fetch, stage, validate, activate, ...). */
  lines: string[];
  /** Formatted final outcome. */
  outcome: string;
  /** True when the runtime reached a state the operator can rely on. */
  ok: boolean;
}

export interface RuntimeUpdateBridge {
  /**
   * True when `dir` is a version directory of the install this bridge drives —
   * i.e. the tree Pi is actually loading the extension from.
   */
  owns(dir: string): boolean;
  /** Read-only: no staging, no pointer move, no journal write (§13). */
  check(): Promise<RuntimeUpdateCheckReport>;
  /** Drive the transaction, reporting each phase as it happens. */
  apply(report?: (line: string) => void): Promise<RuntimeUpdateApplyReport>;
}

let bridge: RuntimeUpdateBridge | undefined;

/**
 * Publish (or withdraw) the bridge. Called by the runtime host at install and
 * at dispose; replacing an existing bridge is legitimate — a reload installs a
 * new Host, and the newest one is the one that owns activation.
 */
export function setRuntimeUpdateBridge(next: RuntimeUpdateBridge | undefined): void {
  bridge = next;
}

/** The bridge currently installed, if any. */
export function runtimeUpdateBridge(): RuntimeUpdateBridge | undefined {
  return bridge;
}
