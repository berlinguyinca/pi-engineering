# E03 Worker Report — Deterministic error normalization

## Task and worktree

- Task: `E03` (spec: `docs/specs/harness-reliability-bootstrap-20261103/E03/HANDOFF.md`).
- Worktree: `/Users/wohlgemuth/IdeaProjects/worktrees/pi-e03-error-normalize-20261104`.
- Branch: `feat/e03-error-normalize`.
- Base SHA observed before any edit (from `git rev-parse HEAD`): `ba22f28a6b540de74eb49a88a3e4fd62a08af1b4`.
- Dependencies: `/Users/wohlgemuth/IdeaProjects/worktrees/pi-e03-error-normalize-20261104/node_modules` existed and resolved; no installation was run.
- `npm run verify`, `npm run test:unit`, `npm run test:integration` were NOT run (forbidden for this task).
- Model: the session ran on `metabolomics/qwen3.8-flash_next` for the whole task (`PI_PROVIDER=metabolomics`,
  `PI_MODEL=qwen3.8-flash_next` still at completion) — **no gateway model switch to report**.
- Forbidden commands were not run: no `git push`/`merge`/`rebase`/`commit --amend`/`reset`/`worktree`, no
  `--no-verify`, no checkout of another branch, no install, no state mutation outside this worktree. The branch is
  intentionally unpushed; integration is the conductor's.

## Files created

Exactly two files, both new, nothing else touched:

1. `src/incidents/errorNormalize.ts` — 54 lines
2. `test/unit/error-normalize.test.ts` — 45 lines

Budget: 54 + 45 = 99 ≤ 100 (`wc -l` and `git diff --numstat HEAD~1 HEAD` agree).

## Public API

```ts
export const UNKNOWN_ERROR_CODE = "unknown.unclassified";
export const UNATTRIBUTED = "unattributed";
export interface NormalizationContext { timestamp; host; sessionId; runtime; correlationIds; runId?; taskId?; model?; quantization?; layer?; artifactRefs? }
export interface UnknownErrorInput { /* every field optional, [key: string]: unknown */ }
export function normalizeError(input: UnknownErrorInput | unknown, ctx: NormalizationContext): ErrorOccurrence
```

`ErrorOccurrence` (and its version/severity/layer vocabulary) is imported from `./errorEvent.ts`; no second
shape is defined. E03 constructs no sink and opens no file.

## Determinism contract and how the tests assert it

`normalizeError` is a pure function: the timestamp comes from `NormalizationContext.timestamp` (the module never
calls `new Date()`), the code/severity/layer come from a fixed rule table walked in written order (first match wins),
and every intermediate collection is a `Set` over strings built in a fixed insertion order, so there is no
iteration-order or locale dependence. Test 4 asserts deep-equality of two calls with identical `(input, ctx)` for all
nine fixtures, and asserts that a different context timestamp changes only `timestamp`, never `code`. The standalone
reproduction below re-checks stability with `JSON.stringify(a) === JSON.stringify(b)` for each fixture.

## Shape → code decisions (and evidence used)

Evidence: `inference/failureClassifier.ts` (its `FailureClass` vocabulary and its `classifyLlmFailure` text
heuristics) and `telemetry/diagnostics.ts` (`classifyErrorClass`: `rate_limited`, `gateway_unavailable`,
`network`, `nonzero_exit`, `tool_timeout`, `tool_no_structured_result`, `crash`) — both read as read-only sources,
as did E01's `inventory/incidents.ts`. `pi-types.ts` / `modelQuants.ts` carry no error-kind vocabulary (checked),
and no upstream Pi source was consulted because this repository's own classifier plus E02's schema already fix the
vocabulary; E02's `code` is an open printable namespace, so E03 stays consistent with the existing `layer`/`severity`
values rather than inventing new ones.

