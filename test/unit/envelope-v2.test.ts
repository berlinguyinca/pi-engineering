/**
 * Envelope v2 (T01, Pi side): builder, persisted source_sequence, durable
 * outbox replay, adapters, and standalone (control plane unconfigured) mode.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { LedgerEvent } from "../../src/core/types.ts";
import type { TelemetryEvent } from "../../src/lifecycle/telemetry.ts";
import type { PlatformEvent } from "../../src/platform/types.ts";
import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";
import { buildEnvelope } from "../../src/runtime/herdr/envelope.ts";
import {
  inspectorEventToDraft,
  ledgerEventToDraft,
  platformEventToDraft,
  telemetryEventToDraft,
} from "../../src/runtime/herdr/envelopeAdapters.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { EnvelopeOutbox } from "../../src/runtime/herdr/outbox.ts";
import { SourceSequence } from "../../src/runtime/herdr/sourceSequence.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-envelope-"));
const draft = (id?: string) => ({
  event_id: id,
  occurred_at: "2026-10-22T10:00:00Z",
  entity_type: "session",
  entity_id: "s1",
  event_type: "session.started",
  payload: {},
});

// ── builder ──────────────────────────────────────────────────────────────────

test("buildEnvelope: v2 shape, private default, no trusted actor/received_at", () => {
  const e = buildEnvelope(
    {
      ...draft("e1"),
      mission_id: "m1",
      correlation_id: "c1",
      causation_id: "e0",
      evidence_refs: [{ kind: "git", uri: "x", revision: "abc" }],
    },
    { source: "pi", sourceSequence: 7 },
  );
  assert.equal(e.schema_version, 2);
  assert.equal(e.event_id, "e1");
  assert.equal(e.source_sequence, 7);
  assert.equal(e.occurred_at, "2026-10-22T10:00:00.000Z");
  assert.equal(e.visibility_scope, "private");
  assert.equal(e.mission_id, "m1");
  assert.equal(e.causation_id, "e0");
  assert.deepEqual(e.evidence_refs, [{ kind: "git", uri: "x", revision: "abc" }]);
  assert.equal("actor" in e, false);
  assert.equal("received_at" in e, false);
});

test("buildEnvelope: unknown visibility fails closed, bad source/sequence throw, event_id generated", () => {
  const e = buildEnvelope({ ...draft(), visibility_scope: "everyone" as never }, { source: "pi", sourceSequence: 0 });
  assert.equal(e.visibility_scope, "private");
  assert.ok(e.event_id.length > 0);
  assert.throws(() => buildEnvelope(draft(), { source: "Bad Source", sourceSequence: 1 }), TypeError);
  assert.throws(() => buildEnvelope(draft(), { source: "pi", sourceSequence: -1 }), TypeError);
  assert.throws(
    () => buildEnvelope({ ...draft(), occurred_at: "nope" }, { source: "pi", sourceSequence: 1 }),
    TypeError,
  );
});

// ── sequence ─────────────────────────────────────────────────────────────────

test("SourceSequence: monotonic, never reused across simulated restarts", async () => {
  const dir = tmp();
  const seen: number[] = [];
  for (let restart = 0; restart < 3; restart++) {
    const seq = new SourceSequence({ dir, source: "pi" }); // a fresh instance == a restart
    for (let i = 0; i < 4; i++) seen.push(await seq.next());
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("SourceSequence: concurrent allocations (many instances) never collide", async () => {
  const dir = tmp();
  const seqs = Array.from({ length: 4 }, () => new SourceSequence({ dir, source: "pi" }));
  const got = await Promise.all(Array.from({ length: 60 }, (_, i) => (seqs[i % 4] as SourceSequence).next()));
  assert.equal(new Set(got).size, 60);
  assert.deepEqual(
    [...got].sort((a, b) => a - b),
    Array.from({ length: 60 }, (_, i) => i + 1),
  );
});

test("SourceSequence: concurrent allocations across real processes never collide", async () => {
  const dir = tmp();
  const script = join(tmp(), "alloc.ts");
  writeFileSync(
    script,
    `import { SourceSequence } from ${JSON.stringify(join(process.cwd(), "src/runtime/herdr/sourceSequence.ts"))};
const s = new SourceSequence({ dir: process.argv[2], source: "pi" });
const out = [];
for (let i = 0; i < 15; i++) out.push(await s.next());
console.log(JSON.stringify(out));`,
  );
  const { spawn } = await import("node:child_process");
  const run = () =>
    new Promise<number[]>((resolve, reject) => {
      const p = spawn(process.execPath, [script, dir], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (d) => {
        out += d;
      });
      p.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
    });
  const all = (await Promise.all([run(), run(), run()])).flat();
  assert.equal(new Set(all).size, 45);
  assert.equal(Math.max(...all), 45);
});

test("SourceSequence: a corrupt state file fails closed instead of restarting at 1", async () => {
  const dir = tmp();
  const seq = new SourceSequence({ dir, source: "pi" });
  await seq.next();
  writeFileSync(join(dir, "sequence-pi.json"), "{not json");
  await assert.rejects(() => seq.next(), /corrupt/);
});

test("SourceSequence: an unprobeable stale lock (old, garbage owner) is recovered", async () => {
  const dir = tmp();
  const seq = new SourceSequence({ dir, source: "pi", staleLockMs: 50 });
  await seq.next();
  writeFileSync(join(dir, "sequence-pi.json.lock"), "garbage");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await seq.next(), 2);
});

// ── outbox ───────────────────────────────────────────────────────────────────

test("outbox: replay order is append order, ack removes, torn tail tolerated", async () => {
  const dir = tmp();
  const file = join(dir, "outbox.jsonl");
  const box = new EnvelopeOutbox({ file });
  const mk = (n: number) => buildEnvelope(draft(`e${n}`), { source: "pi", sourceSequence: n });
  for (let n = 1; n <= 4; n++) await box.append(mk(n));
  await box.ack("e2");
  assert.deepEqual(
    (await box.pending()).map((e) => e.event_id),
    ["e1", "e3", "e4"],
  );
  writeFileSync(file, `${readFileSync(file, "utf8")}{"t":"event","envelope":{"event_id":"torn`);
  const reopened = new EnvelopeOutbox({ file }); // restart
  assert.deepEqual(
    (await reopened.pending()).map((e) => e.event_id),
    ["e1", "e3", "e4"],
  );
  await reopened.append(mk(5)); // heals the torn tail
  assert.deepEqual(
    (await reopened.pending()).map((e) => e.event_id),
    ["e1", "e3", "e4", "e5"],
  );
});

test("outbox: re-appending an existing event_id does not duplicate or reorder", async () => {
  const box = new EnvelopeOutbox({ file: join(tmp(), "o.jsonl") });
  const mk = (n: number) => buildEnvelope(draft(`e${n}`), { source: "pi", sourceSequence: n });
  await box.append(mk(1));
  await box.append(mk(2));
  await box.append(mk(1));
  assert.deepEqual(
    (await box.pending()).map((e) => e.event_id),
    ["e1", "e2"],
  );
});

test("outbox: cap drops the oldest and counts it", async () => {
  const box = new EnvelopeOutbox({ file: join(tmp(), "o.jsonl"), maxPending: 3 });
  for (let n = 1; n <= 5; n++) await box.append(buildEnvelope(draft(`e${n}`), { source: "pi", sourceSequence: n }));
  assert.deepEqual(
    (await box.pending()).map((e) => e.event_id),
    ["e3", "e4", "e5"],
  );
  assert.equal(box.dropped, 2);
});

// ── ControlPlaneIngest + outbox ──────────────────────────────────────────────

function scriptedFetch(statuses: Array<number | "throw">, bodies: Array<Record<string, unknown>>) {
  let i = 0;
  return (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const s = statuses[Math.min(i++, statuses.length - 1)];
    if (s === "throw") throw new Error("down");
    return new Response("{}", { status: s as number });
  }) as typeof globalThis.fetch;
}

test("ingest+outbox: Herdr down -> events kept; restart replays in order with identical ids/sequences", async () => {
  const dir = tmp();
  const down: Array<Record<string, unknown>> = [];
  const a = new ControlPlaneIngest({
    url: "http://x",
    fetch: scriptedFetch(["throw"], down),
    envelopeStore: new EnvelopeStore({ dir, sequenceBlock: 1 }),
    backoff: { baseMs: 0 },
  });
  assert.equal(await a.emit("session", "s1", "session.started", { mission_id: "m1" }), false);
  assert.equal(await a.emit("session", "s1", "session.updated"), false);
  // order is preserved: the second emit retried #1 (same id) and never sent #2 past it
  assert.equal(down.length, 2);
  assert.equal(down[0]?.event_id, down[1]?.event_id);
  const ids = (await new EnvelopeStore({ dir, sequenceBlock: 1 }).outbox.pending()).map((e) => [
    e.event_id,
    e.source_sequence,
  ]);
  assert.equal(ids.length, 2);

  // "restart": new store + client over the same directory, Herdr back up
  const up: Array<Record<string, unknown>> = [];
  const b = new ControlPlaneIngest({
    url: "http://x",
    fetch: scriptedFetch([200], up),
    envelopeStore: new EnvelopeStore({ dir, sequenceBlock: 1 }),
  });
  const acked = await b.flushOutbox();
  assert.equal(acked.size, 2);
  assert.deepEqual(
    up.map((x) => [x.event_id, x.source_sequence]),
    ids,
  );
  assert.deepEqual(
    up.map((x) => x.source_sequence),
    [1, 2],
  );
  assert.equal(up[0]?.schema_version, 2);
  assert.equal(up[0]?.mission_id, "m1");
  assert.match(String(up[0]?.source), /^pi-[a-z0-9-]+-[0-9a-f]{8}$/);
  assert.equal((await new EnvelopeStore({ dir, sequenceBlock: 1 }).outbox.pending()).length, 0);
  // new events continue after the replayed range
  assert.equal(await b.emit("session", "s1", "session.terminated"), true);
  assert.equal(up[2]?.source_sequence, 3);
});

test("ingest+outbox: transient failure preserves order (later events are not sent past it)", async () => {
  const dir = tmp();
  const sent: Array<Record<string, unknown>> = [];
  const c = new ControlPlaneIngest({
    url: "http://x",
    fetch: scriptedFetch([503, 200, 200, 200], sent),
    envelopeStore: new EnvelopeStore({ dir, sequenceBlock: 1 }),
    backoff: { baseMs: 0 },
  });
  assert.equal(await c.emit("host", "h", "host.heartbeat"), false); // 503 -> stays pending
  assert.equal(await c.emit("host", "h", "host.heartbeat"), true); // replays #1 then #2
  assert.deepEqual(
    sent.map((b) => b.source_sequence),
    [1, 1, 2],
  );
  assert.equal(sent[0]?.event_id, sent[1]?.event_id); // retry reuses event_id
});

test("ingest+outbox: 409 conflict and 400 are rejected, counted, never reported delivered", async () => {
  const dir = tmp();
  const sent: Array<Record<string, unknown>> = [];
  const c = new ControlPlaneIngest({
    url: "http://x",
    fetch: scriptedFetch([409, 400, 200], sent),
    envelopeStore: new EnvelopeStore({ dir, sequenceBlock: 1 }),
  });
  assert.equal(await c.emit("host", "h", "host.heartbeat"), false); // 409: conflict, not delivered
  assert.equal(c.rejected, 1);
  assert.equal(await c.emit("host", "h", "host.heartbeat"), false); // 400
  assert.equal(c.rejected, 2);
  assert.equal(await c.emit("host", "h", "host.heartbeat"), true); // 200
  assert.equal((await new EnvelopeStore({ dir, sequenceBlock: 1 }).outbox.pending()).length, 0);
});

test("ingest+outbox: concurrent emits keep outbox order == sequence order", async () => {
  const dir = tmp();
  const sent: Array<Record<string, unknown>> = [];
  const c = new ControlPlaneIngest({
    url: "http://x",
    fetch: scriptedFetch([200], sent),
    envelopeStore: new EnvelopeStore({ dir, sequenceBlock: 1 }),
  });
  await Promise.all(Array.from({ length: 20 }, (_, i) => c.emit("session", `s${i}`, "session.updated")));
  const seqs = sent.map((b) => b.source_sequence as number);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );
  assert.equal(new Set(seqs).size, 20);
});

// ── standalone ───────────────────────────────────────────────────────────────

test("standalone: no envelope store -> v1 body unchanged, no disk, never throws", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const c = new ControlPlaneIngest({ url: "http://x", fetch: scriptedFetch([200], sent) });
  assert.equal(await c.emit("session", "s1", "session.started"), true);
  assert.deepEqual(Object.keys(sent[0] as object).sort(), ["entity_id", "entity_type", "event_type", "payload"]);
  assert.equal((await c.flushOutbox()).size, 0);
  assert.equal(await c.emitDraft(draft("e")), false);
  const dead = new ControlPlaneIngest({ url: "http://x", fetch: scriptedFetch(["throw"], []) });
  assert.equal(await dead.emit("session", "s1", "session.started"), false);
});

test("standalone: unconfigured state dir failure does not throw out of emit", async () => {
  const file = join(tmp(), "blocker");
  writeFileSync(file, "x"); // a FILE where the store directory should be
  const c = new ControlPlaneIngest({
    url: "http://x",
    fetch: scriptedFetch([200], []),
    envelopeStore: new EnvelopeStore({ dir: join(file, "sub") }),
  });
  assert.equal(await c.emit("session", "s1", "session.started"), false);
});

// ── adapters ─────────────────────────────────────────────────────────────────

test("adapter: LedgerEvent keeps its event_id, claims actor in payload, copies only explicit ids", () => {
  const ev: LedgerEvent = {
    event_id: "EVT-1",
    work_item_id: "WI-1",
    timestamp: "2026-10-22T10:00:00Z",
    actor: { type: "agent", role: "implementer" },
    type: "task.started",
    payload: {
      task_id: "T9",
      causation_id: "EVT-0",
      evidence_refs: [{ kind: "test-run", uri: "test-run://1" }, { bogus: true }],
    },
  };
  const e = buildEnvelope(ledgerEventToDraft(ev), { source: "pi", sourceSequence: 1 });
  assert.equal(e.event_id, "EVT-1");
  assert.equal(e.event_type, "task.started");
  assert.equal(e.entity_id, "WI-1");
  assert.equal(e.task_id, "T9");
  assert.equal(e.causation_id, "EVT-0");
  assert.equal(e.mission_id, undefined);
  assert.deepEqual(e.evidence_refs, [{ kind: "test-run", uri: "test-run://1" }]);
  assert.deepEqual(e.payload.claimed_actor, { type: "agent", role: "implementer" });
  assert.equal("actor" in e, false);
  const none = buildEnvelope(ledgerEventToDraft({ ...ev, payload: {} }), { source: "pi", sourceSequence: 2 });
  assert.equal(none.causation_id, undefined);
});

test("adapter: PlatformEvent maps typed project/worker ids; no lineage guessed from parent ids", () => {
  const ev: PlatformEvent = {
    event_id: "PE-1",
    project_id: "P1",
    run_id: "R1",
    worker_id: "W1",
    timestamp: "2026-10-22T10:00:00Z",
    type: "platform.worker.created",
    actor: "system",
    payload: { parentWorkerId: "W0" },
  };
  const e = buildEnvelope(platformEventToDraft(ev), { source: "pi", sourceSequence: 1 });
  assert.equal(e.project_id, "P1");
  assert.equal(e.agent_id, "W1");
  assert.equal(e.entity_id, "R1");
  assert.equal(e.causation_id, undefined);
  assert.equal(e.payload.parentWorkerId, "W0");
  assert.deepEqual(e.payload.claimed_actor, { type: "system" });
});

test("adapter: TelemetryEvent maps correlation, is deterministic, accepts an explicit id", () => {
  const ev: TelemetryEvent = {
    at: "2026-10-22T10:00:00Z",
    name: "lifecycle.transition",
    runId: "R1",
    sessionKey: "S1",
    attributes: { from: "a", to: "b" },
    correlation: "corr-1",
  };
  const a = telemetryEventToDraft(ev);
  assert.equal(a.event_id, telemetryEventToDraft(ev).event_id);
  assert.equal(telemetryEventToDraft(ev, "fixed").event_id, "fixed");
  const e = buildEnvelope(a, { source: "pi", sourceSequence: 1 });
  assert.equal(e.correlation_id, "corr-1");
  assert.equal(e.event_type, "lifecycle.transition");
  assert.equal(e.entity_id, "R1");
  assert.equal(e.payload.session_key, "S1");
  assert.equal(e.payload.from, "a");
});

test("adapter: InspectorEvent keeps parent_agent_id as data, never as causation; stays private", () => {
  const e = buildEnvelope(
    inspectorEventToDraft(
      { kind: "tool_call", agent_id: "a2", parent_agent_id: "a1", ts: "2026-10-22T10:00:00Z", event_id: "I-1" },
      { sessionId: "pane-1", missionId: "M1" },
    ),
    { source: "pi", sourceSequence: 3 },
  );
  assert.equal(e.event_id, "I-1");
  assert.equal(e.event_type, "inspector.tool_call");
  assert.equal(e.entity_id, "pane-1");
  assert.equal(e.agent_id, "a2");
  assert.equal(e.mission_id, "M1");
  assert.equal(e.causation_id, undefined);
  assert.equal(e.payload.parent_agent_id, "a1");
  assert.equal(e.visibility_scope, "private");
  const noId = inspectorEventToDraft({ kind: "file", ts: "2026-10-22T10:00:00Z" }, { sessionId: "p" });
  assert.match(noId.event_id as string, /^insp_/);
});
