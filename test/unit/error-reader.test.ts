// D01: a read-only merged error index over ONE namespace — filters open no writer, mutate no byte, create no file, and never mistake a foreign or malformed record for an occurrence.
import assert from "node:assert/strict"; import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path"; import test, { after } from "node:test";
import { ERROR_OCCURRENCE_VERSION, type ErrorOccurrence } from "../../src/incidents/errorEvent.ts"; import { readHostErrorOccurrences } from "../../src/incidents/errorReader.ts";
import { SessionEventStore } from "../../src/runtime/isolation/SessionEventStore.ts"; import { createSessionErrorWriter, ERROR_OCCURRENCE_EVENT_TYPE } from "../../src/runtime/isolation/SessionErrorWriter.ts";
const ROOT = mkdtempSync(join(tmpdir(), "pi-eng-d01-")); after(() => rmSync(ROOT, { recursive: true, force: true })); // one temp root; a recovery/ quarantine dir would land beside it
const occ = (over: Partial<ErrorOccurrence> = {}): ErrorOccurrence => ({ version: ERROR_OCCURRENCE_VERSION, timestamp: "2026-11-01T00:00:00Z", host: "host-a", sessionId: "sess-a", runtime: "pi-engineering@abc", layer: "host", code: "host.read_denied", severity: "error", summary: "read denied", runId: null, taskId: null, model: null, quantization: null, correlationIds: ["mission-d01"], artifactRefs: [], ...over });
const writer = (dir: string, sessionId: string) => createSessionErrorWriter(SessionEventStore.open({ eventsDir: dir, sessionId, worktreeId: "wt" }), { projectId: "pi" });
const codes = (dir: string, filter = {}) => readHostErrorOccurrences(dir, filter).occurrences.map((o) => o.occurrence.code); // the index as codes, so assertions read as filter intent
const snap = (dir: string): string => readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).map((entry) => entry.isDirectory() ? `${entry.name}/:${snap(join(dir, entry.name))}` : `${entry.name}:${createHash("sha256").update(readFileSync(join(dir, entry.name))).digest("hex")}`).join("|"); // names + content hashes, one level deep included: any lock, recovery/ or new stream shows up here
const build = async (dir: string) => { // a real namespace: two sessions' streams, one foreign incident event on A, one corrupt line written as raw bytes onto B
  const a = writer(dir, "sess-a"); const b = writer(dir, "sess-b");
  await a.recordMany([occ(), occ({ timestamp: "2026-11-03T00:00:00Z", code: "host.disk_full", summary: "disk full" })]);
  await b.recordMany([occ({ sessionId: "sess-b", host: "host-b", timestamp: "2026-11-02T00:00:00Z", code: "process.crash", severity: "fatal", summary: "process crashed" })]);
  await a.store.append({ event_id: "inc-1", timestamp: "2026-11-02T12:00:00Z", type: "incident.detected", project_id: "pi", run_id: null, worker_id: null, payload: { fingerprint: "f" } });
  appendFileSync(join(dir, "sess-b.jsonl"), "{ not json\n"); a.store.close(); b.store.close(); return dir;
};
test("every filter combination leaves the namespace byte- and name-identical, proving no writer was opened", async () => { // criterion 1
  const dir = await build(join(ROOT, "evidence")); const before = snap(dir); const names = readdirSync(dir).sort();
  const filters = [{}, { since: "2026-11-02T00:00:00Z" }, { until: "2026-11-02T23:59:59Z" }, { since: "2026-11-01T00:00:00Z", until: "2026-11-02T00:00:00Z" }, { host: "host-b" }, { sessionId: "sess-a" }, { host: "host-b", sessionId: "sess-b" }, { since: "2026-11-01T00:00:00Z", until: "2026-11-03T00:00:00Z", host: "host-a", sessionId: "sess-a", limit: 1 }, { limit: 1 }, { limit: 99 }];
  for (const filter of filters) readHostErrorOccurrences(dir, filter);
  assert.equal(snap(dir), before, `no byte of any stream changed and no file appeared or vanished across ${filters.length} filtered reads`);
  assert.deepEqual(readdirSync(dir).sort(), names); assert.equal(names.length, 2, "only the two streams: no new <id>.jsonl, no lock, no recovery dir");
  assert.equal(readdirSync(ROOT).sort().includes("recovery"), false, "quarantine was never reached");
});
test("time, host, session and limit filters select exactly what they say", async () => { // criterion 2
  const dir = await build(join(ROOT, "filters"));
  assert.deepEqual(codes(dir), ["host.read_denied", "process.crash", "host.disk_full"], "ordered by timestamp, then event_id");
  assert.deepEqual(codes(dir, { since: "2026-11-02T00:00:00Z", until: "2026-11-02T23:59:59Z" }), ["process.crash"], "the window excludes out-of-range occurrences");
  assert.deepEqual(codes(dir, { host: "host-b" }), ["process.crash"], "host comes from the occurrence itself");
  assert.deepEqual(codes(dir, { sessionId: "sess-a" }), ["host.read_denied", "host.disk_full"], "only that session's occurrences");
  assert.equal(codes(dir, { sessionId: "sess-b" }).length, 1); assert.deepEqual(readHostErrorOccurrences(dir, { sessionId: "sess-a" }).occurrences.map((o) => o.occurrence.sessionId), ["sess-a", "sess-a"], "no other session leaks through the filter");
  const cut = readHostErrorOccurrences(dir, { limit: 2 }); assert.equal(cut.occurrences.length, 2, "limit truncates"); assert.equal(cut.truncated, true); assert.equal(readHostErrorOccurrences(dir, { limit: 3 }).truncated, false, "no truncation when the cap covers every match");
});
test("foreign types, corrupt lines and payloads E02 refuses are skipped and counted; order is deterministic", async () => { // criterion 3
  const dir = await build(join(ROOT, "counts")); const first = readHostErrorOccurrences(dir);
  assert.deepEqual(first.skipped, { foreignType: 1, corrupt: 1, unparsable: 0 }, JSON.stringify(first.skipped)); assert.deepEqual([first.scannedStreams, first.scannedEvents], [2, 4], "three occurrences + one incident event scanned, the corrupt line is no event");
  assert.equal(readHostErrorOccurrences(dir, { sessionId: "sess-none" }).occurrences.length, 0, "a session nobody wrote about is empty, not an error"); assert.deepEqual(readHostErrorOccurrences(dir), first, "two runs agree exactly, so ordering is deterministic");
  appendFileSync(join(dir, "sess-a.jsonl"), `${JSON.stringify({ event_id: "err-bad", timestamp: "2026-11-04T00:00:00Z", type: ERROR_OCCURRENCE_EVENT_TYPE, project_id: null, run_id: null, worker_id: null, payload: { version: 99 } })}\n`); // a payload E02 no longer admits
  assert.deepEqual(readHostErrorOccurrences(dir).skipped, { foreignType: 1, corrupt: 1, unparsable: 1 }, "refused on read, never repaired");
});
test("a nonexistent or empty namespace reads as the documented empty result and creates nothing", async () => { // criterion 4
  const dir = await build(join(ROOT, "present")); const missing = join(ROOT, "absent", "events"); const rootNames = readdirSync(ROOT).sort(); const empty = mkdtempSync(join(tmpdir(), "pi-eng-d01-empty-"));
  assert.deepEqual(readHostErrorOccurrences(missing), { namespaceDir: missing, refused: "missing", occurrences: [], scannedStreams: 0, scannedEvents: 0, skipped: { foreignType: 0, corrupt: 0, unparsable: 0 }, truncated: false });
  assert.deepEqual([readHostErrorOccurrences("relative/events").refused, readHostErrorOccurrences(join(dir, "sess-a.jsonl")).refused], ["not-absolute", "not-a-directory"], "obviously wrong input is refused, never walked");
  assert.deepEqual(readHostErrorOccurrences(empty).occurrences, []); assert.equal(readdirSync(empty).length, 0, "an empty namespace stays empty");
  assert.throws(() => statSync(join(ROOT, "absent"))); assert.deepEqual(readdirSync(ROOT).sort(), rootNames, "the refused reads created no directory, stream, lock or recovery file");
});
