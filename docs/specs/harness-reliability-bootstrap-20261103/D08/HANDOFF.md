# D08 — Add bounded local-model diagnostic adapter

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/D08/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/D07/D07.handoff.json (sha256:5a604be0f0fc7e488066185289d087a9d48ce31efaa8ea05a3a6ee04e3ad1d23, status PASS, resultSha 925836054ca7b8def51b4b2a636706e6c375e53b = your base).
Base commit: 925836054ca7b8def51b4b2a636706e6c375e53b. Mode: isolated-change.

## Objective (plan delta, verbatim)
Build a pure contract/prompt package for Qwen Flash or 27B with evidence and read-only constraints; no automatic dispatch, no source changes, no self-repair.

## Scope (hard limits)
- Exactly 2 files may change: `src/incidents/diagnosticTask.ts` (production ≤ 2) and `test/unit/incident-diagnostic-task.test.ts` (tests ≤ 2).
- Total changed lines vs base (added + deleted) ≤ 100.
- Denied: `scripts/**` existing files, `src/bootstrap/**`, `package.json`, `.gitignore`, `test/support/**`, `docs/specs/harness-reliability-bootstrap-20261103/manifests/**`, `templates/**`. Touch nothing else.
- **No model call, ever.** Forbidden anywhere in your file: `fetch`, `node:http`, `node:net`, `child_process`, and any import from `src/inference/` provider/client/router modules, `src/llm`, or anything that opens a connection. This unit builds a *package* a human or a later orchestrator can hand to a local model; it must never dispatch one. A grep for those patterns is part of the acceptance evidence.
- Do NOT run the full unit suite (baselined red, ~25 min here). Run only the two verify commands plus the neighbours named below.

## Required behaviour
1. Pure and deterministic: no fs, no network, no clock, no RNG, no mutation of inputs; identical inputs serialize byte-identically.
2. Reuse, do not copy: consume the D07 bundle (`./evidenceBundle.ts` — `buildEvidenceBundle`, `EvidenceBundle`, `EvidenceItem`) and D01/D03 types. The prompt package carries the bundle, never a re-derived copy of it.
3. Export a contract builder, e.g. `buildDiagnosticTask(input, limits)` returning at least: `modelHint` (one of the local routes this repo already names for Qwen Flash / 27B — discover the existing route/model id convention and reference it as a hint string, do not construct a client), `systemContract` (the role + hard prohibitions), `prompt` (the bounded evidence package), `requiredFields`, `constraints` and a `maxBytes`-respecting `truncated`/`dropped` account.
4. The contract text must state the hard limits in words an operator can audit: read-only diagnosis, no source modification, no self-repair, no automatic dispatch, no new tooling, answer from the supplied evidence only, and name every evidence id it relies on.
5. The answer shape is required, not suggested: an answer must carry hypothesis, supporting event ids, disconfirming evidence and uncertainty (plus what further evidence would change the verdict). Export a validator, e.g. `parseDiagnosticResponse(text)`, that fails closed: missing/empty sections, ids that are not in the supplied bundle, or a hypothesis restated as the summary get refused with a stable reason list. Never repair or invent the missing parts.
6. Bounded: a `maxBytes` cap on the whole package; when it bites, say so in the account rather than silently trimming.

## Tests (test/unit/incident-diagnostic-task.test.ts)
Assert: package is deterministic and includes the bundle's fingerprints/event ids and the named model hint; the contract text contains the read-only / no-source-change / no-self-repair / no-auto-dispatch prohibitions; `maxBytes` enforcement reports what was dropped; the response validator accepts a complete answer and refuses (with reasons) one missing each of hypothesis, supporting events, disconfirming evidence, uncertainty, and one citing an event id absent from the bundle. Also run neighbours `test/unit/error-evidence-bundle.test.ts` and `test/unit/error-aggregate.test.ts` and report their exit codes.

## Verify (must be green at the commit you produce)
- `npm run typecheck`
- `node --test --import ./test/support/isolatedState.ts test/unit/incident-diagnostic-task.test.ts`

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat 925836054ca7b8def51b4b2a636706e6c375e53b HEAD`, each command with exit code, the exact grep you ran to prove no dispatch surface, and any deviation or BLOCKED clause. Commit only the two files as `feat(incidents): bounded local-model diagnostic task package (D08)`.
