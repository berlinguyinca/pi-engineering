// D08: the task package carries D07's bundle by reference, states its prohibitions in auditable words, bounds itself
// by bytes with a visible account, and reads an answer back fail-closed. The bundle is built by D07's own builder.
import assert from "node:assert/strict"; import test from "node:test";
import { ERROR_OCCURRENCE_VERSION, type ErrorOccurrence } from "../../src/incidents/errorEvent.ts";
import { buildEvidenceBundle, type EvidenceRow } from "../../src/incidents/evidenceBundle.ts";
import { CONSTRAINTS, DEFAULT_MODEL_HINT, MODEL_HINTS, REQUIRED_FIELDS, SECTIONS, TASK_VERSION, buildDiagnosticTask, parseDiagnosticResponse } from "../../src/incidents/diagnosticTask.ts";
const occ = (over: Partial<ErrorOccurrence> = {}): ErrorOccurrence => ({ version: ERROR_OCCURRENCE_VERSION, timestamp: "2026-11-03T00:00:00Z", host: "host-a", sessionId: "sess-a", runtime: "pi@aaa1111", layer: "gateway", code: "gateway.429.rate_limited", severity: "warning", summary: "upstream rate limit: http 429", runId: "run-7", taskId: "D08", model: "metabolomics/qwen3.8-flash_next", quantization: "q4_0", correlationIds: ["task:D08", "handoff:D07"], artifactRefs: ["logs/run-7.jsonl"], ...over });
const row = (eventId: string, at: string, over: Partial<ErrorOccurrence> = {}): EvidenceRow => ({ eventId, occurrence: occ({ timestamp: at, ...over }) });
const bundle = buildEvidenceBundle({ occurrences: [row("evt-1", "2026-11-03T00:00:00Z"), row("evt-2", "2026-11-02T00:00:00Z"), row("evt-3", "2026-11-01T00:00:00Z", { code: "host.disk_full", layer: "host", summary: "disk full while writing" }), row("evt-4", "2026-11-04T00:00:00Z", { code: "gateway.404.not_found", summary: "no such model route" })] }, { maxItems: 10, maxBytes: 16384 });
const FROZEN = JSON.stringify(bundle); const SUMMARY = bundle.items.find((i) => i.code === "host.disk_full")!.summary;
const BASE: Record<string, string> = { HYPOTHESIS: "the gateway throttled run-7 at 429 before any stream byte arrived", SUPPORTING_EVENTS: "evt-1, evt-2", DISCONFIRMING_EVIDENCE: "NONE", UNCERTAINTY: "whether the limit is per-minute or per-token", FURTHER_EVIDENCE: "the gateway retry-after headers" };
const answer = (over: Record<string, string | undefined> = {}): string => { const merged = { ...BASE, ...over }; return Object.entries(merged).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join("\n"); }; // dropping a key drops its section; "" empties it

test("the package is deterministic, names the local route hint, and carries the bundle's own fingerprints and event ids without touching it", () => {
  const a = buildDiagnosticTask({ bundle }, {}); const b = buildDiagnosticTask({ bundle }, {}); assert.equal(JSON.stringify(a), JSON.stringify(b), "identical inputs serialize byte-identically"); assert.equal(JSON.stringify(bundle), FROZEN, "the caller's bundle came back untouched"); assert.equal(a.version, TASK_VERSION);
  assert.equal(a.modelHint, DEFAULT_MODEL_HINT); assert.deepEqual([...MODEL_HINTS], ["metabolomics/qwen3.8-flash_next", "metabolomics/qwen3.8-27b"], "Qwen Flash / 27B hinted as route names, never as a client"); assert.equal(a.hintFallback, false);
  assert.deepEqual(a.requiredFields, [...REQUIRED_FIELDS]); assert.deepEqual(a.constraints, [...CONSTRAINTS]); assert.ok(a.prompt.includes(JSON.stringify(bundle.items)), "the prompt carries the bundle itself, not a re-derived copy");
  for (const item of bundle.items) { assert.ok(a.prompt.includes(item.fingerprint), item.fingerprint); for (const id of item.eventIds) assert.ok(a.prompt.includes(id), id); } assert.deepEqual(a.evidenceIds, ["evt-1", "evt-2", "evt-3", "evt-4"]); assert.deepEqual(a.fingerprints, [...bundle.items.map((i) => i.fingerprint)].sort()); assert.deepEqual([a.truncated, a.dropped.items, a.dropped.bytes], [false, 0, 0]); assert.ok(a.bytes <= a.maxBytes, "the default cap fits the default bundle");
  const odd = buildDiagnosticTask({ bundle, modelHint: "gpt-5-mini", question: "explain\r\n[31mnow" }, {}); assert.equal(odd.modelHint, DEFAULT_MODEL_HINT); assert.equal(odd.hintFallback, true, "an unknown route is refused as a hint and recorded"); assert.ok(!odd.prompt.includes("\r") && !odd.prompt.includes("[31m"), "control sequences never enter the prompt");
});

