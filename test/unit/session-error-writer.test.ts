// E05: an occurrence is an ordinary event on its OWN session's stream — sanitized on the way in, isolated per session, readable after a reopen, idempotent per occurrence, and never mistaken for an incident event.
import assert from "node:assert/strict"; import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path"; import test, { after } from "node:test";
import { sanitizeForPersistence } from "../../src/incidents/errorSanitize.ts"; import { ERROR_OCCURRENCE_VERSION, type ErrorOccurrence } from "../../src/incidents/errorEvent.ts";
import { readMergedEvents, SessionEventStore } from "../../src/runtime/isolation/SessionEventStore.ts"; import { createSessionErrorWriter, ERROR_OCCURRENCE_EVENT_TYPE, type SessionErrorWriter } from "../../src/runtime/isolation/SessionErrorWriter.ts";
const SECRET = "sk-proj-YWJjZGVmZ2hpamtsbW5vcA"; const ROOT = mkdtempSync(join(tmpdir(), "pi-eng-e05-")); after(() => rmSync(ROOT, { recursive: true, force: true })); // the one temp root, removed at exit
const occ = (over: Partial<ErrorOccurrence> = {}): ErrorOccurrence => ({ version: ERROR_OCCURRENCE_VERSION, timestamp: "2026-11-04T09:00:00.000Z", host: "workstation", sessionId: "sess-a", runtime: "pi-engineering@abc", layer: "gateway", code: "gateway.429.rate_limited", severity: "warning", summary: "upstream rate limit", runId: "run-1", taskId: "T1", model: null, quantization: null, correlationIds: ["mission-msn-e05"], artifactRefs: ["logs/run-1.jsonl"], ...over });
const writer = (dir: string, sessionId: string): SessionErrorWriter => createSessionErrorWriter(SessionEventStore.open({ eventsDir: dir, sessionId, worktreeId: "wt" }), { projectId: "pi" });
const raw = (dir: string, sessionId: string): Array<Record<string, any>> => readFileSync(join(dir, `${sessionId}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line)); // the stream as bytes-on-disk, envelope included
const sorted = (values: string[]): string[] => [...values].sort(); // merged order is by timestamp, so these compare content, not order
test("two sessions appending concurrently keep their streams isolated while readers see both", async () => {
  const dir = join(ROOT, "concurrent"); const a = writer(dir, "sess-a"); const b = writer(dir, "sess-b"); // one writer per session, same namespace
  const [mine, theirs] = await Promise.all([a.recordMany([occ(), occ({ code: "execution.timeout", layer: "worker", summary: "operation timed out", taskId: "T2" })]),
    b.recordMany([occ({ sessionId: "sess-b", code: "worker.result_missing", layer: "worker", summary: "worker finished without a structured result" }), occ({ sessionId: "sess-b", code: "process.crash", layer: "process", severity: "fatal", summary: "process crashed", taskId: null })])]);
  assert.deepEqual(sorted(raw(dir, "sess-a").map((l) => l.event_id)), sorted(mine.map((e) => e!.event_id)), "A's stream holds only A's occurrences"); assert.deepEqual(sorted(raw(dir, "sess-b").map((l) => l.event_id)), sorted(theirs.map((e) => e!.event_id)), "B's stream holds only B's occurrences"); // criterion 1
  assert.deepEqual(raw(dir, "sess-a").map((l) => l.session_id), ["sess-a", "sess-a"], "the envelope session is the store's, never the payload's"); assert.deepEqual(sorted(readMergedEvents(dir).map((e) => e.event_id)), sorted([...mine, ...theirs].map((e) => e!.event_id)), "the merged view shows both streams");
  assert.deepEqual(sorted(a.listOccurrences().map((o) => o.code)), sorted(["gateway.429.rate_limited", "execution.timeout", "worker.result_missing", "process.crash"]), "listOccurrences reads the whole namespace"); a.store.close(); b.store.close();
});

test("an occurrence survives drain + close + reopen with a deep-equal payload", async () => {
  const dir = join(ROOT, "reopen"); const first = writer(dir, "sess-a"); const input = occ({ summary: "upstream refused twice" }); // criterion 2
  assert.ok((await first.record(input)) !== null); await first.store.drain(); first.store.close();
  const again = writer(dir, "sess-a"); // a fresh store over the same eventsDir, as a reopened session would open it
  assert.deepEqual(again.listOccurrences(), [sanitizeForPersistence(input)], "the payload round-trips unchanged"); assert.equal(again.store.count(), 1); again.store.close();
});

test("the secret an occurrence carries never reaches the bytes on disk", async () => {
  const dir = join(ROOT, "secret"); const w = writer(dir, "sess-a"); const written = await w.record(occ({ summary: `upstream refused: key=${SECRET}` })); // criterion 3
  assert.ok(written !== null && String(written.payload.summary).includes("[REDACTED]"), JSON.stringify(written));
  const bytes = readFileSync(join(dir, "sess-a.jsonl")); // the raw stream file, not the parsed view
  assert.equal(bytes.includes(SECRET), false, bytes.toString("utf8")); assert.equal(w.listOccurrences()[0]!.summary.includes(SECRET), false); w.store.close();
});

test("occurrences stay apart from incident events, carry the fingerprint, and map scope honestly", async () => {
  const dir = join(ROOT, "foreign"); const a = writer(dir, "sess-a"); const other = SessionEventStore.open({ eventsDir: dir, sessionId: "sess-b", worktreeId: "wt" }); // criterion 4
  const written = await a.record(occ()); assert.ok(written !== null);
  await other.append({ event_id: "inc-1", timestamp: "2026-11-04T09:00:01.000Z", type: "incident.detected", project_id: "pi", run_id: "run-1", worker_id: null, payload: { incident_id: "inc-1", fingerprint: "0123456789abcdef" } });
  assert.equal(a.listOccurrences().length, 1, "an incident event on the same namespace is not an occurrence"); assert.equal(written.type, ERROR_OCCURRENCE_EVENT_TYPE); assert.match(String(written.payload.fingerprint), /^[0-9a-f]{16}$/);
  assert.deepEqual([written.project_id, written.run_id, written.worker_id], ["pi", "run-1", "T1"], "scope first, else the occurrence's own run/task ids");
  const twin = await createSessionErrorWriter(other, { projectId: "pi" }).record(occ()); // one failure, two sessions: two events, one incident identity
  assert.ok(twin !== null); assert.notEqual(twin.event_id, written.event_id); assert.equal(twin.payload.fingerprint, written.payload.fingerprint); assert.equal(a.listOccurrences().length, 2); a.store.close(); other.close();
});

test("recording the same occurrence twice writes one line, and a refusal E04 makes writes nothing", async () => {
  const dir = join(ROOT, "idem"); const w = writer(dir, "sess-a"); const first = await w.record(occ()); const retry = await w.record(occ()); // criterion 5
  assert.equal(retry?.event_id, first?.event_id, "event_id is a digest of the sanitized payload plus scope"); assert.equal(raw(dir, "sess-a").length, 1, "the retry hit the store's dedup guard instead of landing a second line"); assert.equal(w.store.count(), 1);
  assert.deepEqual(await w.recordMany([null, "not an occurrence", [1]]), [null, null, null], "E04 refuses non-occurrences"); assert.equal(raw(dir, "sess-a").length, 1, "a refusal adds nothing to the stream");
  assert.ok((await w.record(occ({ code: "execution.timeout", layer: "worker", summary: "operation timed out" }))) !== null); assert.equal(raw(dir, "sess-a").length, 2, "a distinct occurrence still lands"); w.store.close();
});