| observed shape | layer | code | severity | upstream term reused |
| --- | --- | --- | --- | --- |
| HTTP 429 / rate limit / `queue_timeout` | `gateway` | `gateway.429.rate_limited` | `warning` | `rate_limited` (`diagnostics.classifyErrorClass`) |
| HTTP 404 / `no such model` | `gateway` | `gateway.404.not_found` | `error` | E01's `gateway.404.not_found` incident code |
| HTTP 400 / `no thinking match for model` / context-overflow wording | `gateway` | `gateway.400.bad_request` | `error` | `invalid_request` (`failureClassifier.classifyLlmFailure`) |
| HTTP 5xx / `service unavailable` | `gateway` | `gateway.5xx.upstream` | `error` | `gateway_unavailable` (`diagnostics.classifyErrorClass`) |
| `ECONNREFUSED`/`ECONNRESET`/`EAI_AGAIN`/`ETIMEDOUT`/`socket hang up`/`fetch failed` | `host` | `network.connection_failed` | `warning` | `network` (`diagnostics.classifyErrorClass`) |
| timeout / deadline exceeded | `worker` | `execution.timeout` | `error` | `tool_timeout`, `request_timeout` |
| non-zero exit status | `worker` | `tool.nonzero_exit` | `error` | `nonzero_exit` |
| missing structured worker result | `worker` | `worker.result_missing` | `error` | `tool_no_structured_result` |
| crash / `SIGSEGV`/`SIGABRT`/`core dumped`/OOM-kill | `process` | `process.crash` | `fatal` | `crash` |
| anything unrecognised | `process` | `unknown.unclassified` | `warning` | new, this task |

Severity rationale: `error` where the unit of work failed outright (400, 404, 5xx, timeout, non-zero exit, missing
result), `warning` where the call was refused-but-retryable or transport-level (429, network) — matching
`diagnostics.classifyErrorClass`, which uses `warning` for `rate_limited` and `network` — and `fatal` for process
death. `layer` follows E02's closed vocabulary (`gateway|host|runtime|worker|process|model`).

Deterministic code selection: one table, evaluated top to bottom, first `when(signal)` wins, last entry is
`when: () => true`. The signal is (a) numeric HTTP status (`httpStatus`/`status`/`statusCode`, else a bounded
`4xx/5xx` regex against the message), (b) numeric exit status (`exitCode`/`exit_status`), (c) a lowercase haystack of
`kind|type|category` + errno/`code` + `signal` + first non-empty message field + `stderr`. Precedence is deliberate:
worker-result-missing and crash outrank exit status (a crashed or result-less worker is reported as itself, not as
"non-zero exit"), and specific HTTP codes outrank the generic 5xx/network/timeout rules.

## Determinism, redaction, and never-throw

- Redaction/normalization: `summary` goes through `src/platform/redact.ts::redactSecrets`, then control characters and
  DEL are replaced, then trimmed and clipped to 500 — the exact normalization E02's `printable()` demands; every other
  emitted field is passed through the same `printable` helper with its own cap. So a `summary` that E02 would reject
  cannot be produced here (test asserts `parseErrorOccurrence(...).ok === true` for every fixture, including the
  hostile/secret ones).
- `artifactRefs` are filtered through a `storable()` predicate that mirrors E02's ref rules (non-empty, printable
  ASCII, not absolute, no whitespace, no `..` segment), because E02 rejects such refs — an unsafe input ref is dropped
  rather than making the record unstorable. The input's own `evidenceRef`/`artifactRefs` are kept verbatim and ordered
  ahead of `ctx.artifactRefs` (the log file paths E04 will attach later).
- Never throws: shape reading is wrapped in `try` and a hostile getter cannot lose evidence — refs/correlation ids are
  read first; a throwing property still yields an event whose `artifactRefs` contain the evidence it carried.
  Primitives, `null`, `undefined`, arrays, and empty objects all normalize to `unknown.unclassified`.
- Unattributed context is recorded honestly: missing `host`/`sessionId`/`runtime` become `"unattributed"`, missing
  `correlationIds` become `["unattributed"]` (E02 requires ≥1), missing `runId`/`taskId`/`model`/`quantization` stay
  `null`, a non-ISO-8601 `ctx.timestamp` becomes `1970-01-01T00:00:00Z`, and an invalid `ctx.layer` falls back to the
  rule's layer. Nothing is invented and nothing is dropped.

## Fixture table (real output)

`node /tmp/e03dump.mjs` (same fixtures as the test; `…` abbreviates the shared
`docs/specs/harness-reliability-bootstrap-20261103/E03/logs/` evidence prefix; `ok=` is
`parseErrorOccurrence(event).ok`, `stable=` is byte-equality of two independent calls):

