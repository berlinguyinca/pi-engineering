import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventType, LedgerEvent } from "../../src/core/types.ts";
import { incidentFingerprint, toIncidentEventPayload } from "../../src/incidents/fingerprint.ts";
import type { AgentFailureIncident, IncidentClassification, IncidentRisk } from "../../src/incidents/types.ts";

function incident(overrides: Partial<AgentFailureIncident> = {}): AgentFailureIncident {
  const classification: IncidentClassification = "product_defect";
  const risk: IncidentRisk = "medium";
  return {
    incident_id: "inc_1",
    run_id: "run_1",
    repo: "owner/repo",
    revision: "abc123",
    worktree: "/work/tree-1",
    agent_role: "executor",
    failure_class: "test_failure",
    exit_code: 1,
    summary: "Expected the recovered session to remain active",
    artifact_refs: ["ledger://run_1", "artifact://tests/failure.log"],
    reproduction: "npm test -- session.test.ts",
    command: "node --test /work/tree-1/test/session.test.ts",
    root_cause: "AssertionError at /work/tree-1/src/session.ts:42:7",
    classification,
    risk,
    created_at: "2026-10-24T00:00:00Z",
    ...overrides,
  };
}

test("incidents-fingerprint: stable across volatile metadata and configured worktree paths", () => {
  const first = incident();
  const second = incident({
    incident_id: "inc_2",
    run_id: "run_2",
    repo: " Owner/Repo ",
    revision: "def456",
    worktree: "/tmp/tree-2/",
    command: "node --test /tmp/tree-2/test/session.test.ts",
    root_cause: "AssertionError at /tmp/tree-2/src/session.ts:42:7",
    summary: "Repeated failure",
    artifact_refs: ["artifact://tests/second.log"],
    created_at: "2026-10-25T12:30:00Z",
  });
  assert.equal(incidentFingerprint(first), incidentFingerprint(second));
  assert.equal(
    incidentFingerprint(first),
    incidentFingerprint(
      incident({
        command: "node --test test/session.test.ts",
        root_cause: "AssertionError at src/session.ts:42:7",
      }),
    ),
  );
  assert.match(incidentFingerprint(first), /^[0-9a-f]{16}$/);
});

test("incidents-fingerprint: different identity fields produce different fingerprints", () => {
  const original = incidentFingerprint(incident());
  for (const change of [
    { repo: "owner/other" },
    { failure_class: "tool_failure" },
    { command: "npm run build" },
    { root_cause: "TypeError at /work/tree-1/src/session.ts:42:7" },
    { root_cause: "AssertionError at /work/tree-1/src/other.ts:42:7" },
  ]) {
    assert.notEqual(incidentFingerprint(incident(change)), original, JSON.stringify(change));
  }
});

test("incidents-fingerprint: does not strip unconfigured paths or lookalike prefixes", () => {
  for (const path of ["/elsewhere/src/x.ts", "/work/tree-10/src/x.ts", "/prefix/work/tree-1/src/x.ts"]) {
    assert.notEqual(
      incidentFingerprint(incident({ root_cause: `Error at ${path}` })),
      incidentFingerprint(incident({ root_cause: "Error at src/x.ts" })),
    );
  }
  assert.notEqual(
    incidentFingerprint(incident({ root_cause: "Error at /elsewhere/src/x.ts" })),
    incidentFingerprint(incident({ root_cause: "Error at elsewhere/src/x.ts" })),
  );
});

test("incidents-fingerprint: treats the configured prefix literally in quoted paths", () => {
  const absolute = incident({
    worktree: "/tmp/tree[1]+/",
    command: 'node --test "/tmp/tree[1]+/test/a.ts" --cwd=/tmp/tree[1]+',
  });
  assert.equal(
    incidentFingerprint(absolute),
    incidentFingerprint({ ...absolute, command: 'node --test "test/a.ts" --cwd=.' }),
  );
});

