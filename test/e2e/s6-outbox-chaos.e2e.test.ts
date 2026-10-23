/**
 * Acceptance scenario 6, Pi side: the durable outbox against a REAL control-plane process that crashes (SIGKILL),
 * restarts empty, sees duplicates, a dropped event, a revoked key and a lineage refusal.
 *
 * Contract under test: Pi never loses an undelivered event, never fabricates one, never reports delivery it did not
 * get, never double-applies a duplicate, and a refusal is dead-lettered AND counted (not swallowed).
 *
 * Honest limits: the in-memory control plane forgets everything on restart (durable replay is proven on the Herdr side
 * against a real PostgreSQL, tests/e2e/test_s6_chaos.py). Here that forgetting is itself the chaos: the server must
 * SHOW the loss as a gap, and Pi must not paper over it.
 *
 * A tiny TCP forwarder keeps the emitter's configured URL stable while the plane gets a new port on each restart
 * (the harness picks a fresh port per start; the emitter's URL is fixed at construction, as in production).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { createLineageEmitter } from "../../src/runtime/herdr/lineage.ts";
import { Plane, eventually, freePort } from "./support/plane.ts";

const FAST = { baseMs: 20, maxMs: 100, deadLetterAfter: 5 };
const uniq = (p: string) => `${p}-${randomBytes(3).toString("hex")}`;

function forwarder(target: () => number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const open = new Set<net.Socket>();
    const server = net.createServer((c) => {
      open.add(c);
      const up = net.connect(target(), "127.0.0.1");
      open.add(up);
      c.pipe(up);
      up.pipe(c);
      const kill = () => {
        c.destroy();
        up.destroy();
      };
      c.on("error", kill);
      up.on("error", kill);
      c.on("close", () => open.delete(c));
      up.on("close", () => open.delete(up));
    });
    freePort().then((port) =>
      server.listen(port, "127.0.0.1", () =>
        resolve({
          port,
          close: () => {
            for (const s of open) s.destroy();
            server.close();
          },
        }),
      ),
    );
  });
}

describe("scenario 6 (Pi): outbox under crash, duplicate, drop, revoked key, refusal", () => {
  let plane: Plane;
  let fwd: { port: number; close: () => void };
  let url: string;
  let root: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "s6-pi-"));
    plane = await Plane.start({
      keys: { pi: "ingest", scoped: "ingest", rival: "ingest" },
      scopes: { scoped: { rooms: ["room-allowed"], missions: [] } },
      users: [],
    });
    fwd = await forwarder(() => plane.port);
    url = `http://127.0.0.1:${fwd.port}`;
  });
  after(async () => {
    fwd?.close();
    await plane?.stop();
  });

  const mk = (dirName: string, source: string, keyLabel: string, rawKey?: string) => {
    const store = new EnvelopeStore({ dir: join(root, dirName), source });
    const ingest = new ControlPlaneIngest({
      url,
      apiKey: rawKey ?? plane.keys[keyLabel],
      envelopeStore: store,
      backoff: FAST,
      timeoutMs: 1500,
    });
    return { store, ingest };
  };
  const drain = async (ingest: ControlPlaneIngest, want: number) => {
    await eventually(
      async () => {
        await ingest.flushOutbox();
        return ingest.diagnostics()?.pending === want;
      },
      `outbox pending == ${want}`,
    );
  };
  const draft = (id: string, extra: Record<string, unknown> = {}) => ({
    occurred_at: new Date(),
    entity_type: "lineage",
    entity_id: id,
    event_type: "node.upsert",
    payload: { node_type: id.split(":")[0], node_id: id, state: "running" },
    visibility_scope: "org" as const,
    ...extra,
  });
  const post = (envelope: unknown, key = "pi") =>
    plane.call("POST", "/api/v1/ingest", { key, body: envelope });

  it("kill -9 mid-stream: Pi keeps what was not delivered, a restarted Pi replays it in order, and the loss on the server side is SHOWN as a gap, not hidden", async () => {
    const source = uniq("s6crash");
    const a = mk("crash", source, "pi");
    const em = createLineageEmitter({ ingest: a.ingest }, { visibility: "org" });
    assert.ok(em, "emitter needs an envelope-store ingest");
    em.workerSpawned({ agent: "lead", attempt: "lead.g1", session: "s-lead", missionId: "m1", taskId: "t0", role: "implementer", transition: "start" });
    await em.idle();
    await drain(a.ingest, 0);
    const before = (await plane.sources())[source];
    assert.ok(before && before.gaps?.length === 0 && (before.last_sequence ?? -1) >= 2, JSON.stringify(before));
    const seqBefore = before.last_sequence as number;
    assert.equal((await plane.node("agent:lead")).status, 200, "control: delivery works while the plane is up");

    await plane.stop("SIGKILL");
    assert.equal(plane.alive(), false);
    em.workerSpawned({ agent: "child", attempt: "child.g1", session: "s-child", parentAgent: "lead", parentAttempt: "lead.g1", missionId: "m1", taskId: "t1", role: "reviewer", transition: "start" });
    await em.idle();
    const during = a.ingest.diagnostics();
    assert.ok(during && during.pending > 0, `undelivered events must stay queued: ${JSON.stringify(during)}`);
    assert.equal(during.deadLettered + during.rejected + during.dropped, 0, "an outage is transient, never a loss");
    const queued = during.pending;

    // Pi itself restarts too: a NEW store/ingest on the same directory finds the same queue and continues the sequence
    const b = mk("crash", source, "pi");
    assert.equal((await b.store.outbox.peek()).length, queued, "the restarted Pi finds the same durable queue on disk");
    await plane.restart(); // empty memory, new port (the forwarder follows)
    await drain(b.ingest, 0);

    const after = (await plane.sources())[source];
    assert.ok(after, "source re-appears after replay");
    assert.ok((after.last_sequence ?? -1) > seqBefore, `replay continued the sequence past what was sent before the crash: ${JSON.stringify(after)}`);
    const finalDiag = b.ingest.diagnostics();
    // the two spawn edges point at a parent the (empty) server no longer knows: refused as lineage_forbidden, counted and
    // dead-lettered, not retried for ever and not turned into an edge
    assert.equal(finalDiag?.rejected, 2, JSON.stringify(finalDiag));
    const dead = readFileSync(b.store.outbox.deadLetterFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(dead.map((d) => d.reason), ["lineage_forbidden", "lineage_forbidden"]);
    assert.equal(finalDiag?.credentialProblem, false);
    assert.equal((await plane.node("agent:child")).status, 200, "the queued events were delivered");
    assert.equal((await plane.node("agent:lead")).status, 404, "Pi does not re-fabricate events the server forgot");
    const edges = await plane.edges("agent:child", "pi", 1);
    assert.ok(!edges.some((e) => e[0] === "spawn" && e[1] === "agent:lead"), "no spawn edge from a parent the server no longer knows");
  });

  it("duplicate events: a lost ack and a raw re-POST are both acknowledged as duplicates and apply nothing twice", async () => {
    const source = uniq("s6dup");
    const a = mk("dup", source, "pi");
    const staged = await a.store.stage(draft("agent:dupnode") as never);
    assert.ok("envelope" in staged);
    const env = (staged as { envelope: Record<string, unknown> }).envelope;
    // the server gets it, but Pi never sees the ack (crash before ackMany)
    const first = await post(env);
    assert.equal(first.status, 200);
    assert.equal(first.body.entity.envelope.duplicate, false);
    assert.equal(a.ingest.diagnostics()?.pending, 1, "Pi still believes it is undelivered");
    const acked = await a.ingest.flushOutbox();
    assert.equal(acked.size, 1, "the duplicate ack counts as delivered");
    assert.equal(a.ingest.diagnostics()?.pending, 0);
    const again = await post(env);
    assert.equal(again.status, 200);
    assert.equal(again.body.entity.envelope.duplicate, true);
    const s = (await plane.sources())[source];
    assert.equal(s?.last_sequence, env.source_sequence);
    assert.deepEqual(s?.gaps, []);
    const view = await plane.node("agent:dupnode");
    assert.equal(view.status, 200);
    assert.equal(a.ingest.diagnostics()?.deadLettered, 0);
    // a DIFFERENT event reusing the id under another sequence is a conflict, dead-lettered, never merged
    const clash = await post({ ...env, source_sequence: (env.source_sequence as number) + 1 });
    assert.ok([409, 400].includes(clash.status), `id reuse under another sequence must be refused, got ${clash.status}`);
    assert.equal((await plane.sources())[source]?.last_sequence, env.source_sequence, "a refused event does not advance the source");
  });

  it("a dropped event is detected by the server as a gap; Pi neither invents it nor leaves it open once it replays", async () => {
    const source = uniq("s6drop");
    const a = mk("drop", source, "pi");
    const e1 = ((await a.store.stage(draft("agent:d1") as never)) as { envelope: Record<string, unknown> }).envelope;
    const e2 = ((await a.store.stage(draft("agent:d2") as never)) as { envelope: Record<string, unknown> }).envelope;
    const e3 = ((await a.store.stage(draft("agent:d3") as never)) as { envelope: Record<string, unknown> }).envelope;
    assert.equal((await post(e1)).status, 200);
    assert.equal((await post(e3)).status, 200); // e2 "lost on the wire"
    const s = (await plane.sources())[source];
    assert.deepEqual(
      ((s?.gaps ?? []) as Array<{ from: number; to: number }>).map((g) => [g.from, g.to]),
      [[e2.source_sequence, e2.source_sequence]],
    );
    assert.equal((await plane.node("agent:d2")).status, 404, "the dropped event has no effect until it really arrives");
    assert.equal(a.ingest.diagnostics()?.pending, 3, "Pi has not been told anything was delivered");
    await drain(a.ingest, 0); // replay: d1 and d3 are duplicates, d2 is new
    const healed = (await plane.sources())[source];
    assert.deepEqual(healed?.gaps, []);
    assert.equal((await plane.node("agent:d2")).status, 200);
    assert.equal(a.ingest.diagnostics()?.rejected, 0);
  });

  it("a revoked / expired key keeps events queued (never dead-lettered) and the same queue delivers once the key is good", async () => {
    const source = uniq("s6key");
    const bad = mk("key", source, "pi", `expired-${randomBytes(8).toString("hex")}`);
    assert.equal(await bad.ingest.emitDraft(draft("agent:k1") as never), false);
    assert.equal(await bad.ingest.emitDraft(draft("agent:k2") as never), false);
    const d = bad.ingest.diagnostics();
    assert.ok(d);
    assert.equal(d.credentialProblem, true);
    assert.equal(d.pending, 2);
    assert.equal(d.deadLettered + d.rejected + d.dropped, 0, "401 is not a verdict on the event");
    assert.equal((await plane.node("agent:k1")).status, 404, "nothing was applied");
    assert.equal((await plane.sources())[source], undefined, "the server never heard of this source");
    const good = mk("key", source, "pi");
    assert.equal((await good.store.outbox.peek()).length, 2, "same durable queue");
    await drain(good.ingest, 0);
    const s = (await plane.sources())[source];
    assert.equal(s?.last_sequence, 2, "both queued events delivered in order");
    assert.deepEqual(s?.gaps, []);
    assert.equal((await plane.node("agent:k2")).status, 200);
  });

  it("a lineage refusal (403 lineage_forbidden) is dead-lettered with its reason AND counted; the queue behind it still flows; the burned sequence shows as a gap", async () => {
    const source = uniq("s6forb");
    const a = mk("forb", source, "scoped");
    // control: the scoped key MAY write its own room
    assert.equal(await a.ingest.emitDraft(draft("agent:allowed", { visibility_scope: "room", room_id: "room-allowed" }) as never), true);
    const forbidden = await a.ingest.emitDraft(draft("agent:intruder", { visibility_scope: "room", room_id: "room-other" }) as never);
    assert.equal(forbidden, false);
    assert.equal(await a.ingest.emitDraft(draft("agent:after", { visibility_scope: "private" }) as never), true, "the refusal does not block the queue");
    const d = a.ingest.diagnostics();
    assert.ok(d);
    assert.equal(d.credentialProblem, false, "a lineage refusal is not a credentials problem");
    assert.equal(d.rejected, 1, "the swallowed 403 IS counted");
    assert.equal(d.pending, 0);
    const dead = readFileSync(a.store.outbox.deadLetterFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(dead.length, 1);
    assert.equal(dead[0].reason, "lineage_forbidden");
    assert.equal(dead[0].http_status ?? dead[0].httpStatus, 403);
    assert.equal((await plane.node("agent:intruder")).status, 404, "nothing of the refused event exists");
    assert.equal((await plane.node("agent:allowed")).status, 200);
    assert.equal((await plane.node("agent:after", "scoped")).status, 200);
    const s = (await plane.sources())[source];
    assert.deepEqual(
      ((s?.gaps ?? []) as Array<{ from: number; to: number }>).map((g) => [g.from, g.to]),
      [[2, 2]],
      "the dead-lettered event's sequence is visible as a gap on the server: the loss is not hidden",
    );
  });
});
