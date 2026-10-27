import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRecords } from "../../src/capability/discovery.ts";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";

const record = (source: string, available: boolean, extra = {}) =>
  normalizeModelRecord({
    provider: "p",
    id: "model",
    source,
    available,
    healthy: true,
    ...extra,
  });

test("configured models cannot override authoritative runtime unavailability", () => {
  const result = mergeRecords([
    [record("pi-model-runtime", false, { healthReason: "not selectable" })],
    [record("agent-models-file", true, { contextWindow: 131_072 })],
  ]);
  assert.equal(result[0]?.available, false);
  assert.equal(result[0]?.healthReason, "not selectable");
  assert.equal(result[0]?.contextWindow, 131_072, "supplementary metadata is retained");
});

test("first-source availability is retained and file-only discovery still works", () => {
  assert.equal(
    mergeRecords([[record("pi-model-runtime", true)], [record("agent-models-file", false)]])[0]?.available,
    true,
  );
  assert.equal(mergeRecords([[record("agent-models-file", true)]])[0]?.available, true);
});
