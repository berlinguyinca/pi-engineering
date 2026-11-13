# E02 Task Plan — Define Normalized Error Event Types

## Goal
Add a versioned `ErrorOccurrence` schema (session id, host, runtime, layer, model, quantization,
correlation ids, artifact refs), machine-parseable and safe to persist, with `incidents/types.ts`
left backward compatible.

## Scope
Files: `src/incidents/errorEvent.ts`, `test/unit/error-event.test.ts`. Budget: 2 files, <100 lines.

## Steps
1. Inventory the fields the harness can already produce at a failure point (`incidents/types.ts`
   `IncidentContext`, `sessionExecutionMetadata`, telemetry `TaskEvent`, `gatewayErrorToText`).
2. Add `src/incidents/errorEvent.ts`: `ERROR_OCCURRENCE_VERSION`, `ERROR_LAYERS`, `ERROR_SEVERITIES`,
   `ErrorOccurrence`, `parseErrorOccurrence()`.
3. Enforce on parse: session required, printable-ASCII summaries (no NUL/CR/LF/ANSI), summary must
   already be redacted (compared against `redactSecrets()`), ISO-8601 UTC timestamp, >=1 correlation
   id, repo-relative artifact refs only, known layer/severity/version. Absent optionals become null.
4. Tests: accepted occurrence keeps null dimensions; missing session refused; unredacted secret,
   control characters, absolute and `..` refs refused; unknown layer/severity/version/timestamp and
   empty correlation ids refused.

## Verification
- `npm run typecheck` → exit 0 (`logs/01-typecheck.txt`)
- `node --test --import ./test/support/isolatedState.ts test/unit/error-event.test.ts` → exit 0 (`logs/02`)
- Regression: incident + redaction suites → exit 0 (`logs/03`)
- Diff scope / budget → `logs/04-diff-scope.txt`
- Parent chain + plan at base, handoff stamping at the task commit, hash + schema check → `logs/05`,
  `logs/06`, `logs/07`; gate negative controls → `logs/08` (see TASK_REPORT.md findings)

## Decision — layer vocabulary
`ERROR_LAYERS` names the **harness subsystem that owns the failure** (`host`, `process`,
`session-store`, `aps`, `incident`, `retry`, `worker`, `gateway`, `verify`), not E01's telemetry
`kind` values (`inference`, `tool`, `provider`…). E01's kinds are signal channels; two of them
(`inference`, `tool`) have no owning subsystem and would have made the schema a dumping ground. E03
must map explicitly: provider/inference → `gateway` or `worker`, scheduler-window → `aps`,
incident-* → `incident`, and so on. This is recorded so E03 cannot silently widen the vocabulary.

## Boundaries
No change to `incidents/types.ts`, `IncidentStateMachine`, `TaskTelemetryBus`, the APS, or any
producer — E02 defines the type only; E03 emits it.
