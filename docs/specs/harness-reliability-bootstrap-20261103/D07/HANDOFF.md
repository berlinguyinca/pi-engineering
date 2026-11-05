# D07 — Produce bounded diagnostic evidence bundle

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/D07/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/D06/D06.handoff.json (sha256:7c4a903f0f483e4bfd9fc49be3f733ca9e439bb233c3b96a74926441d60799ce, status PASS, resultSha 5a5a2a654a78475725a0e56ec4773c9dfa2e3f6e = your base).
Base commit: 5a5a2a654a78475725a0e56ec4773c9dfa2e3f6e. Mode: isolated-change.

## Objective (plan delta, verbatim)
Collect representative sanitized occurrences, linked retries, affected versions and task/handoff IDs; enforce size and privacy limits.

## Scope (hard limits)
- Exactly 2 files may change: `src/incidents/evidenceBundle.ts` (production ≤ 2) and `test/unit/error-evidence-bundle.test.ts` (tests ≤ 2).
- Total changed lines vs base (added + deleted) ≤ 100 across the commit. Keep the module lean; a pure builder plus one bounded projection is enough.
- Denied: `scripts/**` existing files, `src/bootstrap/**` (the gate you are judged by), `package.json`, `.gitignore`, `test/support/**`, `docs/specs/harness-reliability-bootstrap-20261103/manifests/**` and `templates/**`. Touch nothing else.
- Do NOT run the full unit suite (`npm run test:unit` / `test:unit`): it is baselined red and takes ~25 minutes on this host. Run only the two verify commands below plus the neighbour files named here.

## Required behaviour
1. Pure, read-only: no filesystem, no network, no child processes, no wall clock, no RNG. Never mutate inputs.
2. Reuse the existing modules instead of reimplementing: `errorSanitize.ts` (`sanitizeForPersistence`, E04), `errorReader.ts` (D01 occurrence shape), `errorFingerprint.ts` (D02), `errorAggregate.ts` (D03 clusters and their representatives), `recoveryOutcome.ts` (D04), `retryTrace.ts` (E07 `failureIdentity` and the safe `errorRef`). Import from `./` — do not copy their logic.
3. Export `buildEvidenceBundle(input, limits)` where input carries occurrences (and, when available, retry trace records) and limits carry explicit size caps (at least maxItems and maxBytes). The bundle must contain, per included cluster: the representative sanitized occurrence summary, its stable fingerprint, linked retry identities (failure identity / correlation ids), affected versions (distinct runtime / model / quantization values), the recovery outcome class where evidence exists, and the task/handoff ids discoverable from the occurrence's correlation ids (never invented).
4. Privacy: every string that can carry caller text goes through `sanitizeForPersistence`; raw prompt bodies, raw ids, key material and bearer URLs must not survive. Byte accounting happens after sanitization, and the bundle must state how many items were dropped for size (truncation must be visible, never silent).
5. Determinism: same inputs → byte-identical JSON (`JSON.stringify` stable), ordered by fingerprint then timestamp then id.

## Tests (test/unit/error-evidence-bundle.test.ts)
Assert: reproducible context is retained (fingerprint, versions, retry identity, task/handoff ids present when the input carries them); all secret-bearing inputs are redacted (feed a bearer URL, a key-shaped token and a long prompt, then assert the sanitized shape and that the raw strings appear nowhere in the serialized bundle); `maxItems` and `maxBytes` are enforced with the dropped count reported; ordering is deterministic; inputs are not mutated. Run the neighbours `test/unit/error-aggregate.test.ts`, `test/unit/error-sanitize.test.ts` and `test/unit/retry-error-events.test.ts` too and report their exit codes.

## Verify (must be green at the commit you produce)
- `npm run typecheck`
- `node --test --import ./test/support/isolatedState.ts test/unit/error-evidence-bundle.test.ts`

## Report
Write `WORKER_REPORT.md` in the worktree root: the exact diff summary (`git diff --numstat 5a5a2a654a78475725a0e56ec4773c9dfa2e3f6e HEAD`), each command with its exit code, and any deviation or BLOCKED condition (if the contract cannot fit 100 lines, say exactly which clause costs what and stop). Commit only the two files with message `feat(incidents): bounded sanitized evidence bundle (D07)`.
