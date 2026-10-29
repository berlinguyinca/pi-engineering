import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { createIngestFromConnection } from "../../src/runtime/herdr/herdrConnection.ts";
import { SessionScopeRegistry } from "../../src/runtime/herdr/sessionScope.ts";

interface Sent {
  [k: string]: unknown;
}
const capture = (sent: Sent[]) =>
  (async (_u: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Sent);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
const payloadOf = (b: Sent) => b.payload as Record<string, unknown>;

describe("SessionScopeRegistry", () => {
  it("resolves explicit > session > mission > default, field by field", () => {
    const r = new SessionScopeRegistry({ roomId: "yaml-room", workspaceId: "yaml-ws", agentInstanceId: "pi-1" });
    r.bindMission("m1", { roomId: "room-m" });
    r.bindSession("s1", { roomId: "room-s" });
    assert.deepEqual(r.resolve({ sessionId: "s1", missionId: "m1" }), {
      roomId: "room-s",
      workspaceId: "yaml-ws",
      agentInstanceId: "pi-1",
    });
    assert.equal(r.resolve({ sessionId: "s2", missionId: "m1" }).roomId, "room-m");
    assert.equal(r.resolve({ sessionId: "s2" }).roomId, "yaml-room");
    assert.equal(r.resolve({ sessionId: "s1" }, { roomId: "room-x" }).roomId, "room-x");
  });

  it("drops malformed ids instead of repairing them, and unbinding falls back", () => {
    const r = new SessionScopeRegistry({ roomId: "yaml-room" });
    r.bindSession("s1", { roomId: "bad id with spaces", agentInstanceId: "a/../b" });
    assert.deepEqual(r.resolve({ sessionId: "s1" }), { roomId: "yaml-room" });
    r.bindSession("s1", { roomId: "room-s" });
    r.unbindSession("s1");
    assert.equal(r.resolve({ sessionId: "s1" }).roomId, "yaml-room");
  });
});

describe("ControlPlaneIngest session scope", () => {
  it("v1 mode: a Pi attached to two rooms tags each mission's sessions with its own room", async () => {
    const sent: Sent[] = [];
    const ingest = new ControlPlaneIngest({
      url: "http://127.0.0.1:1",
      fetch: capture(sent),
      defaultScope: { roomId: "yaml-room", workspaceId: "ws-1", agentInstanceId: "pi-laptop" },
    });
    ingest.scopes.bindMission("mA", { roomId: "room-a" });
    ingest.scopes.bindMission("mB", { roomId: "room-b", workspaceId: "ws-b" });
    ingest.scopes.bindSession("sB2", { agentInstanceId: "worker-b2" });
    await ingest.session("sA", "session.started", { missionId: "mA", instanceId: "pane:h:1" });
    await ingest.session("sB", "session.started", { missionId: "mB" });
    await ingest.session("sB2", "session.updated", { missionId: "mB" });
    await ingest.session("sN", "session.updated", {});
    const sessions = sent.filter((b) => b.entity_type === "session").map(payloadOf);
    assert.deepEqual(
      sessions.map((p) => [p.room_id, p.workspace_id, p.agent_instance_id]),
      [
        ["room-a", "ws-1", "pi-laptop"],
        ["room-b", "ws-b", "pi-laptop"],
        ["room-b", "ws-b", "worker-b2"],
        ["yaml-room", "ws-1", "pi-laptop"],
      ],
    );
    // the pane link keeps its own meaning and is not overwritten
    assert.equal(sessions[0]?.instance_id, "pane:h:1");
    assert.equal(sessions[1]?.instance_id, undefined);
    const missions = sent.filter((b) => b.entity_type === "mission").map(payloadOf);
    assert.deepEqual(
      missions.map((p) => p.room_id),
      ["room-a", "room-b"],
    );
  });

  it("envelope mode: room_id, workspace_id and agent_instance_id become envelope fields", async () => {
    const sent: Sent[] = [];
    const dir = mkdtempSync(join(tmpdir(), "scope-"));
    const ingest = new ControlPlaneIngest({
      url: "http://127.0.0.1:1",
      fetch: capture(sent),
      envelopeStore: new EnvelopeStore({ dir }),
      defaultScope: { roomId: "yaml-room", agentInstanceId: "pi-1" },
    });
    ingest.scopes.bindSession("s1", { roomId: "room-s", workspaceId: "ws-s", agentInstanceId: "w1" });
    await ingest.session("s1", "session.started", {});
    const env = sent.find((b) => b.entity_type === "session");
    assert.ok(env);
    assert.equal(env.room_id, "room-s");
    assert.equal(env.workspace_id, "ws-s");
    assert.equal(env.agent_instance_id, "w1");
    assert.equal(env.schema_version, 2);
  });

  it("with no scope configured nothing is added (standalone shape unchanged)", async () => {
    const sent: Sent[] = [];
    const ingest = new ControlPlaneIngest({ url: "http://127.0.0.1:1", fetch: capture(sent) });
    await ingest.session("s1", "session.started", {});
    const p = payloadOf(sent.find((b) => b.entity_type === "session") as Sent);
    for (const k of ["room_id", "workspace_id", "agent_instance_id"]) assert.ok(!(k in p), k);
  });

  it("stays fire-and-forget: an unreachable control plane resolves false and never throws", async () => {
    const ingest = new ControlPlaneIngest({
      url: "http://127.0.0.1:1",
      fetch: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
      defaultScope: { roomId: "r" },
    });
    assert.equal(await ingest.session("s", "session.started", {}), false);
  });

  it("the YAML herdr block is the default scope of an ingest built from it", async () => {
    const sent: Sent[] = [];
    const ingest = createIngestFromConnection(
      { baseUrl: "http://127.0.0.1:1", roomId: "yaml-room", workspaceId: "ws-1", instanceId: "pi-laptop" },
      "h1",
      { fetch: capture(sent) },
    );
    await ingest.session("s1", "session.started", {});
    const p = payloadOf(sent.find((b) => b.entity_type === "session") as Sent);
    assert.deepEqual([p.room_id, p.workspace_id, p.agent_instance_id], ["yaml-room", "ws-1", "pi-laptop"]);
  });
});
