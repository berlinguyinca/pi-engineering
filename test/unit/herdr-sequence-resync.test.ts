/**
 * T16 H6: a Pi whose source_sequence state is lost or rolled back must not dead-letter its new events forever.
 * A toy server mirrors Herdr's admission rules (per source: sequence -> event id; 409 on a taken number).
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { type TelemetryNotice, resetTelemetrySinks, setTelemetrySink } from "../../src/telemetry/sink.ts";

const SOURCE = "pi-test-aaaa1111";
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pi-seq-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  resetTelemetrySinks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Server {
  fetch: typeof globalThis.fetch;
  seqOwner: Map<number, string>;
  events: Map<string, string>;
  sourcesCalls: number;
}

function toyServer(opts: { hint?: boolean; sources?: "ok" | "404" } = {}): Server {
  const server: Server = { seqOwner: new Map(), events: new Map(), sourcesCalls: 0, fetch: undefined as never };
  const high = () => Math.max(0, ...server.seqOwner.keys());
  server.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/v1/ingest/sources")) {
      server.sourcesCalls++;
      if (opts.sources === "404") return json(404, { error: "not found" });
      return json(200, { sources: [{ source: SOURCE, actor: "key:abc", last_sequence: high() || null }] });
    }
    const e = JSON.parse(String(init?.body)) as { event_id: string; source_sequence: number; payload: unknown };
    const body = JSON.stringify(e.payload);
    const known = server.events.get(e.event_id);
    if (known !== undefined) {
      if (known === `${e.source_sequence}:${body}`) return json(200, { ok: true, duplicate: true });
      return json(409, { error: `event_id '${e.event_id}' already stored with different content`, reason: "conflict" });
    }
    const owner = server.seqOwner.get(e.source_sequence);
    if (owner !== undefined && owner !== e.event_id) {
      return json(409, {
        error: `sequence ${e.source_sequence} of source '${SOURCE}' already belongs to event '${owner}'`,
        reason: "conflict",
        ...(opts.hint ? { last_sequence: high() } : {}),
      });
    }
    server.seqOwner.set(e.source_sequence, e.event_id);
    server.events.set(e.event_id, `${e.source_sequence}:${body}`);
    return json(200, { ok: true });
  }) as typeof globalThis.fetch;
  return server;
}

const draft = (n: number) => ({
  occurred_at: new Date(),
  entity_type: "mission",
  entity_id: "m1",
  event_type: "mission.started",
  payload: { n },
});

function setup(dir: string, server: Server) {
  const store = new EnvelopeStore({ dir, source: SOURCE });
  const ingest = new ControlPlaneIngest({
    url: "http://127.0.0.1:9",
    host: { hostId: "h" },
    fetch: server.fetch,
    envelopeStore: store,
  });
  return { store, ingest };
}

describe("source_sequence recovery (T16 H6)", () => {
  it("a restored older snapshot re-numbers new events from the server's high-water mark; nothing is dead-lettered", async () => {
    const server = toyServer();
    const dir = tmp();
    const before = setup(dir, server);
    for (let i = 1; i <= 3; i++) assert.equal(await before.ingest.emitDraft(draft(i)), true);
    cpSync(dir, `${dir}-snap`, { recursive: true });
    dirs.push(`${dir}-snap`);
    for (let i = 4; i <= 6; i++) assert.equal(await before.ingest.emitDraft(draft(i)), true);
    assert.equal(Math.max(...server.seqOwner.keys()), 6);
    // restore: sequence and outbox go back to the state after event 3
    rmSync(dir, { recursive: true });
    cpSync(`${dir}-snap`, dir, { recursive: true });
    const notices: TelemetryNotice[] = [];
    setTelemetrySink((n) => notices.push(n));
    const { store, ingest } = setup(dir, server);
    for (let i = 7; i <= 9; i++) assert.equal(await ingest.emitDraft(draft(i)), true, `event ${i} was delivered`);
    assert.equal(server.events.size, 9, "all nine events are on the server");
    assert.ok(Math.min(...[...server.seqOwner.keys()].slice(6)) > 6, "new numbers are above the old high-water mark");
    const diag = ingest.diagnostics();
    assert.equal(diag?.rejected, 0);
    assert.equal(diag?.deadLettered, 0);
    assert.equal(diag?.conflictDeadLettered, 0);
    assert.equal(store.resyncs >= 1, true);
    assert.ok(notices.some((n) => n.key === "herdr-sequence-resync" && n.level === "warning"));
  });

  it("a deleted sequence file with a pending outbox resumes above the outbox (no collision at all)", async () => {
    const server = toyServer();
    const down = (async () => new Response("{}", { status: 503 })) as typeof globalThis.fetch;
    const dir = tmp();
    const offline = new ControlPlaneIngest({
      url: "http://127.0.0.1:9",
      host: { hostId: "h" },
      fetch: down,
      envelopeStore: new EnvelopeStore({ dir, source: SOURCE }),
    });
    await offline.emitDraft(draft(1));
    await offline.emitDraft(draft(2));
    rmSync(join(dir, `sequence-${SOURCE}.json`));
    const notices: TelemetryNotice[] = [];
    setTelemetrySink((n) => notices.push(n));
    const { store, ingest } = setup(dir, server);
    await ingest.emitDraft(draft(3));
    await ingest.flushOutbox();
    assert.deepEqual(
      [...server.seqOwner.keys()].sort((a, b) => a - b),
      [1, 2, 3],
    );
    assert.equal(store.sequence.regressions, 1);
    assert.ok(notices.some((n) => n.key === "herdr-sequence-regress"));
    assert.equal(server.sourcesCalls, 0, "local evidence was enough");
  });

  it("the sequence file is replaced atomically and fsynced state is what a restart reads", async () => {
    const dir = tmp();
    const store = new EnvelopeStore({ dir, source: SOURCE });
    await store.stage(draft(1));
    await store.stage(draft(2));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, `sequence-${SOURCE}.json`), "utf8")), {
      source: SOURCE,
      next: 3,
    });
  });

  it("everything lost (sequence file and outbox): the server's sources listing supplies the high-water mark", async () => {
    const server = toyServer();
    const dir = tmp();
    const first = setup(dir, server);
    for (let i = 1; i <= 4; i++) await first.ingest.emitDraft(draft(i));
    const fresh = tmp();
    // same source, brand-new state directory (instance-id kept by the operator, everything else gone)
    const { ingest } = setup(fresh, server);
    assert.equal(await ingest.emitDraft(draft(5)), true);
    assert.equal(server.events.size, 5);
    assert.ok(server.sourcesCalls >= 1);
    assert.equal(ingest.diagnostics()?.deadLettered, 0);
  });

  it("a high-water hint in the 409 body is used without a second request", async () => {
    const server = toyServer({ hint: true });
    const dir = tmp();
    const first = setup(dir, server);
    for (let i = 1; i <= 3; i++) await first.ingest.emitDraft(draft(i));
    const { ingest } = setup(tmp(), server);
    assert.equal(await ingest.emitDraft(draft(4)), true);
    assert.equal(server.sourcesCalls, 0);
  });

  it("when the high-water mark cannot be learned the event is dead-lettered LOUDLY, not silently", async () => {
    const server = toyServer({ sources: "404" });
    const first = setup(tmp(), server);
    for (let i = 1; i <= 2; i++) await first.ingest.emitDraft(draft(i));
    const notices: TelemetryNotice[] = [];
    setTelemetrySink((n) => notices.push(n));
    const { ingest } = setup(tmp(), server);
    assert.equal(await ingest.emitDraft(draft(3)), false);
    const diag = ingest.diagnostics();
    assert.equal(diag?.rejected, 1);
    assert.equal(diag?.conflictDeadLettered, 1);
    const loud = notices.filter((n) => n.level === "error" && n.key?.startsWith("herdr-sequence-conflict"));
    assert.equal(loud.length, 1);
    assert.match(loud[0]?.text ?? "", /high-water mark/);
  });

  it("a content contradiction (same event id, other content) is not 'fixed' by re-numbering", async () => {
    const server = toyServer();
    const { store, ingest } = setup(tmp(), server);
    const staged = await store.stage({ ...draft(1), event_id: "evt-fixed-1" });
    assert.ok("envelope" in staged);
    server.events.set("evt-fixed-1", '1:{"n":999}');
    const notices: TelemetryNotice[] = [];
    setTelemetrySink((n) => notices.push(n));
    await ingest.flushOutbox();
    assert.equal(store.resyncs, 0);
    assert.equal(ingest.diagnostics()?.conflictDeadLettered, 1);
  });
});
