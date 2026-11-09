// D07: the bundle keeps what makes a diagnosis reproducible and loses nothing secret; caps are visible, ordering is
// total, and the caller's arrays and occurrences come back untouched.
import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_OCCURRENCE_VERSION, type ErrorOccurrence } from "../../src/incidents/errorEvent.ts";
import {
  BUNDLE_VERSION,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ITEMS,
  type EvidenceRow,
  buildEvidenceBundle,
} from "../../src/incidents/evidenceBundle.ts";
import { type FailureIdentityInput, failureIdentity } from "../../src/inference/retryTrace.ts";
const SK = "sk-proj-YWJjZGVmZ2hpamtsbW5vcA";
const BEARER = "Bearer c2VjcmV0dG9rZW4udG9rZW4";
const URL_SECRET = "https://ingest:s3cr3t-pass@llm.example.com/v1";
const PROMPT = `user: ${"a long raw prompt body that must never reach the bundle ".repeat(12)}`; // an OpenAI-style key, a bearer token, a credential-bearing URL, a transcript
const occ = (over: Partial<ErrorOccurrence> = {}): ErrorOccurrence => ({
  version: ERROR_OCCURRENCE_VERSION,
  timestamp: "2026-11-03T00:00:00Z",
  host: "host-a",
  sessionId: "sess-a",
  runtime: "pi@aaa1111",
  layer: "gateway",
  code: "gateway.429.rate_limited",
  severity: "warning",
  summary: "upstream rate limit: http 429",
  runId: "run-7",
  taskId: null,
  model: "metabolomics/qwen3.8-flash_next",
  quantization: "q4_0",
  correlationIds: ["mission:msn-d07", "task:D07", "handoff:D06"],
  artifactRefs: ["logs/run-7.jsonl"],
  ...over,
});
const row = (eventId: string, at: string, over: Partial<ErrorOccurrence> = {}): EvidenceRow => ({
  eventId,
  occurrence: occ({ timestamp: at, ...over }),
});
const MISS = { code: "gateway.404.not_found", summary: "no such model route", layer: "gateway" } as const;
const DISK = { code: "host.disk_full", summary: "disk full while writing", layer: "host" } as const;
const scope = (): FailureIdentityInput => ({
  sessionId: "sess-a",
  runId: "run-7",
  provider: "metabolomics",
  model: "metabolomics/qwen3.8-flash_next",
  originLayer: "resilient-stream",
  firstAttempt: 1,
  error: Object.assign(new Error(`429 rate limited from ${URL_SECRET} key=${SK}`), { status: 429 }),
});
const RECOVERED = {
  failureRecorded: true,
  failureAt: "2026-11-02T00:00:00Z",
  completion: { kind: "typecheck.passed", at: "2026-11-02T01:00:00Z", eventId: "evt-done" },
};
const input = (): {
  occurrences: EvidenceRow[];
  retryTraces: never[];
  failures: { eventId: string; scope: FailureIdentityInput }[];
  recovery: Record<string, typeof RECOVERED>;
} => ({
  occurrences: [
    row("evt-1", "2026-11-03T00:00:00Z", { sessionId: "sess-b", runtime: "pi@bbb2222", quantization: "q8_0" }),
    row("evt-2", "2026-11-02T00:00:00Z"),
    row("evt-3", "2026-11-01T00:00:00Z", MISS),
    row("evt-4", "2026-11-04T00:00:00Z", DISK),
  ],
  retryTraces: [],
  failures: [{ eventId: "evt-1", scope: scope() }],
  recovery: { "evt-2": RECOVERED },
});
test("reproducible context survives: fingerprint, representative summary, affected versions, E07 retry identity, task/handoff ids and the D04 outcome", () => {
  const out = buildEvidenceBundle(input(), { maxItems: 5, maxBytes: 16384 });
  assert.equal(out.refused, 0);
  assert.equal(out.items.length, 3);
  const rate = out.items.find((i) => i.code === "gateway.429.rate_limited")!;
  assert.match(rate.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(rate.count, 2, "the two 429 occurrences are one cause");
  assert.equal(rate.summary, "upstream rate limit: http 429", "the representative is the earliest occurrence");
  assert.deepEqual(rate.eventIds, ["evt-1", "evt-2"]);
  assert.equal(rate.eventIdsTruncated, false);
  assert.deepEqual(
    rate.versions,
    {
      runtime: ["pi@aaa1111", "pi@bbb2222"],
      model: ["metabolomics/qwen3.8-flash_next"],
      quantization: ["q4_0", "q8_0"],
    },
    "distinct runtime / model / quantization",
  );
  assert.deepEqual(
    [rate.taskIds, rate.handoffIds],
    [["D07"], ["D06"]],
    "discoverable from the correlation ids, and nothing invented",
  );
  assert.deepEqual(rate.correlationIds, ["handoff:D06", "mission:msn-d07", "task:D07"]);
  assert.deepEqual(
    rate.failureIds,
    [failureIdentity(scope())],
    "E07 derived the identity from the raw failure the caller held",
  );
  assert.equal(rate.outcome, "recovered", "D04's class where evidence exists");
  assert.equal(out.items.find((i) => i.code === MISS.code)!.outcome, "unknown", "no evidence is no class");
  assert.equal(BUNDLE_VERSION, 1);
});
test("a bearer URL, an sk- key and a raw prompt are sanitized before byte accounting and appear nowhere in the serialized bundle", () => {
  const leaky = {
    occurrences: [
      row("evt-sec", "2026-11-03T00:00:00Z", {
        summary: `upstream refused: ${BEARER} key=${SK} at ${URL_SECRET} ${PROMPT}`,
      }),
    ],
    failures: [{ eventId: "evt-sec", scope: { ...scope(), error: new Error(`key=${SK} at ${URL_SECRET}`) } }],
  }; // the transcript-shaped summary digests whole
  const out = buildEvidenceBundle(leaky, {});
  const json = JSON.stringify(out);
  const item = out.items[0]!;
  assert.ok(item !== undefined);
  for (const secret of [SK, BEARER, URL_SECRET, "s3cr3t-pass", "raw prompt body"])
    assert.ok(!json.includes(secret), `leaked: ${secret}`);
  assert.ok(json.includes("<redacted-prompt len=") && json.includes("sha256="), item.summary);
  assert.match(item.summary, /^<redacted-prompt len=\d+ sha256=[0-9a-f]{32}>$/);
  const bare = buildEvidenceBundle(
    {
      occurrences: [
        row("evt-key", "2026-11-03T00:00:00Z", { summary: `upstream refused: key=${SK} via ${URL_SECRET}` }),
      ],
    },
    {},
  );
  assert.ok(JSON.stringify(bare).includes("[REDACTED]"), JSON.stringify(bare));
  assert.ok(!JSON.stringify(bare).includes(SK) && !JSON.stringify(bare).includes("s3cr3t-pass"));
});
test("maxItems and maxBytes are enforced with the dropped count reported, so truncation is never silent", () => {
  const capped = buildEvidenceBundle(input(), { maxItems: 2, maxBytes: 65536 });
  assert.equal(capped.items.length, 2);
  assert.deepEqual([capped.dropped.items, capped.dropped.bytes], [1, 0]);
  assert.equal(capped.truncated, true, "an item cap that bites says so");
  const tight = buildEvidenceBundle(input(), { maxItems: 10, maxBytes: 400 });
  assert.equal(tight.items.length, 0, "no item fits inside 400 bytes of items");
  assert.deepEqual([tight.dropped.items, tight.dropped.bytes], [3, 3]);
  assert.ok(tight.bytes <= 400 && tight.truncated);
  const ids = buildEvidenceBundle(input(), { maxItems: 5, maxBytes: 16384, maxEventIds: 1 });
  assert.deepEqual(ids.items.find((i) => i.code === "gateway.429.rate_limited")!.eventIds, ["evt-1"]);
  assert.equal(
    ids.items.find((i) => i.code === "gateway.429.rate_limited")!.eventIdsTruncated,
    true,
    "capping evidence ids keeps the count exact",
  );
  assert.equal(DEFAULT_MAX_ITEMS, 20);
  assert.equal(DEFAULT_MAX_BYTES, 32768);
});
test("ordering is total and the same input re-serializes byte-identically in any order, without mutating the caller's data", () => {
  const a = input();
  const frozen = JSON.stringify(a);
  const first = JSON.stringify(buildEvidenceBundle(a, { maxItems: 5, maxBytes: 16384 }));
  const b = input();
  const reversed = { ...b, occurrences: [...b.occurrences].reverse() };
  const again = JSON.stringify(buildEvidenceBundle(reversed, { maxItems: 5, maxBytes: 16384 })); // a copy is reversed; the caller's array is never touched
  assert.equal(first, again, "byte-identical JSON under a different input order");
  assert.equal(JSON.stringify(a), frozen, "the input came back untouched");
  assert.equal(JSON.stringify(b), frozen);
  const fingerprints = buildEvidenceBundle(a, { maxItems: 5, maxBytes: 16384 }).items.map((i) => i.fingerprint);
  assert.deepEqual(fingerprints, [...fingerprints].sort(), "ordered by fingerprint");
  assert.deepEqual(buildEvidenceBundle({ occurrences: [] }, {}).items, []);
  assert.deepEqual(
    buildEvidenceBundle({ occurrences: [{ eventId: "junk", occurrence: null as unknown as ErrorOccurrence }] }, {})
      .refused,
    1,
    "what E04 refuses is counted, not rewritten",
  );
});
