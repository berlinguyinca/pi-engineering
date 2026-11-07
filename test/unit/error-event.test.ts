import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_OCCURRENCE_VERSION, parseErrorOccurrence } from "../../src/incidents/errorEvent.ts";

const valid = { version: ERROR_OCCURRENCE_VERSION, timestamp: "2026-11-03T12:00:00.000Z", host: "workstation",
  sessionId: "sess-7c1", runtime: "pi-engineering@0cc5b21c", layer: "retry", severity: "warning",
  code: "inference.429.queue_timeout", summary: "gateway held the request: 429 queue_timeout after 3 attempts",
  runId: null, taskId: "E02", model: "claude-x", quantization: null, correlationIds: ["mission-msn-1", "exec-9"],
  artifactRefs: ["docs/specs/harness-reliability-bootstrap-20261103/E01/logs/01-verify-git-diff-check.txt"] };
const errorsOf = (patch: Record<string, unknown>): string => { const r = parseErrorOccurrence({ ...valid, ...patch }); return r.ok ? "" : r.errors.join("|"); };

test("accepts a fully attributed occurrence; absent optionals stay null", () => {
  const result = parseErrorOccurrence(valid);
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.event.sessionId, "sess-7c1"); assert.equal(result.event.runId, null); assert.deepEqual(result.event.correlationIds, ["mission-msn-1", "exec-9"]); }
});

test("an occurrence with no session is refused — unattributable errors are not recordable", () => {
  const missing = { ...valid } as Record<string, unknown>; delete missing.sessionId;
  assert.deepEqual(parseErrorOccurrence(missing), { ok: false, errors: ["sessionId: expected a non-empty printable string"] });
  assert.equal(parseErrorOccurrence({ ...valid, sessionId: "" }).ok, false);
});

test("rejects unredacted secrets, control characters and unsafe artifact refs", () => {
  assert.match(errorsOf({ summary: "fetch failed https://user:hunter2hunter2@example.com" }), /unredacted secret/);
  assert.match(errorsOf({ summary: "boom\x1b[2J" }), /printable/);
  assert.match(errorsOf({ summary: "boom\n\r" }), /printable/);
  assert.match(errorsOf({ artifactRefs: ["/etc/passwd"] }), /relative artifact path/);
  assert.match(errorsOf({ artifactRefs: ["../../secrets"] }), /relative artifact path/);
});

test("requires correlation and validates layer, severity, version, timestamp", () => {
  assert.match(errorsOf({ correlationIds: [] }), /at least 1 entry/);
  assert.match(errorsOf({ layer: "scheduler-window" }), /layer: expected one of/); // E01 trace layers are not schema layers
  assert.match(errorsOf({ severity: "catastrophic" }), /severity: expected one of/);
  assert.match(errorsOf({ timestamp: "yesterday" }), /ISO-8601/);
  assert.equal(parseErrorOccurrence({ ...valid, version: 2 }).ok, false);
  assert.equal(parseErrorOccurrence(null).ok, false);
});