```text
429 rate limited       gateway  gateway.429.rate_limited   warning ok=true stable=true refs=…/01-verify.txt,…/99-derived.txt | upstream rate limit: http 429; Too Many Requests: queue_timeout after 3 attempts
404 not found          gateway  gateway.404.not_found      error   ok=true stable=true refs=…/01-verify.txt,…/99-derived.txt | upstream returned not found: http 404; 404 page not found
400 bad request        gateway  gateway.400.bad_request    error   ok=true stable=true refs=…/01-verify.txt,…/99-derived.txt | upstream rejected the request: http 400; no thinking match for model metabolomics/qwen3.8-flash_next
5xx upstream           gateway  gateway.5xx.upstream       error   ok=true stable=true refs=…/01-verify.txt,…/99-derived.txt | upstream server failure: http 503; HTTP 503 Service Unavailable from the gateway
timeout                worker   execution.timeout          error   ok=true stable=true refs=…/01-verify.txt,…/99-derived.txt | operation timed out: worker timed out after 900s waiting for the model
non-zero exit status   worker   tool.nonzero_exit          error   ok=true stable=true refs=…/01-verify.txt,…/99-derived.txt | tool exited with a non-zero status: exit 3; make: *** [verify] Error 2
missing worker result  worker   worker.result_missing      error   ok=true stable=true refs=…/01-verify.txt,…/99-derived.txt | worker finished without a structured result: worker finished with no result
network failure        host     network.connection_failed  warning ok=true stable=true refs=…/01-verify.txt,…/99-derived.txt | network connection failed: EAI_AGAIN; fetch failed
crash                  process  process.crash              fatal   ok=true stable=true refs=…/01-verify.txt,…/99-derived.txt | process crashed: SIGSEGV; core dumped
unknown                process  unknown.unclassified       warning ok=true stable=true refs=…/01-verify.txt,…/99-derived.txt | unclassified failure
```

## Exact verification output (after the final commit)

```console
$ npm run typecheck
> pi-engineering-runtime@0.2.0 typecheck:core
> tsc --noEmit

> pi-engineering-runtime@0.2.0 typecheck:scripts
> tsc --noEmit -p tsconfig.scripts.json
exit=0

$ node --test --import ./test/support/isolatedState.ts test/unit/error-normalize.test.ts
✔ each fixture maps to the demanded code and severity with a valid, non-empty summary (4.351917ms)
✔ unrecognised or unreadable input becomes an explicit unknown event instead of throwing (1.355875ms)
✔ the original evidence reference is preserved unchanged, ahead of the derived refs (0.169042ms)
✔ normalization is deterministic, clock-free, redacting and honest about missing attribution (0.610167ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
exit=0

$ node --test --import ./test/support/isolatedState.ts test/unit/error-event.test.ts
✔ accepts a fully attributed occurrence; absent optionals stay null (3.295458ms)
✔ an occurrence with no session is refused — unattributable errors are not recordable (0.221875ms)
✔ rejects unredacted secrets, control characters and unsafe artifact refs (0.245458ms)
✔ requires correlation and validates layer, severity, version, timestamp (0.141625ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
exit=0

$ node --test --test-concurrency=4 --test-force-exit --import ./test/support/isolatedState.ts \
    test/unit/autospec-incident-sink.test.ts test/unit/incident-controller.test.ts test/unit/incidents-fingerprint.test.ts
ℹ tests 20
ℹ pass 20
ℹ fail 0

$ git log --oneline -1
a0eca332 feat(incidents): deterministic error normalization (E03)

$ git diff --numstat HEAD~1 HEAD
54	0	src/incidents/errorNormalize.ts
45	0	test/unit/error-normalize.test.ts

$ git status --porcelain
(empty)
```

## Commit

- SHA: `a0eca332` on `feat/e03-error-normalize` (parent `ba22f28a`, the observed base).
- Message: `feat(incidents): deterministic error normalization (E03)` with a manifest-conformant `delta:` body.
- Scope: the two files above; `git status --porcelain` is clean afterwards (the `node_modules` symlink is ignored).

```
feat(incidents): deterministic error normalization (E03)

delta: adds src/incidents/errorNormalize.ts, a pure function mapping
observed HTTP/network/worker/crash failures onto the E02 ErrorOccurrence
schema (fixed codes and severities, never throwing, unrecognised input as
unknown.unclassified, original evidence refs preserved, no clock read), and
test/unit/error-normalize.test.ts covering the 429/404/400/5xx/timeout/
exit-status/missing-result shapes plus network, crash, unknown and evidence
preservation; verified with npm run typecheck and node --test on
error-normalize.test.ts and error-event.test.ts, all green.
```

