// E06: one worker failure, ONE sanitized occurrence, captured at exactly one seam — and a capture that cannot change the outcome it records.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { type ErrorOccurrence, parseErrorOccurrence } from "../../src/incidents/errorEvent.ts";
import { sanitizeForPersistence } from "../../src/incidents/errorSanitize.ts";
import { setTelemetrySink } from "../../src/telemetry/sink.ts";
import {
  type ErrorOccurrenceWriter,
  type WorkerFailureContext,
  recordWorkerFailure,
  workerFailureContext,
  workerFailureOccurrence,
} from "../../src/workers/PiWorkerExecutor.ts";
const SECRET = "sk-proj-YWJjZGVmZ2hpamtsbW5vcHFyc3R1";
const PATH = "/Users/dev/IdeaProjects/pi-engineering-runtime/src/app.ts";
const STAMP = "2026-11-04T09:00:00.000Z";
const ctx = (over: Partial<WorkerFailureContext> = {}): WorkerFailureContext => ({
  sessionId: "sess-e06",
  role: "implementer",
  model: "metabolomics/qwen3.8-flash_next-modality-text-quant-w3a8",
  quantization: "w3a8",
  runId: "run-9",
  taskId: "E06",
  host: "workstation",
  timestamp: STAMP,
  correlationIds: ["run:run-9"],
  ...over,
}); // a timestamp is injected because E03 owns stamps: the builder reads no clock
const providerError = () =>
  Object.assign(new Error(`cut stream: 503 Service Unavailable from https://llm.example.com key=${SECRET}`), {
    status: 503,
  }); // the two shapes the audited seam can see:
const toolException = () =>
  Object.assign(new Error(`ENOENT: no such file or directory, open '${PATH}' with key=${SECRET}`), {
    code: "ENOENT",
    toolName: "read",
  }); // a cut stream ending in 503, and a tool exception naming its tool
