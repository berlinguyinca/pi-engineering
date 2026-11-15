import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createNormalizer,
  keyFacts,
  normalizeEvents,
  parseLedger,
  stableStringify,
} from "../support/ledgerNormalizer.ts";

test("ids become per-prefix ordinals in first-seen order and stay consistent", () => {
  const n = createNormalizer();
  assert.equal(
    n.text("WI-6GiMT8 then CAND-E9qD2c then WI-AAAAAA then WI-6GiMT8"),
    "<WI#1> then <CAND#1> then <WI#2> then <WI#1>",
  );
  assert.equal(n.text("evt-abc123"), "<evt#1>");
  assert.equal(n.text("REQUIREMENT-o2kjOi"), "<REQUIREMENT#1>");
});

test("two runs with different random ids normalize identically", () => {
  const a = createNormalizer();
  const b = createNormalizer();
  assert.equal(a.text("WI-aaaaaa/CAND-bbbbbb"), b.text("WI-cccccc/CAND-dddddd"));
});

test("shas, hashes, uuids and temp roots are replaced", () => {
  const n = createNormalizer(["/private/var/T/pi-eng-fixture-x", "/private/var/T"]);
  const sha = "4490d28da49942ed6a3c9d12de80cc2ba2fe7dab";
  const hash = `sha256:${"a".repeat(64)}`;
  assert.equal(n.text(`/private/var/T/pi-eng-fixture-x/src ${sha} ${hash}`), "<ROOT>/src <SHA> <HASH>");
  assert.equal(n.text("verify-c2cae194-9fbe-43fb-8e0a-0ff3993eee27"), "verify-<UUID>");
  assert.equal(n.text("repo-8923de302d360597"), "<REPO>");
  assert.equal(n.text("SHA-256 UTF-8 pi-eng-1-kenewt"), "SHA-256 UTF-8 pi-eng-1-kenewt");
});

test("deep value drops volatile keys, sorts keys and normalizes strings", () => {
  const n = createNormalizer();
  const out = n.value({
    z: 1,
    id: "WI-6GiMT8",
    timestamp: "2026-11-15T02:51:47.178Z",
    nested: { durationMs: 160, updated_at: "t", list: ["CAND-E9qD2c", { started_at: "t", ok: true }] },
  });
  assert.equal(
    stableStringify(out),
    stableStringify({ id: "<WI#1>", nested: { list: ["<CAND#1>", { ok: true }] }, z: 1 }),
  );
  assert.deepEqual(Object.keys(out as object), ["id", "nested", "z"]);
});

test("keyFacts keeps enums and *_id references, pins arrays by length, drops free text", () => {
  const n = createNormalizer();
  const facts = keyFacts(
    {
      candidate: {
        id: "CAND-E9qD2c",
        status: "PROMOTED",
        diff: "diff --git a b",
        parent_id: null,
        changed_files: ["a"],
      },
      role: "scout",
      task: "long prompt text",
      changes: { status: "ELIGIBLE" },
    },
    n,
  );
  assert.deepEqual(facts, {
    "candidate.id": "<CAND#1>",
    "candidate.parent_id": null,
    "candidate.status": "PROMOTED",
    "candidate.changed_files": 1,
    "changes.status": "ELIGIBLE",
    role: "scout",
  });
});

test("normalizeEvents keeps type, actor type and scope, and relates ids across events", () => {
  const n = createNormalizer();
  const events = normalizeEvents(
    [
      {
        type: "work_item.created",
        work_item_id: "WI-111111",
        actor: { type: "system" },
        payload: { workItem: { id: "WI-111111", status: "DEFINED" } },
      },
      {
        type: "candidate.promoted",
        work_item_id: "WI-111111",
        actor: { type: "system" },
        payload: { candidate_id: "CAND-222222" },
      },
      { type: "mission.created", project_id: "MSN-333333", payload: {} },
    ],
    n,
  );
  assert.deepEqual(events, [
    {
      type: "work_item.created",
      actor: "system",
      work_item: "<WI#1>",
      facts: { "workItem.id": "<WI#1>", "workItem.status": "DEFINED" },
    },
    { type: "candidate.promoted", actor: "system", work_item: "<WI#1>", facts: { candidate_id: "<CAND#1>" } },
    { type: "mission.created", work_item: "<MSN#1>", facts: {} },
  ]);
});

test("parseLedger skips a torn final line and blank lines", () => {
  const body = `${JSON.stringify({ type: "a" })}\n\n${JSON.stringify({ type: "b" })}\n{"event_id":"torn`;
  assert.deepEqual(
    parseLedger(body).map((e) => e.type),
    ["a", "b"],
  );
});

test("parseLedger throws on a corrupt line in the middle of the file", () => {
  const body = `${JSON.stringify({ type: "a" })}\n{"event_id":"corrupt\n${JSON.stringify({ type: "b" })}\n`;
  assert.throws(() => parseLedger(body), /line 2/);
});

test("parseLedger tolerates an unparseable final line only", () => {
  const body = `${JSON.stringify({ type: "a" })}\n${JSON.stringify({ type: "b" })}\n{"event_id":"torn\n\n`;
  assert.deepEqual(
    parseLedger(body).map((e) => e.type),
    ["a", "b"],
  );
});

test("only known id prefixes are normalized; other PREFIX-xxxxxx words survive", () => {
  const n = createNormalizer();
  assert.equal(n.text("HIGH-abcdef and WI-abcdef"), "HIGH-abcdef and <WI#1>");
  assert.equal(n.text("MSN-0wDA7O TSK-abcdef EXC-abcdef"), "<MSN#1> <TSK#1> <EXC#1>");
});

test("keys ending in _at are dropped generically", () => {
  const n = createNormalizer();
  assert.deepEqual(n.value({ blocked_at: "x", lease_expires_at: "y", keep: 1 }), { keep: 1 });
});

test("keyFacts keeps id arrays in order and counts other arrays", () => {
  const n = createNormalizer();
  const facts = keyFacts(
    {
      evidence_ids: ["EVID-aaaaaa", "EVID-bbbbbb", "EVID-aaaaaa"],
      depends_on: ["a", "b"],
      changed_files: ["x.js"],
      inner: { finding_ids: ["F-cccccc"] },
      note: ["free", "text"],
    },
    n,
  );
  assert.deepEqual(facts, {
    changed_files: 1,
    depends_on: 2,
    evidence_ids: ["<EVID#1>", "<EVID#2>", "<EVID#1>"],
    "inner.finding_ids": ["<F#1>"],
    note: 2,
  });
});

test("addRoot makes later text mask the new root, longest first", () => {
  const n = createNormalizer(["/tmp"]);
  n.addRoot("/tmp/pi-eng-fixture-x");
  assert.equal(n.text("/tmp/pi-eng-fixture-x/src and /tmp/other"), "<ROOT>/src and <ROOT>/other");
});

test("parseLedger skips a mid-file torn fragment only when tornLinesExpected", () => {
  const body = `${JSON.stringify({ type: "a" })}\n{"event_id":"torn\n${JSON.stringify({ type: "b" })}\n`;
  assert.throws(() => parseLedger(body));
  assert.deepEqual(
    parseLedger(body, { tornLinesExpected: true }).map((e) => e.type),
    ["a", "b"],
  );
});