## Concerns for the reviewer

1. **Formatting is deliberately not biome-conformant.** `npx biome check` on both files reports only
   `format`/`organizeImports` diffs (no semantic lint errors); biome's 80-column formatter would expand the dense
   rule table and multi-statement lines and blow the ≤100-line budget. E02's own files are in the same state
   (`npx biome check src/incidents/errorEvent.ts test/unit/error-event.test.ts` already fails on `format`), so this is
   consistent with the accepted E02 baseline — but if the conductor wants biome-clean files, the budget has to move.
2. **No dedicated context-overflow code.** Context-window wording (`prompt is too long`, `context length`, 413) maps
   to `gateway.400.bad_request` instead of a `gateway.context_overflow` code: `inference/failureClassifier.ts` already
   owns the `context_overflow` classification decision for inference failures, and a second heuristic in E03 would be
   duplicated policy. `recoveryAction` is E04's job, so no `compact_and_retry` mapping is emitted here. If E04 needs
   the distinction, it can read `code` + `summary` or the two can be unified in one place.
3. **`summary` carries the evidence shape, not just the rule text** (e.g. `upstream rate limit: http 429; Too Many
   Requests: queue_timeout after 3 attempts`), because E02 allows no field for the original message and E04 must be
   able to see what it matched. This makes `code` the machine key and `summary` the human-readable evidence line.
4. **`UNATTRIBUTED` (`"unattributed"`) is a value E03 invents for missing context**, chosen so an event stays storable
   (E02 refuses empty `host`/`sessionId` and requires ≥1 correlation id) instead of throwing. E04 may prefer to treat
   records carrying it as quarantined rather than aggregate them; the sentinel is exported for that check.
5. **HTTP status sniffing from message text** (`HTTP 503`, `status: 404`, …) is bounded to 4xx/5xx and only used when
   no structured status field exists; a stray "500" in unrelated prose could still be read as a status. E04/E05 should
   pass structured statuses when the runner has them.
6. **The mapping table is heuristic text matching over six candidate message fields** (`message`, `error`, `detail`,
   `text`, `reason`, `summary`) plus `stderr`; the first non-empty one becomes the summary text while all of them
   remain in the match haystack. Inputs that carry two different messages (e.g. an outer wrapper plus an inner
   provider message) summarize the outer one.

## Full final source: `src/incidents/errorNormalize.ts`

