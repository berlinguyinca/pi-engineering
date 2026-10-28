# Remaining runtime release and validation — 2026-10-27

This release keeps the legacy runtime default. It repairs known redaction gaps,
uses measured Rust/Go model admission capacity, fixes actual Herdr provisioning
and lifecycle boundaries, and avoids copying nested dependency installations into
rollback snapshots. PostgreSQL validation uses an owned socket-only cluster.

## Scope and approval boundary

The model-switch handoff/context-projection change is excluded from this release.
`docs/specs/2026-10-17-handoff-compaction-migration-design.md`, Unit C1, explicitly
requires human review and says **no auto-merge**. Its actual provider and SDK
lifecycle proofs are prepared separately for that review.

PR #442 was merged by another contributor before this release; its mission
recovery changes are included in the base and receive integrated regression
coverage. Existing formatting drift from that merge is repaired mechanically.

## Evidence

- All ten previously known redaction misses now require passing tests; punctuation,
  multiline values, and false-positive controls are covered.
- The deployed Go admission probe was exercised read-only with existing private
  credentials. Model-level fresh capacity was observed. Principal/global admission
  remains authoritative at the gateway, not granted by this probe.
- Real owned PostgreSQL: five integration tests passed, zero skips.
- Real Herdr/Pi: five bounded arithmetic workers, then five actual coding workers;
  model-authored commits were integrated, tests independently passed, and the diff
  was reviewed. Named servers, panes, credentials, and fixtures were cleaned up.
- Selector fallback was tested against an intentionally incompatible Herdr protocol.
  This is not a complete migration/rollback state machine or restart reconciliation.
- Same-source snapshot comparison: 819 copied files / 237 ms before; 680 files /
  170 ms after nested dependency reuse. Cold/warm SDK compilation affects full
  startup measurements, so those timing differences are not attributed solely to IO.

Full integrated test, review, deployment and rollback receipts are recorded on the
release PR and the local managed release receipt. No Herdr migration activation
or claim of durable worker restart recovery is included.
