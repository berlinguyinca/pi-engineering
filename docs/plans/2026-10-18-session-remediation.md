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

## Verified outcomes

- Failed model pins cannot cancel their replacements; takeover has a finite
  attempt bound. Registry fallback retains role and task capability requirements.
- Mission-level implementation failure before publication can produce its first
  real candidate; durable stops still prevent new dispatch while stale work is
  reconciled. Validation and review gates retain their candidate requirements.
- Workers reject a mismatched allocated repository, path, or branch before
  inference. Isolated native edit/write operations stay within that worktree;
  actual tree differences, rather than commit counts, substantiate completion.
  This does not introduce an arbitrary shell sandbox.
- Ledger evidence references must resolve locally. Hypotheses remain open, and
  tool results explicitly distinguish unresolved claims from recorded evidence.
- The original Beast finding `FINDING-bOLnJ7` was marked rejected in its original
  ledger. Appended correction `FINDING-ObcyNk` cites the captured measurements in
  `artifact://audit/20261018-beast-diagnosis-correction`. No history was rewritten.
- Storage-pressure wiring and the fresh-incident regression were already fixed
  upstream; the controller and snapshot-guard tests passed in this worktree.
- A stale runtime generation cannot release a newer generation's leases.
  Contention reporting is bounded and records reporting-window counts. The
  audited long-held owner was live with a fresh heartbeat, so no real leases
  were revoked.
- Deployment prerequisites and explicit inspection are implemented separately in
  go-modules PR https://github.com/metabolomics-us/go-modules/pull/2384.

## Interrupted-work inventory

The original shared checkouts still contained ongoing work when inspected:

| Repository | Branch | HEAD | Changed entries |
| --- | --- | --- | --- |
| pi-engineering | main | 44e1bfd | 2 |
| inferweave-gateway | feat/node-systemone-adverts | f755574 | 10 |
| inferweave | pi-eng-candidate-MSN-opbhoi-repo-0b2d84c8f589a772-1-0-EXC-IX4n6g | 26a60371 | 8 |
| go-modules | fix/bound-each-module-build-in-a-shard | 5ea63e7a0 | 19 |
| inferweave-harness-skills | main | 08dfed8 | 1 |

These are observation-time snapshots, not ownership or completion evidence. No
shared branch was switched or reset, and unrelated dirty files were not folded
into the remediation PRs. Real mission restarts, model-serving recovery, and
deployment success remain unverified until their external prerequisites pass.

## Validation

The broad local suite completed with 4,896 passes, zero failures, one skip, and
ten existing TODOs (4,907 total tests). After the final review corrections, the
affected routing, custom-executor, worker-isolation, recovery, ledger, lease,
and storage suites passed again: 205 tests, zero failures or skips.

Core and script typechecks, repository lint, package/command smoke checks, and
the roadmap structural check passed on the final implementation. Explicitly
configured routing remains strict; injected executors without a Pi model
catalog retain standalone operation, covered by three runtime-level cases.