```ts
// E03: deterministic normalization of observed harness failures into the E02 ErrorOccurrence envelope (E02 owns the
// schema, E04 owns what we store). Mapping is a pure table walk — first match wins, in the order written below — so
// identical input plus identical context yields byte-identical output: no clock, no randomness, no iteration order.
import { redactSecrets } from "../platform/redact.ts";
import { ERROR_LAYERS, ERROR_OCCURRENCE_VERSION, type ErrorLayer, type ErrorOccurrence } from "./errorEvent.ts";
export const UNKNOWN_ERROR_CODE = "unknown.unclassified"; // an unrecognised shape is recorded, never dropped
export const UNATTRIBUTED = "unattributed"; // caller gave no host/session/id — a durable sink must refuse it (E02)
const NON_PRINTABLE = /[^\x20-\x7e]+/g; const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/; const EPOCH = "1970-01-01T00:00:00Z";
type Severity = ErrorOccurrence["severity"];
export interface NormalizationContext { // timestamps arrive here — normalizeError never reads the clock
  timestamp: string; host: string; sessionId: string; runtime: string; correlationIds: string[]; runId?: string | null; taskId?: string | null;
  model?: string | null; quantization?: string | null; layer?: ErrorLayer; artifactRefs?: string[] } // derived refs; input evidence stays ahead of them
export interface UnknownErrorInput { // tolerant on purpose: every field optional, unknown fields allowed, nothing dropped
  kind?: string; type?: string; category?: string; message?: string; error?: string; detail?: string; text?: string; reason?: string; summary?: string; stderr?: string; signal?: string;
  code?: string | number; httpStatus?: number | string; status?: number | string; statusCode?: number | string; exitCode?: number | string; exit_status?: number | string;
  evidenceRef?: string; artifactRefs?: string[]; correlationIds?: string[]; [key: string]: unknown }
interface Signal { detail: string; status: number | null; exit: number | null; haystack: string }
const printable = (value: unknown, max: number): string => redactSecrets(typeof value === "string" ? value : value === null || value === undefined ? "" : String(value)).replace(NON_PRINTABLE, " ").trim().slice(0, max);
const numeric = (value: unknown): number | null => (/^-?\d+$/.test(printable(value, 24)) ? Number(printable(value, 24)) : null);
const storable = (ref: unknown): ref is string => typeof ref === "string" && ref.length > 0 && /^[\x20-\x7e]*$/.test(ref) && !ref.startsWith("/") && !/\s/.test(ref) && !ref.split("/").includes(".."); // E02 refuses absolute/blank/escaping refs, so never emit one
const RULES: Array<{ when: (s: Signal) => boolean; code: string; severity: Severity; layer: ErrorLayer; what: string }> = [ // most specific first; the last entry matches anything
  { when: (s) => s.haystack.includes("worker_result_missing") || /no structured result|missing (worker|structured) result|without a result|result (is|was) missing|finished with no result/.test(s.haystack), code: "worker.result_missing", severity: "error", layer: "worker", what: "worker finished without a structured result" },
  { when: (s) => /panic|sigsegv|sigabrt|sigill|sigbus|core dumped|oomkilled|out of memory|killed: 9/.test(s.haystack), code: "process.crash", severity: "fatal", layer: "process", what: "process crashed" },
  { when: (s) => s.exit !== null && s.exit !== 0, code: "tool.nonzero_exit", severity: "error", layer: "worker", what: "tool exited with a non-zero status" },
  { when: (s) => s.status === 429 || /rate.?limit|too many requests|overloaded|queue_saturated|retry after/.test(s.haystack), code: "gateway.429.rate_limited", severity: "warning", layer: "gateway", what: "upstream rate limit" },
  { when: (s) => s.status === 404 || /not found|no such (model|deployment|route)/.test(s.haystack), code: "gateway.404.not_found", severity: "error", layer: "gateway", what: "upstream returned not found" },
  { when: (s) => s.status === 400 || s.status === 413 || /no thinking match for model|bad request|invalid request|invalid argument|content policy|context (length|window)|prompt is too long|too many tokens/.test(s.haystack), code: "gateway.400.bad_request", severity: "error", layer: "gateway", what: "upstream rejected the request" },
  { when: (s) => (s.status !== null && s.status >= 500 && s.status < 600) || /bad gateway|service unavailable|internal server error|gateway timeout/.test(s.haystack), code: "gateway.5xx.upstream", severity: "error", layer: "gateway", what: "upstream server failure" },
  { when: (s) => /econnrefused|econnreset|eai_again|etimedout|enotfound|ehostunreach|enetunreach|epipe|socket hang up|connection (refused|reset|closed|lost)|fetch failed/.test(s.haystack), code: "network.connection_failed", severity: "warning", layer: "host", what: "network connection failed" },
  { when: (s) => /\btimed out\b|timeout|deadline exceeded/.test(s.haystack), code: "execution.timeout", severity: "error", layer: "worker", what: "operation timed out" },
  { when: () => true, code: UNKNOWN_ERROR_CODE, severity: "warning", layer: "process", what: "unclassified failure" },
];

export function normalizeError(input: UnknownErrorInput | unknown, ctx: NormalizationContext): ErrorOccurrence {
  let s: Signal = { haystack: "", status: null, exit: null, detail: "" }; let refs: string[] = []; let ids: string[] = []; const field = (value: unknown): string | null => printable(value, 200) || null; // evidence is read first, so an unreadable shape cannot lose it
  try {
    const raw = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : { message: String(input) };
    refs = [...(storable(raw.evidenceRef) ? [raw.evidenceRef] : []), ...(Array.isArray(raw.artifactRefs) ? raw.artifactRefs : [])].filter(storable);
    ids = [...new Set([...(Array.isArray(raw.correlationIds) ? raw.correlationIds : []), ...(Array.isArray(ctx.correlationIds) ? ctx.correlationIds : [])].map((id) => printable(id, 200)).filter((id) => id !== ""))].slice(0, 32);
    const msg = [raw.message, raw.error, raw.detail, raw.text, raw.reason, raw.summary].map((value) => printable(value, 400)).find((value) => value !== "") ?? "";
    const hints = [printable(raw.code, 40), printable(raw.signal, 40)].filter((part) => part !== ""); // errno or fatal signal: evidence worth reading, not just matching
    const haystack = [...new Set([printable(raw.kind ?? raw.type ?? raw.category, 80), ...hints, msg, printable(raw.stderr, 400)].filter((part) => part !== ""))].join(" ").toLowerCase(); // Set over strings: stable, first-write wins
    const status = numeric(raw.httpStatus ?? raw.status ?? raw.statusCode) ?? numeric(/(?:\b(?:https?|status|error|response)[^0-9a-z]{0,3}|^[^0-9a-z]{0,3})([45]\d\d)\b/i.exec(haystack)?.[1]);
    const exit = numeric(raw.exitCode ?? raw.exit_status); s = { haystack, status, exit, detail: [...new Set([status !== null ? `http ${status}` : "", exit !== null ? `exit ${exit}` : "", ...hints, msg, printable(raw.stderr, 400)].filter((part) => part !== ""))].join("; ") };
  } catch { /* a throwing getter is still an event: keep whatever evidence survived and record it under the unknown code */ }
  let rule = RULES[RULES.length - 1]!; for (const candidate of RULES) if (candidate.when(s)) { rule = candidate; break; } const stamp = printable(ctx.timestamp, 40); // the table ends in a catch-all, so walk order is precedence
  return {
    version: ERROR_OCCURRENCE_VERSION, timestamp: ISO_8601.test(stamp) ? stamp : EPOCH, host: printable(ctx.host, 200) || UNATTRIBUTED, sessionId: printable(ctx.sessionId, 200) || UNATTRIBUTED,
    runtime: printable(ctx.runtime, 200) || UNATTRIBUTED, layer: ctx.layer !== undefined && ERROR_LAYERS.includes(ctx.layer) ? ctx.layer : rule.layer, code: rule.code, severity: rule.severity,
    summary: printable(`${rule.what}${s.detail === "" ? "" : `: ${s.detail}`}`, 500) || rule.code, // redacted exactly the way E02 requires of a summary; the detail keeps the shape
    runId: field(ctx.runId), taskId: field(ctx.taskId), model: field(ctx.model), quantization: field(ctx.quantization), correlationIds: ids.length > 0 ? ids : [UNATTRIBUTED], // a gap is recorded, never invented
    artifactRefs: [...new Set([...refs, ...(Array.isArray(ctx.artifactRefs) ? ctx.artifactRefs : []).filter(storable)])], // original evidence first, unchanged
  };
}
```

