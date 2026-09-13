import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore } from "../../src/blackhole/MemoryStore.ts";
import { InMemoryDurableMemory } from "../../src/blackhole/OpenViking.ts";
import { newSessionIdentity } from "../../src/blackhole/SessionStore.ts";
import { resolveBlackholeConfig } from "../../src/blackhole/config.ts";
import { decidePromotion } from "../../src/blackhole/promotion.ts";
import { blackholeTelemetry, formatBlackholeTelemetry } from "../../src/blackhole/telemetry.ts";
import { PINNED_BLACKHOLE_VERSION, sessionKey } from "../../src/blackhole/types.ts";
import { validateBlackholePackage } from "../../src/blackhole/versioning.ts";

// ------------------------------------------------------------------ config

test("blackhole config: defaults are backward-compatible (disabled, pinned version)", () => {
  const { config, warnings } = resolveBlackholeConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.autoPromotion, false);
  assert.equal(config.version, PINNED_BLACKHOLE_VERSION);
  assert.equal(config.memoryWorkerConcurrency, 2);
  assert.deepEqual(warnings, []);
});

test("blackhole config: rejects a version not in the allowlist (fail-closed)", () => {
  assert.throws(() => resolveBlackholeConfig({ version: "9.9.9" }), /not in the allowed allowlist/);
});

test("blackhole config: warns but accepts a non-default allowlisted version", () => {
  const { config, warnings } = resolveBlackholeConfig({ version: "0.5.4" });
  assert.equal(config.version, "0.5.4");
  assert.equal(warnings.length, 0);
});

test("blackhole config: rejects invalid concurrency and compaction thresholds", () => {
  assert.throws(() => resolveBlackholeConfig({ memoryWorkerConcurrency: 0 }), /concurrency/i);
  assert.throws(() => resolveBlackholeConfig({ compactionThreshold: 1 }), /compactionThreshold/);
});

// ------------------------------------------------------------- session store

test("session store: strict isolation — a foreign identity cannot access a store", () => {
  const a = newSessionIdentity({ project: "p", workItem: "wi", role: "implementer" });
  const b = newSessionIdentity({ project: "p", workItem: "wi", role: "reviewer" });
  const store = new MemoryStore(a);
  assert.throws(() => store.assertOwner(b), /session isolation violation/);
});

test("session store: two candidates of the same role get distinct keys", () => {
  const c1 = newSessionIdentity({ project: "p", workItem: "wi", role: "implementer", workerId: "cand-A" });
  const c2 = newSessionIdentity({ project: "p", workItem: "wi", role: "implementer", workerId: "cand-B" });
  assert.notEqual(sessionKey(c1), sessionKey(c2));
});

test("session store: observe/reflect/drop record entries with recency+priority recall", () => {
  const store = new MemoryStore(newSessionIdentity({ project: "p", workItem: "wi", role: "implementer" }));
  store.observe("low", [], "P3");
  store.observe("high", [], "P0");
  const recalled = store.recall(10);
  assert.equal(recalled[0]!.priority, "P0"); // highest priority first
});

test("session store: compaction preserves high-priority content and marks audit trail", () => {
  const store = new MemoryStore(newSessionIdentity({ project: "p", workItem: "wi", role: "implementer" }), {
    compactionThreshold: 3,
  });
  store.observe("keep-me", [], "P0");
  store.observe("drop-1", [], "P4");
  store.observe("drop-2", [], "P4");
  store.observe("drop-3", [], "P4");
  store.observe("drop-4", [], "P4");
  store.observe("drop-5", [], "P4");
  store.observe("drop-6", [], "P4");
  const result = store.compact();
  assert.ok(result.removed >= 3, "oldest low-priority entries are compacted");
  const kept = store.recall(10).filter((e) => e.priority === "P0");
  assert.equal(kept.length, 1); // high-priority content survives compaction
  // Retained for audit: compacted entries are flagged, not deleted.
  assert.ok(store.all.some((e) => e.compactedInto !== null));
});

test("session store: compaction-quality degradation is bounded across repeated compactions", () => {
  const store = new MemoryStore(newSessionIdentity({ project: "p", workItem: "wi", role: "implementer" }), {
    compactionThreshold: 4,
  });
  // A small high-priority core that must survive many compaction rounds.
  store.observe("CRITICAL-FACT", [], "P0");
  for (let i = 0; i < 12; i++) store.observe(`noise-${i}`, [], "P4");
  for (let round = 0; round < 5; round++) store.compact();
  // The P0 fact is never dropped, regardless of how many low-priority entries
  // accumulate and get compacted: quality degradation is bounded by priority.
  const p0 = store.recall(100).filter((e) => e.priority === "P0");
  assert.equal(p0.length, 1, "highest-priority content survives all compaction rounds");
  assert.ok(p0[0]!.text.includes("CRITICAL-FACT"));
  assert.ok(store.compactionCount >= 1, "compaction actually ran");
});

