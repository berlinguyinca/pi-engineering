/** Session-start wiring (src/runtime/herdr/attachInspector.ts) with a fake pi; extensions/index.ts itself is not unit-instantiable. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { attachInspectorWhenReady, createInspectorSlot } from "../../src/runtime/herdr/attachInspector.ts";

class FakePi {
  handlers = new Map<string, Array<(e: any, c: any) => unknown>>();
  events = { on: () => () => {} };
  on(n: string, h: (e: any, c: any) => unknown) {
    this.handlers.set(n, [...(this.handlers.get(n) ?? []), h]);
    return () => {};
  }
  fire(n: string, e: any = {}, c: any = CTX) {
    for (const h of this.handlers.get(n) ?? []) h({ type: n, ...e }, c);
  }
}
const CTX = { cwd: "/w", model: { id: "m", provider: "p", api: "x", reasoning: false }, sessionManager: { getSessionId: () => "s1" }, getContextUsage: () => undefined };

function home(withHost = true) {
  const h = mkdtempSync(join(tmpdir(), "attach-"));
  if (withHost) {
    mkdirSync(join(h, ".config", "herdr-engineering"), { recursive: true });
    writeFileSync(join(h, ".config", "herdr-engineering", "host.json"), JSON.stringify({ control_plane_url: "http://cp", host_id: "h", token: "TOKSECRET" }));
  }
  return h;
}
const cpFetch = (values: object, ingest: any[] = []) =>
  (async (url: string, init: RequestInit) => {
    if (url.endsWith("/fleet/config")) return new Response(JSON.stringify({ revision: "r", values }));
    if (url.endsWith("/applied")) return new Response("{}");
    ingest.push(JSON.parse(String(init.body)));
    return new Response("{}");
  }) as unknown as typeof fetch;

test("no host.json: resolves null, registers nothing, logs one secret-free line", async () => {
  const pi = new FakePi();
  const lines: string[] = [];
  const h = await attachInspectorWhenReady(pi as never, { hostConfig: { home: home(false), fetch: cpFetch({}) }, log: (l) => lines.push(l) });
  assert.equal(h, null);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes("TOKSECRET"));
  assert.equal([...pi.handlers.values()].flat().length, 1, "only the remembered session_start probe");
});

test("disabled inspector: null, silent, feed handlers absent", async () => {
  const pi = new FakePi();
  const lines: string[] = [];
  const h = await attachInspectorWhenReady(pi as never, { hostConfig: { home: home(), fetch: cpFetch({ inspector: { enabled: false } }) }, log: (l) => lines.push(l) });
  assert.equal(h, null);
  assert.deepEqual(lines, []);
});

test("network failure with no cache never rejects", async () => {
  const failing = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  assert.equal(await attachInspectorWhenReady(new FakePi() as never, { hostConfig: { home: home(), fetch: failing } }), null);
});

test("a hung control plane is bounded by the timeout", async () => {
  const hang = (async (_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("a"))))) as unknown as typeof fetch;
  const keep = setTimeout(() => {}, 3000);
  try {
    assert.equal(await attachInspectorWhenReady(new FakePi() as never, { hostConfig: { home: home(), fetch: hang, timeoutMs: 40 } }), null);
  } finally {
    clearTimeout(keep);
  }
});

test("enabled: attaches, and a session_start fired BEFORE the attach completed is replayed", async () => {
  const pi = new FakePi();
  const ingest: any[] = [];
  const f = cpFetch({ inspector: { enabled: true } }, ingest);
  const p = attachInspectorWhenReady(pi as never, { hostConfig: { home: home(), fetch: f }, fetch: f, flushMs: 5 });
  pi.fire("session_start", { reason: "startup" }); // fires while the config is still loading
  const handle = await p;
  assert.ok(handle);
  await new Promise((r) => setTimeout(r, 60));
  const kinds = ingest.filter((b) => b.payload?.events).flatMap((b) => b.payload.events.map((e: any) => `${e.kind}:${e.phase ?? ""}`));
  assert.equal(kinds.filter((k) => k === "lifecycle:started").length, 1, `got ${kinds.join(",")}`);
  handle.dispose();
});

function fakeHandle() {
  const calls: any[] = [];
  return { calls, handle: { associate: (a: any) => calls.push(a) } as never };
}

test("slot: an association made before attach is applied after attach", () => {
  const slot = createInspectorSlot();
  const h = fakeHandle();
  slot.associate({ mission_id: "m1" });
  assert.equal(h.calls.length, 0);
  slot.set(h.handle);
  assert.deepEqual(h.calls, [{ mission_id: "m1" }]);
});

test("slot: a second association before attach replaces the first", () => {
  const slot = createInspectorSlot();
  const h = fakeHandle();
  slot.associate({ mission_id: "m1" });
  slot.associate({ mission_id: "m2" });
  slot.set(h.handle);
  assert.deepEqual(h.calls, [{ mission_id: "m2" }]);
});

test("slot: nothing pending -> no call; null handle drops silently", () => {
  const slot = createInspectorSlot();
  const h = fakeHandle();
  slot.set(h.handle);
  assert.deepEqual(h.calls, []);
  const s2 = createInspectorSlot();
  s2.associate({ mission_id: "x" });
  s2.set(null);
});

test("slot: associate after attach goes straight through", () => {
  const slot = createInspectorSlot();
  const h = fakeHandle();
  slot.set(h.handle);
  slot.associate({ mission_id: "m3" });
  assert.deepEqual(h.calls, [{ mission_id: "m3" }]);
});
