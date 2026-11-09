// D03: occurrences aggregate into stable issue clusters — a retry-trace duplicate never inflates a count, and every input permutation yields byte-identical output.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AggregateRow,
  DEFAULT_MAX_EVENT_IDS,
  aggregateErrorOccurrences,
} from "../../src/incidents/errorAggregate.ts";
import { ERROR_OCCURRENCE_VERSION, type ErrorOccurrence } from "../../src/incidents/errorEvent.ts";
const occ = (over: Partial<ErrorOccurrence> = {}): ErrorOccurrence => ({
  version: ERROR_OCCURRENCE_VERSION,
  timestamp: "2026-11-01T00:00:00Z",
  host: "host-a",
  sessionId: "sess-a",
  runtime: "pi@aaa1111",
  layer: "gateway",
  code: "gateway.429.rate_limited",
  severity: "warning",
  summary: "upstream rate limit: http 429",
  runId: null,
  taskId: null,
  model: null,
  quantization: null,
  correlationIds: ["mission-d03"],
  artifactRefs: [],
  ...over,
});
const row = (
  eventId: string,
  at: string,
  over: Partial<ErrorOccurrence> = {},
  extra: Partial<AggregateRow> = {},
): AggregateRow => ({ eventId, occurrence: occ({ timestamp: at, ...over }), ...extra });
const RATE = "gateway.429.rate_limited";
const FID = "sha256:111122223333444455556666"; // E07: one upstream failure, one identity, two observation paths (session event + retry trace)
const MISS: Partial<ErrorOccurrence> = { code: "gateway.404.not_found", summary: "no such model route" };
const DISK: Partial<ErrorOccurrence> = { layer: "host", code: "host.disk_full", summary: "disk full while writing" };
const RG: Partial<ErrorOccurrence> = { layer: "worker", code: "tool.rg.timeout", summary: "tool=rg timed out" };
const rows = (): AggregateRow[] => [
  // four causes; the 429 cluster holds the fid pair (evt-a0 session, evt-a1 retry trace) AND evt-a1 delivered twice — those two duplicates stamp 2026-11-09 and carry host-b / sess-b / llama-70b / "recovered"
  row(
    "evt-a1",
    "2026-11-09T00:00:00Z",
    { host: "host-b", sessionId: "sess-b", model: "llama-70b", quantization: "q4_0" },
    { failureIdentity: FID, resolution: "recovered" },
  ),
  row(
    "evt-a1",
    "2026-11-09T00:00:00Z",
    { host: "host-b", sessionId: "sess-b", model: "llama-70b", quantization: "q4_0" },
    { failureIdentity: FID, resolution: "recovered" },
  ),
  row(
    "evt-a0",
    "2026-11-03T00:00:00Z",
    { host: "host-z", sessionId: "sess-z", model: "gemma-2b", quantization: "q2_k" },
    { failureIdentity: FID },
  ),
  row("evt-a2", "2026-10-29T00:00:00Z", {
    host: "host-c",
    sessionId: "sess-c",
    model: "llama-8b",
    quantization: "q8_0",
  }),
  row("evt-b1", "2026-11-04T00:00:00Z", MISS),
  row("evt-b2", "2026-11-02T00:00:00Z", { ...MISS, host: "host-d", sessionId: "sess-d" }),
  row("evt-c1", "2026-11-05T00:00:00Z", DISK, { resolution: "recovered" }),
  row("evt-c2", "2026-11-03T00:00:00Z", DISK, { resolution: "recovered" }),
  row("evt-c3", "2026-10-29T00:00:00Z", DISK),
  row("evt-d1", "2026-11-03T00:00:00Z", RG),
  row("evt-d2", "2026-11-01T00:00:00Z", RG),
];
const by = (out: ReturnType<typeof aggregateErrorOccurrences>, code: string) =>
  out.clusters.find((c) => c.codes.includes(code))!;