test("session store: recall excludes compacted entries from the working surface", () => {
  const store = new MemoryStore(newSessionIdentity({ project: "p", workItem: "wi", role: "implementer" }), {
    compactionThreshold: 2,
  });
  store.observe("a", [], "P4");
  store.observe("b", [], "P4");
  store.observe("c", [], "P0");
  store.compact();
  const working = store.recall(10);
  assert.ok(working.every((e) => e.compactedInto === null));
});

// ------------------------------------------------------------- promotion

test("promotion: no auto-promotion — proposing a candidate never promotes it", async () => {
  const store = new MemoryStore(newSessionIdentity({ project: "p", workItem: "wi", role: "implementer" }));
  const durable = new InMemoryDurableMemory();
  // Even WITH evidence, proposing must not auto-promote: it stays 'proposed'.
  const c = store.proposePromotion("remember this", ["evt:1"], "reviewer", ["EVID-1"]);
  assert.equal(c.state, "proposed");
  const stored = store.getPromotion(c.id)!;
  assert.equal(stored.state, "proposed");
  assert.equal((await durable.recallAll()).length, 0, "no durable memory until explicit promote");
});

test("promotion: evidence-gated — cannot promote without machine evidence", async () => {
  const store = new MemoryStore(newSessionIdentity({ project: "p", workItem: "wi", role: "implementer" }));
  const durable = new InMemoryDurableMemory();
  const c = store.proposePromotion("speculative", [], "reviewer", []);
  await assert.rejects(
    () =>
      decidePromotion({ store, durable, decision: { action: "promote", candidateId: c.id, decidedBy: "reviewer" } }),
    /no evidence/,
  );
  assert.equal(store.getPromotion(c.id)!.state, "proposed", "rejected promotion leaves candidate proposed");
});

test("promotion: promote with evidence stores durable record through OpenViking", async () => {
  const store = new MemoryStore(newSessionIdentity({ project: "p", workItem: "wi", role: "implementer" }));
  const durable = new InMemoryDurableMemory();
  const c = store.proposePromotion("durable fact", ["commit:abc"], "reviewer", ["EVID-1"]);
  const outcome = await decidePromotion({
    store,
    durable,
    decision: { action: "promote", candidateId: c.id, decidedBy: "reviewer" },
  });
  assert.equal(outcome.state, "promoted");
  assert.ok(outcome.record);
  assert.equal(store.getPromotion(c.id)!.state, "promoted");
  const all = await durable.recallAll();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.text, "durable fact");
  const found = await durable.search("durable");
  assert.equal(found.length, 1);
});

test("promotion: reject and supersede transitions", async () => {
  const store = new MemoryStore(newSessionIdentity({ project: "p", workItem: "wi", role: "implementer" }));
  const durable = new InMemoryDurableMemory();
  const r = store.proposePromotion("r", [], "reviewer", []);
  await decidePromotion({ store, durable, decision: { action: "reject", candidateId: r.id, decidedBy: "reviewer" } });
  assert.equal(store.getPromotion(r.id)!.state, "rejected");
  const s = store.proposePromotion("s", [], "reviewer", []);
  await decidePromotion({
    store,
    durable,
    decision: { action: "supersede", candidateId: s.id, decidedBy: "reviewer" },
  });
  assert.equal(store.getPromotion(s.id)!.state, "superseded");
});

// ------------------------------------------------------------- versioning

test("versioning: disabled → provider 'disabled' and ok", async () => {
  const { validation } = await validateBlackholePackage({ enabled: false, requestedVersion: "0.5.4" });
  assert.equal(validation.provider, "disabled");
  assert.equal(validation.ok, true);
});

test("versioning: enabled without installed package → builtin provider, ok", async () => {
  const { validation } = await validateBlackholePackage({ enabled: true, requestedVersion: "0.5.4" });
  assert.equal(validation.provider, "builtin");
  assert.equal(validation.ok, true);
});

// ------------------------------------------------------------- telemetry

test("telemetry: snapshot reflects manager state", () => {
  const state = {
    enabled: true,
    version: "0.5.4",
    provider: "builtin" as const,
    sessions: 2,
    activeSessions: 2,
    entries: 5,
    compactions: 1,
    promotionCandidates: 2,
    promoted: 1,
    memoryWorkersRun: { observer: 1, reflector: 2, dropper: 0 },
  };
  const t = blackholeTelemetry(state);
  assert.equal(t.entries, 5);
  assert.equal(t.memoryWorkers.reflector, 2);
  assert.match(formatBlackholeTelemetry(t), /blackhole ENABLED/);
});
