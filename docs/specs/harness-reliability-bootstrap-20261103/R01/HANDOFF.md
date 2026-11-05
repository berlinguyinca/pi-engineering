# R01 — Catalog current retry ownership by failure

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/R01/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/T09/T09.handoff.json (sha256:57a2f40ceccf0b48a01e25e5d4e56700a6668f6ad4eada374f4f78a747ff2524, status PASS, resultSha 3bb21ab2e4b4434f01f01d93770ff4a131f176e9 = your base).
Base commit: 3bb21ab2e4b4434f01f01d93770ff4a131f176e9. Mode: **read-only** (documentation only; zero source changes).

## Objective (plan delta, verbatim)
Document actual owners for 429,404,400,5xx, network timeout, missing worker_result and tool errors; cite files and current retry limits. No changes.
Evidence: One owner proposed for each class; unresolved conflicts explicitly listed.

## Scope (hard limits)
- Exactly 1 file, and it is the manifest's declared production path: `docs/specs/harness-reliability-bootstrap/RETRY_OWNERS.md` (**no date suffix** — that is the manifest's path, use it verbatim; `docs/specs/harness-reliability-bootstrap/` may need to be created). Total changed lines ≤ 100.
- **No code changes whatsoever**: no `.ts`, no `package.json`, no `.gitignore`, no test file, nothing under `scripts/**`, `src/**`, `test/**`, `manifests/**`, `templates/**`. `git diff --check` is the only verify command.
- Read as much as you like; write exactly that one file.

## Verified anchors (I read these at base; re-read before citing, and cite `path:line` for every claim)
- `src/resilience/classify.ts` — `InfraErrorCategory` at :20, `CATEGORY_TO_STATE` at :28, `classifyInfraError()` at :137.
- `src/gateway/signals.ts` — `GatewayWaitSignal` :31, `DEFAULT_WAIT_MS = 5_000` :87, `LINK_CUT_WAIT_MS = 1_000` :108, `TRANSPORT_DROP_WAITS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000]` :223, `GatewayRetryDecision` :659.
- `src/inference/retryDelay.ts` — `exponentialBackoffMs()` :89 (base * 2^(attempt-1), capped), and the delay resolver at :147-:176 that takes the **largest** of server `Retry-After` and computed backoff.
- `src/inference/resilientStream.ts` — `maxAttempts: this.config.streamRetryMaxAttempts` :227, `attempts` getter :256, and the comment at :192 that the *caller* may itself retry 5xx/network/timeout.
- `src/inference/admissionConfig.ts` — where the retry/backoff bounds are configured (find the actual defaults yourself).
- `src/guard/transient.ts` — the largest retry-adjacent module (37 retry/backoff references at base); find what it actually decides.
- `src/gateway/fallbackLifecycle.ts` — model fallback/cool-down lifecycle (12 retry references).
- `src/workers/PiWorkerExecutor.ts` — `Worker returned no worker_result…` :1427, `Worker reply truncated at the output limit` :1424, and the comment at :2167 about not settling as a permanent `no worker_result` failure.
- `src/plannerWorker/executor.ts` — the contract-level attempt/escalation loop (`DEFAULT_STAGE_INACTIVITY_MS`, `verificationInactivityMs`, `afterFailure`, escalation rungs).
- Other owners you must locate and cite yourself: `src/verify/targetedRetry.ts:44` (`DEFAULT_MAX_ATTEMPTS = 2`), `src/verify/Verifier.ts:40` (`DEFAULT_STAGE_INACTIVITY_MS = 15 * 60_000`), `src/lifecycle/roleRunner.ts:71` (`MAX_ROUTING_ATTEMPTS = 3`), `src/models/health.ts:48` (`DEFAULT_HEALTH_ERROR_BACKOFF_MS = 60_000`), `src/runtime/host/sourceWatch.ts:27-28` (`INITIAL_RETRY_DELAY_MS = 30_000`, `MAX_RETRY_DELAY_MS = 5 * 60_000`), `src/runtime/EngineeringRuntime.ts:200-204` (`SNAPSHOT_PUBLISH_MAX_RETRIES = 4`, `SNAPSHOT_PUBLISH_BACKOFF_MS = 100`, `SNAPSHOT_LOCK_BUSY_MAX_ATTEMPTS = 5`), `src/runtime/herdr/ControlPlaneIngest.ts:220` and `:271` (408/425/429 back off honouring `Retry-After`, never dead-letter), `src/aps/escalation.ts`.

## Required document shape (≤ 100 lines total, markdown)
1. Title + one-paragraph purpose, stating it catalogs **current** ownership as of base commit 3bb21ab2 and that it proposes exactly one owner per class going forward without changing any code.
2. A table with one row per failure class — `429`, `404`, `400`, `5xx`, network timeout, missing `worker_result`, tool error — and columns: **Current owner** (module + `path:line`), **Current limit** (the literal constant or config key with its value and `path:line`, or `none` / `unknown` if you could not find one), **Who decides the retry** (inference layer / gateway / runtime / planner-worker executor / verification / nobody), **Proposed single owner** (one module name, one sentence), **Notes**.
3. A `## Unresolved conflicts` section listing every place where **more than one** component actually retries or classifies the same class today (e.g. 429 handling appearing in `gateway/signals.ts`, `inference/resilientStream.ts` and `runtime/herdr/ControlPlaneIngest.ts` — verify whether that is three owners, or three scopes of one owner), each with its citations and what would have to change to consolidate. If a class has no owner today, say so explicitly rather than inventing one.
4. A `## Method` section: how you established each owner (files read, greps run), and an explicit statement that no source file was modified.
5. Every factual claim carries a `path:line` you actually opened. Where you are inferring (e.g. "the runtime does not retry 400 because nothing matches 400 in the classifier"), mark it `inferred` and name what you checked. Never invent a constant name or a value — if a value comes from config rather than a literal, cite the config key and the default's `path:line`.
6. No scores, no confidence percentages; facts and explicit unknowns only.

## Verify (must be green at the commit you produce)
- `git diff --check`

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat 3bb21ab2e4b4434f01f01d93770ff4a131f176e9 HEAD` (must show exactly one `docs/specs/harness-reliability-bootstrap/RETRY_OWNERS.md` file), `git diff --check` exit code, the total line count of the document, and the list of every file you opened to establish citations. Commit the one file as `docs(recovery): retry ownership catalog by failure class (R01)`.
