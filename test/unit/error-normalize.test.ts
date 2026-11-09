import assert from "node:assert/strict";
import test from "node:test";
import { type ErrorOccurrence, parseErrorOccurrence } from "../../src/incidents/errorEvent.ts";
import {
  type NormalizationContext,
  UNATTRIBUTED,
  UNKNOWN_ERROR_CODE,
  type UnknownErrorInput,
  normalizeError,
} from "../../src/incidents/errorNormalize.ts";

const EVIDENCE = "docs/specs/harness-reliability-bootstrap-20261103/E03/logs/01-verify.txt";
const DERIVED = "docs/specs/harness-reliability-bootstrap-20261103/E03/logs/99-derived.txt";
const CTX: NormalizationContext = {
  timestamp: "2026-11-04T09:00:00.000Z",
  host: "workstation",
  sessionId: "sess-e03",
  runtime: "pi-engineering@ba22f28",
  correlationIds: ["mission-msn-e03", "exec-4"],
  taskId: "E03",
  model: "metabolomics/qwen3.8-flash_next",
  quantization: null,
  artifactRefs: [DERIVED],
};
const rows: Array<{ name: string; input: UnknownErrorInput; code: string; severity: ErrorOccurrence["severity"] }> = [
  // the seven shapes the task names, plus network and crash
  {
    name: "429 rate limited",
    input: {
      kind: "http",
      httpStatus: 429,
      message: "Too Many Requests: queue_timeout after 3 attempts",
      evidenceRef: EVIDENCE,
    },
    code: "gateway.429.rate_limited",
    severity: "warning",
  },
  {
    name: "404 not found",
    input: { kind: "http", status: 404, message: "404 page not found", evidenceRef: EVIDENCE },
    code: "gateway.404.not_found",
    severity: "error",
  },
  {
    name: "400 bad request",
    input: {
      kind: "http",
      httpStatus: 400,
      message: "no thinking match for model metabolomics/qwen3.8-flash_next",
      evidenceRef: EVIDENCE,
    },
    code: "gateway.400.bad_request",
    severity: "error",
  },
  {
    name: "5xx upstream",
    input: { kind: "http", message: "HTTP 503 Service Unavailable from the gateway", evidenceRef: EVIDENCE },
    code: "gateway.5xx.upstream",
    severity: "error",
  },
  {
    name: "timeout",
    input: { kind: "timeout", message: "worker timed out after 900s waiting for the model", evidenceRef: EVIDENCE },
    code: "execution.timeout",
    severity: "error",
  },
  {
    name: "non-zero exit status",
    input: { kind: "exit_status", exitCode: 3, stderr: "make: *** [verify] Error 2", evidenceRef: EVIDENCE },
    code: "tool.nonzero_exit",
    severity: "error",
  },
  {
    name: "missing worker result",
    input: { kind: "worker_result_missing", message: "worker finished with no result", evidenceRef: EVIDENCE },
    code: "worker.result_missing",
    severity: "error",
  },
  {
    name: "network failure",
    input: { kind: "network", code: "EAI_AGAIN", message: "fetch failed", evidenceRef: EVIDENCE },
    code: "network.connection_failed",
    severity: "warning",
  },
  {
    name: "crash",
    input: { kind: "crash", signal: "SIGSEGV", message: "core dumped", evidenceRef: EVIDENCE },
    code: "process.crash",
    severity: "fatal",
  },
];

test("each fixture maps to the demanded code and severity with a valid, non-empty summary", () => {
  for (const shape of ["429", "404", "400", "5xx", "timeout", "exit status", "missing worker result"])
    assert.ok(
      rows.some((row) => row.name.includes(shape)),
      shape,
    );
  for (const row of rows) {
    const event = normalizeError(row.input, CTX);
    const parsed = parseErrorOccurrence(event);
    assert.equal(event.code, row.code, row.name);
    assert.equal(event.severity, row.severity, row.name);
    assert.equal(parsed.ok, true, `${row.name}: ${parsed.ok ? "" : parsed.errors.join("|")}`);
    assert.ok(event.summary.length > 0 && event.summary.length <= 500, `${row.name}: ${event.summary}`);
    assert.equal(event.timestamp, CTX.timestamp);
    assert.ok(event.artifactRefs.includes(EVIDENCE), row.name);
  }
});

test("unrecognised or unreadable input becomes an explicit unknown event instead of throwing", () => {
  const hostile = {
    evidenceRef: EVIDENCE,
    get message(): string {
      throw new Error("hostile getter");
    },
  };
  for (const junk of [undefined, null, 42, "boom", true, { unexpected: true }, [1, 2], hostile]) {
    const event = normalizeError(junk, CTX);
    assert.equal(event.code, UNKNOWN_ERROR_CODE);
    assert.equal(parseErrorOccurrence(event).ok, true);
    assert.ok(event.summary.length > 0);
  }
  assert.deepEqual(normalizeError(hostile, CTX).artifactRefs, [EVIDENCE, DERIVED]); // an unreadable shape still keeps the evidence it carried
});

test("the original evidence reference is preserved unchanged, ahead of the derived refs", () => {
  const http = normalizeError({ httpStatus: 429, message: "Too Many Requests", evidenceRef: EVIDENCE }, CTX);
  const exit = normalizeError(
    { exitCode: 3, stderr: "boom", artifactRefs: ["logs/exit.txt", "/etc/passwd", "../escape", "a b.txt"] },
    CTX,
  );
  assert.deepEqual(http.artifactRefs, [EVIDENCE, DERIVED]);
  assert.deepEqual(exit.artifactRefs, ["logs/exit.txt", DERIVED]); // E02 refuses absolute/escaping/spaced refs, so those are dropped
});

test("normalization is deterministic, clock-free, redacting and honest about missing attribution", () => {
  for (const row of rows) assert.deepEqual(normalizeError(row.input, CTX), normalizeError(row.input, CTX), row.name); // same input + same context => deep-equal
  const late = normalizeError(rows[0]!.input, { ...CTX, timestamp: "2027-01-01T00:00:00Z" });
  assert.equal(late.code, rows[0]!.code);
  assert.equal(late.timestamp, "2027-01-01T00:00:00Z");
  const secret = normalizeError({ message: "auth failed https://user:hunter2hunter2@gw.example.com \x1b[2J" }, CTX);
  assert.ok(!secret.summary.includes("hunter2hunter2") && !secret.summary.includes("\x1b"), secret.summary);
  assert.equal(normalizeError({ message: "boom" }, { ...CTX, sessionId: "" }).sessionId, UNATTRIBUTED); // a gap is recorded, never invented or dropped
});