## Full final source: `test/unit/error-normalize.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeError, UNKNOWN_ERROR_CODE, UNATTRIBUTED, type NormalizationContext, type UnknownErrorInput } from "../../src/incidents/errorNormalize.ts";
import { parseErrorOccurrence, type ErrorOccurrence } from "../../src/incidents/errorEvent.ts";

const EVIDENCE = "docs/specs/harness-reliability-bootstrap-20261103/E03/logs/01-verify.txt"; const DERIVED = "docs/specs/harness-reliability-bootstrap-20261103/E03/logs/99-derived.txt";
const CTX: NormalizationContext = { timestamp: "2026-11-04T09:00:00.000Z", host: "workstation", sessionId: "sess-e03", runtime: "pi-engineering@ba22f28",
  correlationIds: ["mission-msn-e03", "exec-4"], taskId: "E03", model: "metabolomics/qwen3.8-flash_next", quantization: null, artifactRefs: [DERIVED] };
const rows: Array<{ name: string; input: UnknownErrorInput; code: string; severity: ErrorOccurrence["severity"] }> = [ // the seven shapes the task names, plus network and crash
  { name: "429 rate limited", input: { kind: "http", httpStatus: 429, message: "Too Many Requests: queue_timeout after 3 attempts", evidenceRef: EVIDENCE }, code: "gateway.429.rate_limited", severity: "warning" },
  { name: "404 not found", input: { kind: "http", status: 404, message: "404 page not found", evidenceRef: EVIDENCE }, code: "gateway.404.not_found", severity: "error" },
  { name: "400 bad request", input: { kind: "http", httpStatus: 400, message: "no thinking match for model metabolomics/qwen3.8-flash_next", evidenceRef: EVIDENCE }, code: "gateway.400.bad_request", severity: "error" },
  { name: "5xx upstream", input: { kind: "http", message: "HTTP 503 Service Unavailable from the gateway", evidenceRef: EVIDENCE }, code: "gateway.5xx.upstream", severity: "error" },
  { name: "timeout", input: { kind: "timeout", message: "worker timed out after 900s waiting for the model", evidenceRef: EVIDENCE }, code: "execution.timeout", severity: "error" },
  { name: "non-zero exit status", input: { kind: "exit_status", exitCode: 3, stderr: "make: *** [verify] Error 2", evidenceRef: EVIDENCE }, code: "tool.nonzero_exit", severity: "error" },
  { name: "missing worker result", input: { kind: "worker_result_missing", message: "worker finished with no result", evidenceRef: EVIDENCE }, code: "worker.result_missing", severity: "error" },
  { name: "network failure", input: { kind: "network", code: "EAI_AGAIN", message: "fetch failed", evidenceRef: EVIDENCE }, code: "network.connection_failed", severity: "warning" },
  { name: "crash", input: { kind: "crash", signal: "SIGSEGV", message: "core dumped", evidenceRef: EVIDENCE }, code: "process.crash", severity: "fatal" },
];