const naked = (occ: ErrorOccurrence | null): ErrorOccurrence => {
  assert.ok(occ !== null, "capture lost an occurrence carrying full identity");
  const parsed = parseErrorOccurrence(occ);
  assert.ok(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.errors));
  return parsed.event;
}; // E02 says the record is well-formed
test("an injected provider failure emits one valid occurrence carrying session, role and model identity", () => {
  const occ = naked(workerFailureOccurrence(ctx(), providerError())); // criterion 1
  assert.deepEqual(
    [occ.sessionId, occ.model, occ.quantization, occ.runId, occ.taskId, occ.host],
    ["sess-e06", "metabolomics/qwen3.8-flash_next-modality-text-quant-w3a8", "w3a8", "run-9", "E06", "workstation"],
    "the identity handed to the seam is the identity recorded",
  );
  assert.deepEqual(
    [occ.code, occ.layer, occ.severity],
    ["gateway.5xx.upstream", "gateway", "error"],
    "E03 names the layer the failure genuinely belongs to; the seam relabels nothing",
  );
  assert.match(occ.summary, /implementer worker failed/, "E02 has no role field, so the role rides in the summary");
  assert.deepEqual(occ.correlationIds, ["run:run-9"]); // E02's correlation rule
});
test("a tool exception is captured too, and neither the secret nor the absolute path survives the seam", () => {
  const occ = naked(workerFailureOccurrence(ctx(), toolException())); // criterion 1, tool half: an unmapped throw is still recorded, under this seam's own layer
  assert.deepEqual([occ.code, occ.layer], ["unknown.unclassified", "worker"]);
  assert.match(occ.summary, /implementer tool read failed/);
  assert.match(occ.summary, /<path>/);
  for (const error of [providerError(), toolException()]) {
    const json = JSON.stringify(naked(workerFailureOccurrence(ctx(), error))); // criterion 1, leak half
    assert.equal(json.includes(SECRET), false, json);
    assert.equal(json.includes("/Users/dev"), false, json);
    assert.equal(json.includes("IdeaProjects"), false, json);
  }
});
test("the builder is pure: the same identity plus the same failure give a deep-equal occurrence", () => {
  const a = workerFailureOccurrence(ctx(), providerError());
  const b = workerFailureOccurrence(ctx(), providerError());
  assert.deepEqual(a, b, "no clock, no randomness, no session state");
  const late = workerFailureOccurrence(ctx({ timestamp: "2026-11-04T10:00:00Z" }), providerError()); // an injected clock moves one field only, and that field is the timestamp
  assert.equal(late!.timestamp, "2026-11-04T10:00:00Z");
  assert.deepEqual({ ...late!, timestamp: "" }, { ...a!, timestamp: "" });
});
test("the emitter hands the writer exactly one occurrence per failure, and says whether it was kept", async () => {
  const seen: unknown[] = [];
  const writer: ErrorOccurrenceWriter = {
    record: async (input) => {
      seen.push(input);
      return { event_id: "err-1" };
    },
  }; // criterion 2
  assert.equal(await recordWorkerFailure(writer, ctx(), providerError()), true);
  assert.equal(seen.length, 1, "one failure, one capture");
  assert.ok(parseErrorOccurrence(seen[0]).ok, "what reaches E05 is an E02 occurrence");
  assert.equal(await recordWorkerFailure(undefined, ctx(), providerError()), false, "capture not armed (the default)");
  assert.equal(seen.length, 1, "no writer, no work, no behaviour change");
});
test("a writer that throws or refuses cannot change the outcome, and each swallow is reported once", async () => {
  const notices: string[] = [];
  const restore = setTelemetrySink((notice) => notices.push(notice.text)); // the EXISTING channel, observed rather than printed
  try {
    let calls = 0;
    const boom: ErrorOccurrenceWriter = {
      record: async () => {
        calls++;
        throw new Error("session store closed");
      },
    }; // criterion 2, swallow half: nothing throws, nothing runs twice, the return value says what happened
    assert.equal(
      await recordWorkerFailure(boom, ctx(), toolException()),
      false,
      "the swallow is a return value, never an exception into the failure path",
    );
    assert.equal(calls, 1, "capture retries nothing: one attempt per failure");
    let refusals = 0;
    const refusing: ErrorOccurrenceWriter = {
      record: async (input) => {
        refusals++;
        assert.ok(sanitizeForPersistence(input) !== null);
        return null;
      },
    }; // E05's own refusal answer
    assert.equal(
      await recordWorkerFailure(refusing, ctx(), providerError()),
      false,
      "a refused occurrence is a false, not a throw",
    );
    assert.equal(refusals, 1);
    assert.deepEqual(
      notices,
      ["worker failure capture threw (implementer)", "worker failure capture was refused (implementer)"],
      "each swallow speaks exactly once, on the channel that already existed",
    );
  } finally {
    restore();
  }
});
test("the seam derives identity from the live request and the model id it carries", () => {
  const c = workerFailureContext(
    { role: "reviewer", sessionId: "sess-77", missionId: "MSN-1", runId: "run-3", workItemId: "E06" } as never,
    { provider: "metabolomics", id: "qwen3.8-flash_next-modality-text-quant-w3a8" } as never,
    2,
  );
  assert.deepEqual(
    [c.sessionId, c.role, c.model, c.quantization, c.runId, c.taskId, c.correlationIds],
    [
      "sess-77",
      "reviewer",
      "metabolomics/qwen3.8-flash_next-modality-text-quant-w3a8",
      "w3a8",
      "run-3",
      "E06",
      ["mission:MSN-1", "run:run-3", "task:E06"],
    ],
  );
});
test("the capture call exists exactly once, inside the audited terminal failure path", () => {
  // STRUCTURAL, not behavioural: the file is the subject, so a second seam cannot appear unnoticed (see docs/specs/.../01-ARCHITECTURE-AND-AUDIT.md)
  const src = readFileSync(new URL("../../src/workers/PiWorkerExecutor.ts", import.meta.url), "utf8");
  const seam = src.indexOf("void recordWorkerFailure(");
  const capture = src.indexOf("// Capture the error.");
  assert.equal(src.match(/void recordWorkerFailure\(/g)?.length, 1, "exactly one capture site in the whole executor");
  assert.ok(capture > 0, "the audited catch is still there to anchor the seam");
  assert.ok(
    seam > capture && seam < src.indexOf("} finally {", capture),
    "the call sits inside that catch, before its finally",
  );
  assert.ok(
    seam > src.indexOf("private async runSingleAttempt(") && seam < src.indexOf("private createApsAdapter("),
    "and inside runSingleAttempt alone",
  );
  assert.equal(
    src.split("promptError = err;").length - 1,
    1,
    "that catch is the only place a terminal prompt error is recorded",
  );
});
