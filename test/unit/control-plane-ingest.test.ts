/**
 * Phase 2 emitter tests — ControlPlaneIngest + HerdrAgentRuntime wiring.
 *
 * Uses an injectable recording `fetch` (no live control plane required).
 * Asserts: correct /api/v1/ingest envelope, best-effort/non-blocking behavior,
 * off-by-default (no emitter = no network), and runtime lifecycle emission.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";
import { HerdrAgentRuntime } from "../../src/runtime/herdr/HerdrAgentRuntime.ts";
import { createAgentRuntime } from "../../src/runtime/index.ts";

interface CapturedCall {
  url: string;
  body: { entity_type: string; entity_id: string; event_type: string; payload: Record<string, unknown> };
}

/** A recording fetch that resolves ok. */
function recordingFetch(calls: CapturedCall[]): typeof globalThis.fetch {
  return (async (input: string, init?: RequestInit) => {
    calls.push({ url: input, body: JSON.parse(String(init?.body)) as CapturedCall["body"] });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
}

/** Fake Herdr CLI (minimal, mirrors herdr-runtime.test.ts). */
class FakeHerdrCli {
  agents = new Map<string, { agent_status: string }>();
  constructor() {
    this.agents.set("fake-pane", { agent_status: "idle" });
  }
  async status() {
    return { ok: true, serverVersion: "0.9.1", protocol: 22 };
  }
  async listAgents() {
    return [...this.agents.values()];
  }
  async getAgent(t: string) {
    return this.agents.get(t) ?? null;
  }
  async readAgent() {
    return "x";
  }
  async prompt(t: string) {
    this.agents.set(t, { agent_status: "done" });
  }
  async wait(t: string) {
    return this.agents.get(t) ?? { agent_status: "done" };
  }
  async startAgent(p: string) {
    if (!this.agents.has(p)) this.agents.set(p, { agent_status: "idle" });
  }
  async sendKeys() {}
  async closePane(t: string) {
    this.agents.delete(t);
  }
  async createWorktree() {
    return { workspaceId: "wt1", path: "/tmp/wt" };
  }
}

const flush = () => new Promise((r) => setTimeout(r, 5));

test("ControlPlaneIngest posts the correct envelope to /api/v1/ingest", async () => {
  const calls: CapturedCall[] = [];
  const ingest = new ControlPlaneIngest({ url: "http://dev.lan", fetch: recordingFetch(calls) });
  await ingest.emit("host", "bender", "host.registered", { host_name: "bender" });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "http://dev.lan/api/v1/ingest");
  assert.equal(call.body.entity_type, "host");
  assert.equal(call.body.entity_id, "bender");
  assert.equal(call.body.event_type, "host.registered");
  assert.equal(call.body.payload.host_name, "bender");
});

test("ControlPlaneIngest never rejects on network failure (best-effort)", async () => {
  const throwing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof globalThis.fetch;
  const ingest = new ControlPlaneIngest({ url: "http://dev.lan", fetch: throwing });
  assert.equal(await ingest.emit("host", "b", "host.registered", {}), false);
});

test("ControlPlaneIngest emits nothing when disabled", async () => {
  const calls: CapturedCall[] = [];
  const ingest = new ControlPlaneIngest({ url: "http://dev.lan", fetch: recordingFetch(calls) });
  ingest.enabled = false;
  assert.equal(await ingest.emit("host", "b", "host.registered", {}), false);
  assert.equal(calls.length, 0);
});

test("session() maps agent to a session and dedupes mission emission", async () => {
  const calls: CapturedCall[] = [];
  const ingest = new ControlPlaneIngest({
    url: "http://dev.lan",
    host: { hostId: "bender", hostName: "bender", tailnetIp: "100.104.39.6" },
    fetch: recordingFetch(calls),
  });
  await ingest.session("a1", "session.started", {
    missionId: "MSN-x",
    agentRole: "engineer",
    model: "gpt5",
    status: "READY",
  });
  await ingest.session("a2", "session.started", { missionId: "MSN-x", agentRole: "engineer", status: "READY" });

  assert.equal(calls.length, 3); // mission.started + session a1 + session a2
  const mission = calls.find((c) => c.body.event_type === "mission.started")!;
  assert.equal(mission.body.entity_id, "MSN-x");
  assert.equal(mission.body.payload.stage, "active");
  const s1 = calls.find((c) => c.body.entity_id === "a1")!;
  assert.equal(s1.body.entity_type, "session");
  assert.equal(s1.body.payload.host_id, "bender");
  assert.equal(s1.body.payload.mission_id, "MSN-x");
});

test("HerdrAgentRuntime emits host.registered on init and lifecycle session events", async () => {
  const calls: CapturedCall[] = [];
  const ingest = new ControlPlaneIngest({
    url: "http://dev.lan",
    host: { hostId: "bender", hostName: "bender" },
    fetch: recordingFetch(calls),
  });
  const rt = new HerdrAgentRuntime({ cli: new FakeHerdrCli() as never, ingest });

  await flush();
  const hostEvents = calls.filter((c) => c.body.entity_type === "host");
  assert.equal(hostEvents.length, 1);
  assert.equal(hostEvents[0]!.body.event_type, "host.registered");

  const rid = await rt.create({ role: "engineer", objective: "add health endpoint", missionId: "MSN-y" });
  await rt.start(rid);
  await flush();

  const sessionEvents = calls.filter((c) => c.body.entity_type === "session");
  assert.equal(sessionEvents.length, 1);
  assert.equal(sessionEvents[0]!.body.event_type, "session.started");
  assert.equal(sessionEvents[0]!.body.payload.mission_id, "MSN-y");
  assert.equal(sessionEvents[0]!.body.entity_id, rid);

  await rt.sendTask(rid, "add health endpoint");
  await flush();
  const updated = calls.filter((c) => c.body.event_type === "session.updated");
  assert.ok(updated.length >= 1);
  assert.equal(updated[0]!.body.payload.status, "WORKING");

  await rt.terminate(rid);
  await flush();
  const term = calls.filter((c) => c.body.event_type === "session.terminated");
  assert.equal(term.length, 1);
  assert.equal(term[0]!.body.payload.status, "TERMINATED");
});

test("HerdrAgentRuntime without an emitter makes no network calls", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const rt = new HerdrAgentRuntime({ cli: new FakeHerdrCli() as never });
    const rid = await rt.create({ role: "engineer", objective: "x", missionId: "MSN-z" });
    await rt.start(rid);
    await flush();
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createAgentRuntime threads herdrIngest into the runtime", async () => {
  const calls: CapturedCall[] = [];
  const ingest = new ControlPlaneIngest({ url: "http://dev.lan", fetch: recordingFetch(calls) });
  const rt = await createAgentRuntime({ runtime: "herdr", herdrCli: new FakeHerdrCli() as never, herdrIngest: ingest });
  assert.equal(rt.capabilities.name, "herdr");
  await flush();
  assert.equal(calls.filter((c) => c.body.event_type === "host.registered").length, 1);
});