test("incidents-fingerprint: normalizes shell delimiters and local file URLs", () => {
  const first = incident({
    command: "cd /work/tree-1; npm test",
    root_cause: "file:///work/tree-1/src/session.ts:42:7",
  });
  const second = incident({
    command: "cd .&& npm test",
    root_cause: "file://src/session.ts:42:7",
  });
  assert.equal(incidentFingerprint(first), incidentFingerprint(second));
});

test("incidents-fingerprint: preserves timestamps and meaningful whitespace within causes", () => {
  for (const [first, second] of [
    ["Invalid date 2026-10-24T00:00:00Z", "Invalid date 2026-10-25T00:00:00Z"],
    ['Expected "a  b"', 'Expected "a b"'],
  ]) {
    assert.notEqual(
      incidentFingerprint(incident({ root_cause: first })),
      incidentFingerprint(incident({ root_cause: second })),
    );
  }
});

test("incidents-fingerprint: payload is a JSON-safe versioned event with explicit fields", () => {
  const source = { ...incident(), raw_log: "must stay in artifacts", unexpected: 1n };
  const payload = toIncidentEventPayload(source);
  const eventType: EventType = "incident.detected";
  const ledgerPayload: LedgerEvent["payload"] = payload;
  assert.equal(eventType, "incident.detected");
  assert.deepEqual(ledgerPayload, {
    ...incident(),
    type: "agent_failure",
    schema_version: 1,
    fingerprint: incidentFingerprint(source),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  assert.notEqual(payload.artifact_refs, source.artifact_refs);
  payload.artifact_refs.push("artifact://new");
  assert.equal(source.artifact_refs.length, 2);
});

test("incidents-fingerprint: accepts bounded summaries and rejects blank or oversized summaries", () => {
  assert.equal(toIncidentEventPayload(incident({ summary: "x".repeat(1024) })).summary.length, 1024);
  for (const summary of ["", " \n\t", "x".repeat(1025)]) {
    assert.throws(() => toIncidentEventPayload(incident({ summary })), /summary/i);
  }
});

test("incidents-fingerprint: bounds artifact reference count and length", () => {
  const refs = Array.from({ length: 32 }, (_, i) => `artifact://${i}`);
  assert.deepEqual(toIncidentEventPayload(incident({ artifact_refs: refs })).artifact_refs, refs);
  assert.deepEqual(toIncidentEventPayload(incident({ artifact_refs: [] })).artifact_refs, []);
  assert.equal(toIncidentEventPayload(incident({ artifact_refs: ["x".repeat(2048)] })).artifact_refs[0]?.length, 2048);
  for (const artifact_refs of [[...refs, "artifact://extra"], ["x".repeat(2049)], [""]]) {
    assert.throws(() => toIncidentEventPayload(incident({ artifact_refs })), /artifact_refs/i);
  }
});

test("incidents-fingerprint: nullable exit status survives JSON and invalid numbers are rejected", () => {
  assert.equal(toIncidentEventPayload(incident({ exit_code: null })).exit_code, null);
  for (const exit_code of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => toIncidentEventPayload(incident({ exit_code })), /exit_code/i);
  }
});

test("incidents-fingerprint: rejects non-primitive fields and invalid classification or risk", () => {
  for (const change of [
    { summary: { text: "error" } },
    { root_cause: undefined },
    { command: () => "npm test" },
    { created_at: new Date() },
    { artifact_refs: [undefined] },
    { classification: "unrecognized" },
    { risk: "unrecognized" },
  ]) {
    assert.throws(() => toIncidentEventPayload({ ...incident(), ...change } as AgentFailureIncident));
  }
});

test("incidents-fingerprint: rejects blank identity fields and oversized compact fields", () => {
  for (const field of ["incident_id", "run_id", "repo", "failure_class", "command", "root_cause"]) {
    assert.throws(
      () => toIncidentEventPayload({ ...incident(), [field]: " \t" } as AgentFailureIncident),
      /must be nonblank/i,
    );
  }
  for (const field of ["reproduction", "command", "root_cause"]) {
    assert.throws(
      () => toIncidentEventPayload({ ...incident(), [field]: "x".repeat(2049) } as AgentFailureIncident),
      /at most/i,
    );
  }
});
