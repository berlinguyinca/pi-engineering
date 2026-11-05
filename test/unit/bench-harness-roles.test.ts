/** V04 is proved entirely offline: no network, no endpoint, no env-supplied model. Every replay call below is an
 * injected spy — the script imports no provider or client, so no live call can originate inside it. */
import assert from "node:assert/strict"; import { test } from "node:test";
import { buildPlan, main, resolveModel, runReplan, type Replay, type ReplayEntry } from "../../scripts/bench-harness-roles.ts";
import { compareRuns, validateRunRecord } from "../../src/capability/quantBenchmark.ts";
const AVAILABLE = ["google/gemini-3-flash", "operator/qwen3.6-flash-lite"]; const TASKS = [{ id: "t1" }, { id: "t2" }];
const LIVE = { dryRun: false, enabled: true, env: { BENCH_HARNESS_ROLES: "1" } }; // BOTH opt-ins together
const CALLS: string[] = []; const spy: Replay = (entry) => { CALLS.push(`${entry.taskId}/${entry.role}`); return { requestId: `req-${CALLS.length}` }; };
const complete = (e: ReplayEntry) => ({ ...e, weightsHash: "sha256:weights", baseSha: "base123", outcome: "completed" as const, latencyMs: 1 });
test("the default path is a dry run: the injected replay spy is never called", async () => {
  CALLS.length = 0; const dry = await runReplan({ available: AVAILABLE, requested: ["gemini-3-flash"], roles: ["minimal"], tasks: TASKS, replay: spy });
  assert.equal(dry.dryRun, true); assert.deepEqual(CALLS, []); assert.deepEqual(dry.entries.map((e) => e.status), ["planned", "planned"]);
  const half = await runReplan({ available: AVAILABLE, requested: ["gemini-3-flash"], roles: ["minimal"], tasks: TASKS, ...LIVE, enabled: false, replay: spy }); assert.equal(half.dryRun, true); assert.deepEqual(CALLS, []); // one opt-in alone never goes live
});
test("an unavailable requested model is skipped with a reason naming that model id", async () => {
  const entry = (await runReplan({ available: AVAILABLE, requested: ["gemini-3.5-flash"], roles: ["full"], tasks: [TASKS[0]!] })).entries[0]!;
  assert.equal(entry.status, "skipped"); assert.equal(entry.reason, "gemini-3.5-flash is not among the available model ids [google/gemini-3-flash, operator/qwen3.6-flash-lite]"); assert.deepEqual(resolveModel("gemini-3-flash", AVAILABLE), { ok: true, modelId: "google/gemini-3-flash" }); // an available alias is the only ok verdict, and it carries no reason
});
test("a non-Flash/Lite model is skipped with reason 'not a Flash/Lite class model'", async () => {
  const r = await runReplan({ available: AVAILABLE, requested: ["gpt-5-mini"], roles: ["minimal", "full"], tasks: [TASKS[0]!] });
  assert.deepEqual(r.entries.map((e) => [e.taskId, e.role, e.status, e.reason]), [["t1", "minimal", "skipped", "not a Flash/Lite class model"], ["t1", "full", "skipped", "not a Flash/Lite class model"]]);
});
test("opt-in replay runs once per eligible entry, in plan order, and stores the requestId", async () => {
  CALLS.length = 0; const r = await runReplan({ available: AVAILABLE, requested: ["gemini-3-flash", "qwen3.6-flash-lite"], roles: ["minimal", "full"], tasks: TASKS, ...LIVE, replay: spy });
  assert.equal(r.dryRun, false); assert.deepEqual(CALLS, ["t1/minimal", "t1/full", "t2/minimal", "t2/full"]); // serial, plan order, once each
  assert.deepEqual(r.entries.map((e) => [e.status, e.modelId, e.requestId]), [["replayed", "google/gemini-3-flash", "req-1"], ["replayed", "google/gemini-3-flash", "req-2"], ["replayed", "operator/qwen3.6-flash-lite", "req-3"], ["replayed", "operator/qwen3.6-flash-lite", "req-4"]]);
});
test("a throwing callback marks that entry failed and the serial loop still runs the rest", async () => {
  const boom: Replay = (e) => { if (e.taskId === "t1") throw new Error("endpoint down"); return { requestId: "req-ok" }; };
  const r = await runReplan({ available: AVAILABLE, requested: ["gemini-3-flash"], roles: ["minimal"], tasks: TASKS, ...LIVE, replay: boom });
  assert.deepEqual(r.entries.map((e) => [e.taskId, e.status, e.reason, e.requestId]), [["t1", "failed", "endpoint down", undefined], ["t2", "replayed", undefined, "req-ok"]]);
});
test("main prints one deterministic JSON line whose counts match the entries, exit 0, no endpoint", async () => {
  const lines: string[] = []; const log = console.log; console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  const codes = [await main([]), await main([])]; console.log = log; const out = JSON.parse(lines[0]!) as { dryRun: boolean; planned: number; skipped: number; replayed: number; skippedEntries: { taskId: string; role: string; reason: string }[] };
  assert.deepEqual(codes, [0, 0]); assert.equal(lines.length, 2); assert.equal(lines[0], lines[1]); assert.equal(out.dryRun, true); assert.equal(out.replayed, 0); assert.equal(out.planned + out.skipped + out.replayed, buildPlan(["gemini-3-flash"], ["minimal", "full"]).length);
  assert.equal(out.skippedEntries.length, out.skipped); assert.ok(out.skippedEntries.every((s) => s.taskId.length > 0 && s.role.length > 0 && s.reason.length > 0)); // every skip names itself
});
test("every planned entry is V03-valid once provenance is completed, and comparable within one task", async () => {
  const done = (await runReplan({ available: AVAILABLE, requested: ["gemini-3-flash"], roles: ["minimal", "full"], tasks: TASKS })).entries.map(complete);
  for (const record of done) assert.deepEqual(validateRunRecord(record), []); // the caller completes weightsHash/baseSha/outcome/latencyMs
  assert.deepEqual(compareRuns(done[0]!, done[1]!), { comparable: true, reasons: [] }); // the harness role is the varied dimension, never a controlled condition
  assert.deepEqual(compareRuns(done[0]!, { ...done[0]!, modelId: "operator/qwen3.6-flash-lite" }).reasons, ["model family differs: gemini vs qwen"]);
});