test("each fixture maps to the demanded code and severity with a valid, non-empty summary", () => {
  for (const shape of ["429", "404", "400", "5xx", "timeout", "exit status", "missing worker result"]) assert.ok(rows.some((row) => row.name.includes(shape)), shape);
  for (const row of rows) { const event = normalizeError(row.input, CTX); const parsed = parseErrorOccurrence(event);
    assert.equal(event.code, row.code, row.name); assert.equal(event.severity, row.severity, row.name); assert.equal(parsed.ok, true, `${row.name}: ${parsed.ok ? "" : parsed.errors.join("|")}`);
    assert.ok(event.summary.length > 0 && event.summary.length <= 500, `${row.name}: ${event.summary}`); assert.equal(event.timestamp, CTX.timestamp); assert.ok(event.artifactRefs.includes(EVIDENCE), row.name); }
});

test("unrecognised or unreadable input becomes an explicit unknown event instead of throwing", () => {
  const hostile = { evidenceRef: EVIDENCE, get message(): string { throw new Error("hostile getter"); } };
  for (const junk of [undefined, null, 42, "boom", true, { unexpected: true }, [1, 2], hostile]) { const event = normalizeError(junk, CTX); assert.equal(event.code, UNKNOWN_ERROR_CODE); assert.equal(parseErrorOccurrence(event).ok, true); assert.ok(event.summary.length > 0); }
  assert.deepEqual(normalizeError(hostile, CTX).artifactRefs, [EVIDENCE, DERIVED]); // an unreadable shape still keeps the evidence it carried
});

test("the original evidence reference is preserved unchanged, ahead of the derived refs", () => {
  const http = normalizeError({ httpStatus: 429, message: "Too Many Requests", evidenceRef: EVIDENCE }, CTX);
  const exit = normalizeError({ exitCode: 3, stderr: "boom", artifactRefs: ["logs/exit.txt", "/etc/passwd", "../escape", "a b.txt"] }, CTX);
  assert.deepEqual(http.artifactRefs, [EVIDENCE, DERIVED]); assert.deepEqual(exit.artifactRefs, ["logs/exit.txt", DERIVED]); // E02 refuses absolute/escaping/spaced refs, so those are dropped
});

test("normalization is deterministic, clock-free, redacting and honest about missing attribution", () => {
  for (const row of rows) assert.deepEqual(normalizeError(row.input, CTX), normalizeError(row.input, CTX), row.name); // same input + same context => deep-equal
  const late = normalizeError(rows[0]!.input, { ...CTX, timestamp: "2027-01-01T00:00:00Z" }); assert.equal(late.code, rows[0]!.code); assert.equal(late.timestamp, "2027-01-01T00:00:00Z");
  const secret = normalizeError({ message: "auth failed https://user:hunter2hunter2@gw.example.com \x1b[2J" }, CTX); assert.ok(!secret.summary.includes("hunter2hunter2") && !secret.summary.includes("\x1b"), secret.summary);
  assert.equal(normalizeError({ message: "boom" }, { ...CTX, sessionId: "" }).sessionId, UNATTRIBUTED); // a gap is recorded, never invented or dropped
});
```
