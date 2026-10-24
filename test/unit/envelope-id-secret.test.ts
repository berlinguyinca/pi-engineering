import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { telemetryEventToDraft } from "../../src/runtime/herdr/envelopeAdapters.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { createLineageEmitter } from "../../src/runtime/herdr/lineage.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pi-idsecret-"));
  dirs.push(d);
  return d;
};
const SOURCE = "pi-hosta-00000001";

async function lineageIds(store: EnvelopeStore): Promise<string[]> {
  const emitter = createLineageEmitter({ store })!;
  emitter.workerSpawned({ agent: "a1", attempt: "t1", parentAgent: "p1", transition: "created" });
  emitter.attemptState({ attempt: "t1" }, "running", "n1");
  await emitter.idle();
  return (await store.outbox.pending()).map((e) => e.event_id);
}

test("the id secret is persisted 0600 and survives restart: same inputs => same ids", async () => {
  const dir = tmp();
  const first = await lineageIds(new EnvelopeStore({ dir, source: SOURCE }));
  const mode = statSync(join(dir, "id-secret")).mode & 0o777;
  assert.equal(mode, 0o600);
  // restart: a new store on the same dir; the retry of the same transitions dedupes onto the same ids
  const second = await lineageIds(new EnvelopeStore({ dir, source: SOURCE }));
  assert.deepEqual(second, first, "no new events: the retried transitions dedupe");
  const store = new EnvelopeStore({ dir, source: SOURCE });
  assert.equal(
    store.deriveEventId("lin", ["x"]),
    new EnvelopeStore({ dir, source: SOURCE }).deriveEventId("lin", ["x"]),
  );
});

test("a different secret gives different ids for the same inputs", () => {
  const a = new EnvelopeStore({ dir: tmp(), source: SOURCE });
  const b = new EnvelopeStore({ dir: tmp(), source: SOURCE });
  assert.notEqual(
    a.deriveEventId("lin", [SOURCE, "node.upsert", "agent:a", "created"]),
    b.deriveEventId("lin", [SOURCE, "node.upsert", "agent:a", "created"]),
  );
});

test("ids are not computable from the public source string", async () => {
  const dir = tmp();
  const store = new EnvelopeStore({ dir, source: SOURCE });
  const emitter = createLineageEmitter({ store })!;
  emitter.nodeUpsert("agent:a1", {}, "created");
  await emitter.idle();
  const id = (await store.outbox.pending())[0]!.event_id;
  // what an attacker who knows the source and the transition scheme can compute
  const guesses = [
    createHash("sha256")
      .update(JSON.stringify([SOURCE, "node.upsert", "agent:a1", "created"]))
      .digest("hex")
      .slice(0, 32),
    createHash("sha256")
      .update(JSON.stringify([SOURCE, "node.upsert", ["agent:a1", "created"]]))
      .digest("hex")
      .slice(0, 32),
  ];
  for (const g of guesses) assert.ok(!id.includes(g), "bare sha256 of public inputs must not match");
  const secret = readFileSync(join(dir, "id-secret"), "utf8").trim();
  assert.ok(!id.includes(secret));
});

test("adapter-derived ids are keyed too: same content, two instances => different ids", async () => {
  const draftOf = () =>
    telemetryEventToDraft({ name: "n", at: "2026-01-01T00:00:00.000Z", attributes: {}, runId: "r" } as never);
  const a = new EnvelopeStore({ dir: tmp(), source: SOURCE });
  const b = new EnvelopeStore({ dir: tmp(), source: SOURCE });
  const plain = draftOf().event_id!;
  const ra = await a.stage(draftOf());
  const rb = await b.stage(draftOf());
  assert.ok("envelope" in ra && "envelope" in rb);
  assert.notEqual(ra.envelope.event_id, rb.envelope.event_id);
  assert.ok(!ra.envelope.event_id.includes(plain.split("_")[1]!), "the public content hash is not the id");
  assert.match(ra.envelope.event_id, /^tel_[0-9a-f]{32}-[0-9a-f]{8}$/);
});