test("the contract says the hard limits in words an operator can audit", () => {
  const text = `${buildDiagnosticTask({ bundle }, {}).systemContract} ${CONSTRAINTS.join(" ")}`;
  for (const rule of [/read-only diagnosis/i, /no source modification/i, /no self-repair/i, /no automatic dispatch/i, /no new tooling/i, /supplied evidence only/i, /name every evidence id/i]) assert.match(text, rule, String(rule));
  assert.match(buildDiagnosticTask({ bundle }, {}).prompt, new RegExp(Object.values(SECTIONS).join("|"), "u"), "the answer format names every required section");
});

test("maxBytes bounds the whole package and the account says what was withheld", () => {
  const tight = buildDiagnosticTask({ bundle }, { maxBytes: 4000 }); assert.equal(tight.truncated, true, "a cap that bites says so"); assert.deepEqual([tight.dropped.items, tight.bytes <= tight.maxBytes], [1, true], JSON.stringify(tight.dropped)); assert.ok(tight.dropped.bytes > 0, "the withheld bytes are counted"); assert.equal(tight.prompt.includes(JSON.stringify(bundle.items)), false); assert.deepEqual(tight.evidenceIds, ["evt-1", "evt-2", "evt-4"], "only the ids it still supplies are named"); assert.deepEqual(tight.fingerprints, bundle.items.slice(0, 2).map((i) => i.fingerprint).sort());
  const none = buildDiagnosticTask({ bundle }, { maxBytes: 1 }); assert.equal(none.dropped.items, bundle.items.length, "a cap nothing satisfies withholds every item, visibly"); assert.equal(none.truncated, true); assert.ok(none.bytes > none.maxBytes, "the overrun is visible rather than silently trimmed"); assert.deepEqual(buildDiagnosticTask({ bundle }, { maxBytes: 0 }).maxBytes, 32768, "an invalid cap falls back to the default, never unbounded");
});

test("the validator accepts a complete answer and refuses an incomplete, out-of-bundle or restated one with reasons", () => {
  const good = parseDiagnosticResponse(answer(), bundle); assert.equal(good.ok, true); assert.deepEqual((good as { answer: { supportingEventIds: string[] } }).answer.supportingEventIds, ["evt-1", "evt-2"], "ids are deduped and sorted, never invented");
  const missing = { HYPOTHESIS: "missing_section:HYPOTHESIS", SUPPORTING_EVENTS: "missing_section:SUPPORTING_EVENTS", DISCONFIRMING_EVIDENCE: "missing_section:DISCONFIRMING_EVIDENCE", UNCERTAINTY: "missing_section:UNCERTAINTY" } as const;
  for (const [section, reason] of Object.entries(missing)) assert.deepEqual(parseDiagnosticResponse(answer({ [section]: undefined }), bundle), { ok: false, reasons: [reason] }, section);
  assert.deepEqual(parseDiagnosticResponse(answer({ UNCERTAINTY: "" }), bundle), { ok: false, reasons: ["empty_section:UNCERTAINTY"] }, "an empty section is as missing as none");
  assert.deepEqual(parseDiagnosticResponse(answer({ SUPPORTING_EVENTS: "evt-1, evt-99" }), bundle), { ok: false, reasons: ["unknown_event_id:evt-99"] }, "an id absent from the bundle is refused, not shortened into something plausible");
  assert.deepEqual(parseDiagnosticResponse(answer({ HYPOTHESIS: SUMMARY }), bundle), { ok: false, reasons: ["hypothesis_restates_summary"] }, "restating the summary is not a hypothesis");
  assert.deepEqual(parseDiagnosticResponse(answer({ FURTHER_EVIDENCE: answer() }), bundle).ok, false, "a section body cannot smuggle another section");
  assert.deepEqual(parseDiagnosticResponse(`${answer()}\n${SECTIONS.uncertainty}: something else`, bundle), { ok: false, reasons: ["duplicate_section:UNCERTAINTY"] }, "the same section twice is refused, not merged");
  assert.deepEqual(parseDiagnosticResponse(`I think the gateway is bad.\n${answer()}`, bundle), { ok: false, reasons: ["unlabelled_text"] }, "a preamble is an unrequested section");
  assert.deepEqual(parseDiagnosticResponse(null, bundle), { ok: false, reasons: ["not_text"] }); assert.deepEqual(parseDiagnosticResponse(answer(), { version: 1, items: [], dropped: { items: 0, bytes: 0 }, refused: 0, bytes: 0, truncated: false }), { ok: false, reasons: ["unknown_event_id:evt-1", "unknown_event_id:evt-2", "evidence_bundle_unusable"] }, "an answer citing ids no bundle supplied fails closed, in a stable order");
});