const shuffle = <T>(xs: readonly T[]): T[] => xs.map((_, i) => xs[(i * 5 + 2) % xs.length]!); // deterministic permutation (gcd(5, 11) = 1), never Math.random
test("evidence: one failureIdentity across two event ids counts once, keeps both ids, and a shuffled input yields byte-identical output (criterion 1)", () => {
  const base = aggregateErrorOccurrences(rows());
  const a = by(base, RATE);
  assert.equal(a.count, 2, "the retry-trace twin and the twice-delivered eventId were folded away");
  assert.equal(base.duplicateEvents, 2, "one fid duplicate plus one exact eventId duplicate");
  assert.equal(base.rejected, 0);
  assert.equal(base.clusters.length, 4);
  assert.deepEqual(
    a.eventIds,
    ["evt-a0", "evt-a1", "evt-a2"],
    "both ids of the retry-trace pair survive as evidence, sorted",
  );
  assert.deepEqual(
    aggregateErrorOccurrences(shuffle(rows())),
    base,
    "identical clusters, order and counters under a deterministic permutation of the input",
  );
});
test("first/last seen bound only the deduped occurrences, and every dimension set is sorted and unique (criterion 2)", () => {
  const a = by(aggregateErrorOccurrences(rows()), RATE);
  assert.equal(a.firstSeen, "2026-10-29T00:00:00Z");
  assert.equal(a.lastSeen, "2026-11-03T00:00:00Z", "the duplicate stamped 2026-11-09 bounds nothing");
  assert.deepEqual(
    [a.sessions, a.hosts, a.models, a.quantizations, a.layers, a.codes],
    [["sess-c", "sess-z"], ["host-c", "host-z"], ["gemma-2b", "llama-8b"], ["q2_k", "q8_0"], ["gateway"], [RATE]],
    "the duplicates' host, session, model and quantization stay out",
  );
});
test("recovered + unresolved === count, resolution defaults to unresolved, and a duplicate's resolution counts for nothing (criterion 3)", () => {
  const out = aggregateErrorOccurrences(rows());
  const c = by(out, "host.disk_full");
  const a = by(out, RATE);
  assert.deepEqual([c.recovered, c.unresolved, c.count], [2, 1, 3], "mixed resolution map, the third row defaulted");
  assert.deepEqual(
    [a.recovered, a.unresolved],
    [0, 2],
    "the folded retry-trace twin said recovered: neither flag moved",
  );
  for (const cl of out.clusters) assert.equal(cl.recovered + cl.unresolved, cl.count);
  assert.equal(
    out.clusters.reduce((n, cl) => n + cl.count, 0),
    9,
    "nine counted occurrences across four clusters",
  );
});
test("stable ordering: lastSeen desc, then count desc, then fingerprint asc, so the order is total (criterion 1)", () => {
  const out = aggregateErrorOccurrences(rows());
  const tied = out.clusters.slice(2).map((cl) => cl.fingerprint);
  assert.deepEqual(
    out.clusters.map((cl) => `${cl.lastSeen}|${cl.count}`),
    ["2026-11-05T00:00:00Z|3", "2026-11-04T00:00:00Z|2", "2026-11-03T00:00:00Z|2", "2026-11-03T00:00:00Z|2"],
  );
  assert.equal(tied.length, 2);
  assert.deepEqual(tied, [...tied].sort(), "equal lastSeen and count fall back to fingerprint ascending");
});
test("maxEventIds caps kept source ids with eventIdsTruncated, limit truncates clusters with truncated, the default cap is documented (criterion 2)", () => {
  const capped = aggregateErrorOccurrences(rows(), { maxEventIds: 2 });
  const a = by(capped, RATE);
  assert.equal(DEFAULT_MAX_EVENT_IDS, 50);
  assert.equal(capped.truncated, false, "capping ids does not truncate the cluster list");
  assert.deepEqual(a.eventIds, ["evt-a0", "evt-a1"]);
  assert.equal(a.eventIdsTruncated, true);
  assert.equal(a.count, 2, "the cap hides evidence, never a count");
  assert.deepEqual(by(capped, "host.disk_full").eventIds, ["evt-c1", "evt-c2"], "every cluster caps the same way");
  assert.deepEqual(
    by(capped, "gateway.404.not_found").eventIds,
    ["evt-b1", "evt-b2"],
    "a cluster at the cap is not flagged",
  );
  const one = aggregateErrorOccurrences(rows(), { limit: 1 });
  assert.equal(one.clusters.length, 1);
  assert.equal(one.truncated, true);
  assert.equal(one.clusters[0]!.codes[0], "host.disk_full");
});
test("purity and rejection: the caller's array and rows are deep-equal after the call, and a row D02 refuses is rejected and forms no cluster (criterion 4)", () => {
  const input = rows();
  const before = structuredClone(input);
  aggregateErrorOccurrences(input, { maxEventIds: 1, limit: 2 });
  assert.deepEqual(input, before, "no row mutated, no field added, no reordering of the caller's array");
  assert.equal(input.length, 11);
  const bad = aggregateErrorOccurrences([...rows(), row("evt-bad", "2026-11-06T00:00:00Z", { code: "", summary: "" })]);
  assert.equal(bad.rejected, 1);
  assert.equal(bad.clusters.length, 4);
  assert.equal(
    bad.clusters.reduce((n, cl) => n + cl.count, 0),
    9,
    "the malformed occurrence entered no cluster and no eventIds",
  );
});
