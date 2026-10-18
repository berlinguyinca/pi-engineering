# Pi session reliability remediation

The operator approved six bounded fixes following the October 18 session audit.
Existing dirty checkouts and mission artifacts remain untouched. Work is isolated
in dedicated branches; regression tests precede behavior changes.

1. Reproduce unavailable model fallback failures; retain rejection provenance,
   enforce compatibility, and stop explicitly when routing is exhausted.
2. Reproduce blocked mission recovery with stale resumption generations and no
   published candidate. Recover without inventing candidate or review evidence.
3. Bind mutating workers to their assigned worktree and require actual changes
   before accepting a mutating completion. Preserve exact candidate evidence.
4. Prevent invented evidence references from verifying ledger claims; retain
   uncertainty and correct the unsupported Beast diagnosis without rewriting
   history. Verify the current storage-pressure regression tests.
5. Make deployment inspection versus migration application explicit and check
   provenance prerequisites before remote writes. Report partial side effects.
6. Verify lease ownership before reclamation; reproduce stale-generation and
   contention diagnostics defects without revoking real active leases.

Each lane owns its files and records red/green evidence. The leader integrates
commits, reviews the combined diff separately, and runs relevant tests, typecheck,
lint, and package smoke checks. Changes enter main through a green pull request.
Live mission restarts and deployments require their normal prerequisite checks;
neither test success nor heartbeat alone establishes live completion.
