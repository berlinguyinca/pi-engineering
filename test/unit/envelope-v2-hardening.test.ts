/**
 * Envelope v2 hardening: delivery policy (no head-of-line stall), outbox
 * performance and durability, lock atomicity under real processes, dedupe,
 * per-instance source, file modes, redaction, size cap.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";
import { buildEnvelope } from "../../src/runtime/herdr/envelope.ts";
import { telemetryEventToDraft } from "../../src/runtime/herdr/envelopeAdapters.ts";
import { EnvelopeStore, defaultSource } from "../../src/runtime/herdr/envelopeStore.ts";
import { EnvelopeOutbox } from "../../src/runtime/herdr/outbox.ts";
import { withFileLock } from "../../src/runtime/herdr/portableLock.ts";
import { SourceSequence } from "../../src/runtime/herdr/sourceSequence.ts";
import { resetTelemetrySinks, setTelemetrySink } from "../../src/telemetry/sink.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-envh-"));
const draft = (id: string, extra: Record<string, unknown> = {}) => ({
  event_id: id,
  occurred_at: "2026-10-22T10:00:00Z",
  entity_type: "session",
  entity_id: "s1",
  event_type: "session.updated",
  payload: {},
  ...extra,
});
const mode = (p: string) => statSync(p).mode & 0o777;
const lines = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

type Step = number | "throw" | { status: number; headers?: Record<string, string> };
function scripted(steps: Step[], sent: Array<Record<string, unknown>>) {
  let i = 0;
  return (async (_u: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    const s = steps[Math.min(i++, steps.length - 1)] as Step;
    if (s === "throw") throw new Error("down");
    if (typeof s === "number") return new Response("{}", { status: s });
    return new Response("{}", { status: s.status, headers: s.headers });
  }) as typeof globalThis.fetch;
}
function client(dir: string, steps: Step[], sent: Array<Record<string, unknown>>, extra = {}) {
  let t = 1_000_000;
  const c = new ControlPlaneIngest({
    url: "http://x",
    fetch: scripted(steps, sent),
    envelopeStore: new EnvelopeStore({ dir }),
    now: () => t,
    ...extra,
  });
  return {
    c,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// ── BLOCKER 1: delivery policy ───────────────────────────────────────────────

test("401/403: stays queued, backs off exponentially (time-based), is never dropped", async () => {
  const dir = tmp();
  const sent: Array<Record<string, unknown>> = [];
  const { c, advance } = client(dir, [401, 403, 401, 401, 401, 401, 401, 401, 401, 401, 200], sent, {
    backoff: { baseMs: 1000, maxMs: 8000, deadLetterAfter: 2 },
  });
  assert.equal(await c.emit("host", "h", "host.heartbeat"), false);
  assert.equal(c.diagnostics()?.credentialProblem, true);
  const n = sent.length;
  await c.flushOutbox(); // inside the back-off window: no request at all
  assert.equal(sent.length, n);
  advance(1000);
  await c.flushOutbox(); // 2nd failure -> 2s
  advance(1999);
  await c.flushOutbox();
  assert.equal(sent.length, n + 1);
  advance(1);
  await c.flushOutbox();
  assert.equal(sent.length, n + 2);
  for (let i = 0; i < 7; i++) {
    advance(8000); // capped
    await c.flushOutbox();
  }
  const d = c.diagnostics();
  assert.equal(d?.deadLettered, 0);
  assert.equal(d?.dropped, 0);
  assert.equal(d?.pending, 1, "credentials problems never drop the event");
  advance(8000);
  await c.flushOutbox();
  assert.equal(c.diagnostics()?.pending, 0);
  assert.equal(c.diagnostics()?.credentialProblem, false);
});

test("deterministic 5xx on the head event is dead-lettered after N tries and the queue flows", async () => {
  const dir = tmp();
  const sent: Array<Record<string, unknown>> = [];
  const { c, advance } = client(dir, [500, 500, 500, 200], sent, {
    backoff: { baseMs: 10, maxMs: 10, deadLetterAfter: 3 },
  });
  // stage two events while the head is poisoned
  await c.emit("session", "poison", "session.updated");
  await c.emit("session", "next", "session.updated");
  for (let i = 0; i < 5; i++) {
    advance(100);
    await c.flushOutbox();
  }
  const d = c.diagnostics();
  assert.equal(d?.pending, 0);
  assert.equal(d?.deadLettered, 1);
  const store = (c as unknown as { envelopeStore: EnvelopeStore }).envelopeStore;
  const dl = lines(store.outbox.deadLetterFile);
  assert.equal(dl.length, 1);
  assert.equal(dl[0].reason, "repeated_5xx");
  assert.equal(dl[0].http_status, 500);
  assert.equal(dl[0].envelope.entity_id, "poison");
  assert.ok(dl[0].at);
  assert.equal(mode(store.outbox.deadLetterFile), 0o600);
  assert.equal(sent.at(-1)?.entity_id, "next");
});

test("network errors never dead-letter, however many; 429 honours Retry-After", async () => {
  const dir = tmp();
  const sent: Array<Record<string, unknown>> = [];
  const { c, advance } = client(dir, ["throw"], sent, { backoff: { baseMs: 1, maxMs: 1, deadLetterAfter: 2 } });
  await c.emit("host", "h", "host.heartbeat");
  for (let i = 0; i < 10; i++) {
    advance(5);
    await c.flushOutbox();
  }
  assert.equal(c.diagnostics()?.deadLettered, 0);
  assert.equal(c.diagnostics()?.pending, 1);

  const sent2: Array<Record<string, unknown>> = [];
  const b = client(tmp(), [{ status: 429, headers: { "retry-after": "30" } }, 200], sent2, {
    backoff: { baseMs: 1, maxMs: 60_000, deadLetterAfter: 2 },
  });
  await b.c.emit("host", "h", "host.heartbeat");
  b.advance(29_000);
  await b.c.flushOutbox();
  assert.equal(sent2.length, 1);
  b.advance(1000);
  await b.c.flushOutbox();
  assert.equal(b.c.diagnostics()?.pending, 0);
  assert.equal(b.c.diagnostics()?.deadLettered, 0);
});

test("other 4xx (404, 413) are terminal -> dead-letter immediately, later events still flow", async () => {
  const dir = tmp();
  const sent: Array<Record<string, unknown>> = [];
  const { c } = client(dir, [404, 413, 200], sent);
  await c.emit("host", "a", "host.heartbeat");
  await c.emit("host", "b", "host.heartbeat");
  await c.emit("host", "c", "host.heartbeat");
  const d = c.diagnostics();
  assert.equal(d?.deadLettered, 2);
  assert.equal(d?.pending, 0);
  assert.deepEqual(
    lines((c as unknown as { envelopeStore: EnvelopeStore }).envelopeStore.outbox.deadLetterFile).map(
      (r) => r.http_status,
    ),
    [404, 413],
  );
});

// ── MAJOR 2: performance ─────────────────────────────────────────────────────

test("outbox perf: stage + deliver scales linearly (no per-emit rescan) and 2000 events finish", async () => {
  async function run(n: number): Promise<number> {
    const sent: Array<Record<string, unknown>> = [];
    const c = new ControlPlaneIngest({
      url: "http://x",
      fetch: scripted([200], sent),
      envelopeStore: new EnvelopeStore({ dir: tmp() }),
    });
    const t0 = Date.now();
    for (let i = 0; i < n; i++) assert.equal(await c.emit("session", `s${i}`, "session.updated"), true);
    const ms = Date.now() - t0;
    assert.equal(sent.length, n);
    assert.equal(c.diagnostics()?.pending, 0);
    return ms;
  }
  const small = await run(500);
  const big = await run(2000);
  console.log(`# perf: 500 emit+deliver=${small}ms, 2000 emit+deliver=${big}ms`);
  // 4x the events must cost ~4x; a quadratic rescan would cost ~16x.
  assert.ok(big < small * 7, `non-linear: 500=${small}ms 2000=${big}ms`);
});

test("outbox: index survives restart and picks up another process's appends without a rescan", async () => {
  const file = join(tmp(), "o.jsonl");
  const a = new EnvelopeOutbox({ file });
  const b = new EnvelopeOutbox({ file });
  const mk = (n: number) => buildEnvelope(draft(`e${n}`), { source: "pi", sourceSequence: n });
  await a.append(mk(1));
  await b.append(mk(2));
  assert.deepEqual(
    (await a.peek()).map((e) => e.event_id),
    ["e1", "e2"],
  );
  await a.ack("e1");
  assert.deepEqual(
    (await b.peek()).map((e) => e.event_id),
    ["e2"],
  );
});

test("outbox: compaction keeps live events and shrinks the file", async () => {
  const file = join(tmp(), "o.jsonl");
  const box = new EnvelopeOutbox({ file, compactMinTombstones: 10 });
  const mk = (n: number) => buildEnvelope(draft(`e${n}`), { source: "pi", sourceSequence: n });
  for (let n = 1; n <= 30; n++) await box.append(mk(n));
  const before = await box.sizeBytes();
  for (let n = 1; n <= 28; n++) await box.ack(`e${n}`);
  assert.deepEqual(
    (await box.peek()).map((e) => e.event_id),
    ["e29", "e30"],
  );
  assert.ok((await box.sizeBytes()) < before / 2);
  assert.deepEqual(
    (await new EnvelopeOutbox({ file }).peek()).map((e) => e.event_id),
    ["e29", "e30"],
  );
});

// ── MAJOR 3: no silent loss ──────────────────────────────────────────────────

test("overflow drop and 409 rejection are durable, counted, and reported once per episode", async () => {
  const notices: string[] = [];
  const off = setTelemetrySink((n) => {
    if (n.key === "herdr-outbox-loss") notices.push(n.text);
  });
  try {
    const dir = tmp();
    const store = new EnvelopeStore({ dir, maxPending: 2 });
    for (let i = 1; i <= 5; i++) await store.stage(draft(`d${i}`));
    const s = store.stats();
    assert.equal(s.dropped, 3);
    assert.equal(s.pending, 2);
    const dl = lines(store.outbox.deadLetterFile);
    assert.deepEqual(
      dl.map((r) => [r.reason, r.envelope.event_id]),
      [
        ["overflow_dropped", "d1"],
        ["overflow_dropped", "d2"],
        ["overflow_dropped", "d3"],
      ],
    );
    assert.equal(notices.length, 1, "one notice per episode");
  } finally {
    off();
    resetTelemetrySinks();
  }
});

test("409 rejection is written to the dead-letter file and counted", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const { c } = client(tmp(), [409], sent);
  await c.emit("host", "h", "host.heartbeat");
  assert.equal(c.rejected, 1);
  assert.equal(c.diagnostics()?.rejected, 1);
  const store = (c as unknown as { envelopeStore: EnvelopeStore }).envelopeStore;
  assert.equal(lines(store.outbox.deadLetterFile)[0].reason, "server_rejected");
  assert.equal(lines(store.outbox.deadLetterFile)[0].http_status, 409);
});

// ── MAJOR 4/5: lock ──────────────────────────────────────────────────────────

test("lock: real processes allocate concurrently while a holder is killed -9; all sequences unique and monotonic", async () => {
  const dir = tmp();
  const helper = join(tmp(), "child.ts");
  const lockMod = join(process.cwd(), "src/runtime/herdr/portableLock.ts");
  const seqMod = join(process.cwd(), "src/runtime/herdr/sourceSequence.ts");
  writeFileSync(
    helper,
    `import { withFileLock } from ${JSON.stringify(lockMod)};
import { SourceSequence } from ${JSON.stringify(seqMod)};
const [mode, dir] = process.argv.slice(2);
if (mode === "hold") {
  await withFileLock(dir + "/sequence-pi.json.lock", async () => { console.log("held"); await new Promise(() => {}); });
} else {
  const s = new SourceSequence({ dir, source: "pi", lockTimeoutMs: 20000 });
  const out = [];
  for (let i = 0; i < 25; i++) out.push(await s.next());
  console.log(JSON.stringify(out));
}`,
  );
  mkdirSync(dir, { recursive: true });
  const holder = spawn(process.execPath, [helper, "hold", dir], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    holder.stdout.on("data", (d) => String(d).includes("held") && resolve());
    holder.on("exit", () => reject(new Error("holder exited early")));
  });
  const workers = Array.from(
    { length: 5 },
    () =>
      new Promise<number[]>((resolve, reject) => {
        const p = spawn(process.execPath, [helper, "alloc", dir], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        p.stdout.on("data", (d) => {
          out += d;
        });
        p.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker exit ${code}`))));
      }),
  );
  await new Promise((r) => setTimeout(r, 300)); // workers are now blocked on the live holder
  holder.kill("SIGKILL");
  const results = await Promise.all(workers);
  const all = results.flat();
  assert.equal(all.length, 125);
  assert.equal(new Set(all).size, 125, "no duplicate sequence");
  assert.equal(Math.max(...all), 125);
  for (const r of results)
    assert.deepEqual(
      r,
      [...r].sort((a, b) => a - b),
      "monotonic per process",
    );
});

test("lock: the deadline is honoured even when stale recovery cannot proceed", async () => {
  const lock = join(tmp(), "x.lock");
  mkdirSync(lock); // a directory: reading/removing it as a lock record throws
  const t0 = Date.now();
  await assert.rejects(() => withFileLock(lock, async () => 1, { timeoutMs: 150 }), /timed out/);
  assert.ok(Date.now() - t0 < 3000);
});

test("lock: a live owner on this host is never stolen; waiter times out with a clear error", async () => {
  const dir = tmp();
  const lock = join(dir, "y.lock");
  let release: () => void = () => {};
  const held = withFileLock(
    lock,
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(() => withFileLock(lock, async () => 1, { timeoutMs: 120, staleMs: 1 }), /timed out.*owner/);
  release();
  await held;
});

// ── MAJOR 6: dedupe + nonce ──────────────────────────────────────────────────

test("stage: the same event_id twice returns the existing envelope and burns no sequence", async () => {
  const store = new EnvelopeStore({ dir: tmp() });
  const a = await store.stage(draft("same"));
  const b = await store.stage(draft("same"));
  assert.ok("envelope" in a && "envelope" in b);
  assert.equal(b.status, "pending");
  assert.equal(b.envelope.source_sequence, a.envelope.source_sequence);
  const c = await store.stage(draft("other"));
  assert.ok("envelope" in c);
  assert.equal(c.envelope.source_sequence, a.envelope.source_sequence + 1);
  await store.outbox.ack("same");
  const d = await store.stage(draft("same"));
  assert.equal(d.status, "delivered");
});

test("stage: two identical content-hash-id events stay distinct; retries keep their id", async () => {
  const store = new EnvelopeStore({ dir: tmp() });
  const ev = { at: "2026-10-22T10:00:00Z", name: "lifecycle.transition", runId: "R", attributes: { a: 1 } } as const;
  const a = await store.stage(telemetryEventToDraft(ev));
  const b = await store.stage(telemetryEventToDraft(ev));
  assert.ok("envelope" in a && "envelope" in b);
  assert.notEqual(a.envelope.event_id, b.envelope.event_id);
  assert.equal(JSON.stringify(a.envelope).includes("event_id_derived"), false);
  const [first] = await store.outbox.peek(1);
  assert.equal(first?.event_id, a.envelope.event_id);
  const explicit = await store.stage(telemetryEventToDraft(ev, "fixed-id"));
  assert.ok("envelope" in explicit);
  assert.equal(explicit.envelope.event_id, "fixed-id");
});

test("stage: an invalid draft fails before allocating a sequence", async () => {
  const store = new EnvelopeStore({ dir: tmp() });
  await assert.rejects(() => store.stage(draft("bad", { occurred_at: "nope" })));
  assert.equal(await store.sequence.peek(), 1);
});

// ── MAJOR 7: per-instance source ─────────────────────────────────────────────

test("default source: valid, stable per state dir, unique across dirs, overridable", () => {
  const re = /^[a-z][a-z0-9_-]{0,31}$/;
  const d1 = tmp();
  const d2 = tmp();
  const s1 = defaultSource(d1);
  assert.match(s1, re);
  assert.equal(defaultSource(d1), s1);
  assert.notEqual(defaultSource(d2), s1);
  assert.equal(new EnvelopeStore({ dir: d1 }).source, s1);
  assert.equal(new EnvelopeStore({ dir: d1, source: "custom" }).source, "custom");
  assert.ok(s1.length <= 32);
});

// ── MAJOR 8: modes, redaction, size cap ──────────────────────────────────────

test("files are 0600 in a 0700 directory", async () => {
  const dir = join(tmp(), "cp");
  const store = new EnvelopeStore({ dir });
  await store.stage(draft("m1"));
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(store.outbox.file), 0o600);
  assert.equal(mode(join(dir, `sequence-${store.source}.json`)), 0o600);
});

test("payload secrets are redacted before they reach disk", async () => {
  // Assembled at runtime so no secret-shaped literal appears in the source.
  const fakeKey = ["sk", "x".repeat(24)].join("-");
  const fakePass = ["not", "a", "real", "value", "1"].join("");
  const store = new EnvelopeStore({ dir: tmp() });
  await store.stage(draft("r1", { payload: { note: `api_key=${fakeKey} ok`, nested: { password: fakePass } } }));
  const disk = readFileSync(store.outbox.file, "utf8");
  assert.equal(disk.includes(fakeKey), false);
  assert.equal(disk.includes(fakePass), false);
});

test("oversized payload is dead-lettered at stage time, never queued or sent, no sequence burned", async () => {
  const store = new EnvelopeStore({ dir: tmp(), maxEventBytes: 1000 });
  const r = await store.stage(draft("big", { payload: { blob: "x".repeat(5000) } }));
  assert.equal(r.status, "dead_lettered");
  assert.equal((await store.outbox.peek()).length, 0);
  assert.equal(await store.sequence.peek(), 1);
  const dl = lines(store.outbox.deadLetterFile);
  assert.equal(dl[0].reason, "oversized");
  assert.equal(dl[0].envelope.payload_bytes > 1000, true);
  assert.equal(store.stats().deadLettered, 1);
});

// ── minor ────────────────────────────────────────────────────────────────────

test("sequence failures are counted and reported, not invisible", async () => {
  const notices: string[] = [];
  const off = setTelemetrySink((n) => {
    if (n.key === "herdr-sequence-failure") notices.push(n.text);
  });
  try {
    const store = new EnvelopeStore({ dir: tmp(), sequenceBlock: 1 });
    await store.stage(draft("s1"));
    writeFileSync(join(store.sequence["dir" as never] as string, `sequence-${store.source}.json`), "{bad");
    await assert.rejects(() => store.stage(draft("s2")));
    await assert.rejects(() => store.stage(draft("s3")));
    assert.equal(store.stats().sequenceFailures, 2);
    assert.equal(notices.length, 1);
  } finally {
    off();
    resetTelemetrySinks();
  }
});

test("leaked temp files from a crash are cleaned on startup", async () => {
  const dir = tmp();
  const store = new EnvelopeStore({ dir, source: "pi-x" });
  const leaked = join(dir, "outbox-pi-x.jsonl.123.deadbeef.tmp");
  writeFileSync(leaked, "partial");
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(leaked, old, old);
  await store.stage(draft("t1"));
  assert.equal(existsSync(leaked), false);
});
