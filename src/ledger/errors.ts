/**
 * Typed rejections of a fenced Ledger append. In every case the event was NOT
 * written: the writer held a stale view of the log or a superseded authority.
 */

/** `expected_revision` no longer matches the scope's revision (another writer appended first). */
export class LedgerRevisionConflictError extends Error {
  readonly code = "LEDGER_STALE_REVISION";
  readonly scope: string | null;
  readonly expectedRevision: number;
  readonly actualRevision: number;
  constructor(scope: string | null, expectedRevision: number, actualRevision: number) {
    super(
      `stale ledger writer: expected revision ${expectedRevision} for ${scope ?? "<no work item>"}, log is at ${actualRevision}`,
    );
    this.name = "LedgerRevisionConflictError";
    this.scope = scope;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/** `authority_generation` is older than one already recorded for the scope: a fenced-off owner wrote. */
export class LedgerAuthorityStaleError extends Error {
  readonly code = "LEDGER_STALE_AUTHORITY";
  readonly scope: string | null;
  readonly authorityGeneration: number;
  readonly currentGeneration: number;
  constructor(scope: string | null, authorityGeneration: number, currentGeneration: number) {
    super(
      `stale ledger authority: generation ${authorityGeneration} for ${scope ?? "<no work item>"} is behind recorded generation ${currentGeneration}`,
    );
    this.name = "LedgerAuthorityStaleError";
    this.scope = scope;
    this.authorityGeneration = authorityGeneration;
    this.currentGeneration = currentGeneration;
  }
}
