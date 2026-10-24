import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { WorkspaceManifest } from "../../src/orchestration/types.ts";
import { WorkGraph } from "../../src/platform/WorkGraph.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { enclosingMethods } from "./support/codeGraph.ts";
import { type PiHost, startPiHost } from "./support/piHost.ts";
import { Plane, eventually, loadAcceptance } from "./support/plane.ts";
/**
 * ACCEPTANCE SCENARIO 3 (Pi side). One HCN room spans two workspaces on two different hosts; a parent agent (tab)
 * spawns two child agents (panes); the graph and timeline keep spawn, handoff and peer consultation apart; closing a
 * pane does not kill the worker; every read is membership-scoped.
 *
 * Real pieces: a real Herdr control-plane process (YAML-configured), two Pi "hosts" (own global engineering.yaml
 * `herdr:` block, own key file, own state dir, own git repo, emitter built by the REAL loadLineageEmitter), Pi's real
 * WorkGraph (spawn with parent data), real MissionStore (executions and handoff records), the real HCN consultation
 * routes, and Herdr's real client-side tabs/panes model (packages/collab-tabs.js) fed with the server's answers.
 * Two hosts = two ingest keys + two EnvelopeStore sources on ONE control plane (server-to-server federation is a
 * separate, later, gated feature).
 *
 * Gaps are named `GAP:` and assert the CURRENT behaviour. Nothing here calls an emitter primitive to fill a gap.
 */
import { scratch } from "./support/scratch.ts";

function gitRepo(): string {
  const d = scratch("t16-s3-repo-");
  const g = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t16@example.invalid");
  g("config", "user.name", "t16");
  writeFileSync(join(d, "README.md"), "x\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  return d;
}

function manifest(missionId: string, repo: string, base: string): WorkspaceManifest {
  return {
    manifestId: `WM-${missionId}`,
    missionId,
    generation: 1,
    authorizedRoots: [{ canonicalPath: repo, source: "existing_manifest", access: "write" }],
    repositories: [{ repoId: "repo-1", canonicalRoot: repo, baseRef: "main", baseSha: base, writableDomains: ["**"] }],
    dependencyEdges: [],
    hash: `hash-${missionId}`,
    createdAt: new Date().toISOString(),
  };
}

type Edge = { edge_type: string; from_id: string; to_id: string; removed?: boolean; attrs?: Record<string, unknown> };
type Marker = { kind: string; step: number; at: string; edge_type: string; from_id: string; to_id: string };

describe("scenario 3: one room, two workspaces, two hosts", () => {
  let plane: Plane;
  let roomId = "";
  let room2 = "";
  let linkB = "";
  let hostA: PiHost;
  let hostB: PiHost;
  let lead = "";
  let child1 = "";
  let child2 = "";
  let agentB = "";
  const REPO_A = gitRepo();
  const REPO_B = gitRepo();
  let tabsModel: (
    graphs: unknown[],
    links?: unknown,
    externals?: unknown,
  ) => {
    tabs: Array<{
      agent_id: string;
      state: string;
      surface: { closed: boolean } | null;
      panes: Array<{ agent_id: string }>;
    }>;
  };

  const ids = (nodes: Array<{ id: string }>) => nodes.map((n) => n.id);
  const lineage = async (user: string, room = roomId) =>
    plane.c("GET", `/graph/lineage?room_id=${room}&limit=200`, { user });
  const listing = async (user: string, type = "agent", room = roomId) =>
    plane.c("GET", `/graph/nodes?node_type=${type}&edge_type=spawn&room_id=${room}`, { user });
  const edgesOf = async (user = "alice"): Promise<Edge[]> =>
    ((await lineage(user)).body.edges as Edge[]).filter((e) => !e.removed);
  const ofType = (es: Edge[], t: string) =>
    es.filter((e) => e.edge_type === t).map((e) => [e.from_id, e.to_id] as [string, string]);
  const raw = (
    src: string,
    seq: number,
    entity: string,
    type: string,
    payload: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => ({
    schema_version: 2,
    event_id: `${src}-${seq}`,
    source: src,
    source_sequence: seq,
    occurred_at: new Date().toISOString(),
    entity_type: "lineage",
    entity_id: entity,
    event_type: type,
    payload,
    visibility_scope: "room",
    room_id: roomId,
    workspace_id: "ws-a",
    evidence_refs: [],
    ...extra,
  });

  before(async () => {
    const everything = { rooms: ["*"], missions: ["*"] };
    plane = await Plane.start({
      keys: { hostA: "ingest", hostB: "ingest", raw: "ingest", scoped: "ingest" },
      users: ["alice", "bob", "carol", "dave", "mallory"],
      // '*' is the operator's explicit opt-in for trusted fleet keys; `scoped` may address ONE other room only
      scopes: {
        hostA: everything,
        hostB: everything,
        raw: everything,
        scoped: { rooms: ["room-elsewhere"], missions: [] },
      },
    });
    await plane.verifyFeatures("alice");
    roomId = (await plane.makeRoom("alice", "p3", "room-3")).roomId;
    room2 = (await plane.makeRoom("dave", "p3-other", "room-other")).roomId;
    await plane.addMember("alice", roomId, "bob", "contributor");
    await plane.addMember("alice", roomId, "carol", "guest");
    for (const [host, ws] of [
      ["hosta", "ws-a"],
      ["hostb", "ws-b"],
    ] as const) {
      const r = await plane.c("POST", `/rooms/${roomId}/workspaces`, {
        user: "alice",
        body: { host, workspace_id: ws, grants: ["status", "tabs", "panes"] },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      if (ws === "ws-b") linkB = r.body.link_id;
    }
    const acc = await loadAcceptance();
    tabsModel = (await import(pathToFileURL(join(acc.herdrRepo, "packages/collab-tabs.js")).href)).buildTabsPanes;

    // Host A (workspace ws-a): lead agent (tab) spawns two helpers (panes), via Pi's real WorkGraph with parent data
    hostA = await startPiHost(plane, { key: "hostA", instanceId: "pi-a", roomId, workspaceId: "ws-a" });
    const graphA = WorkGraph.create(JsonlEventStore.inMemory());
    graphA.setLineage(hostA.emitter);
    lead = graphA.createWorker({ projectId: "P3", role: "lead" }).id;
    child1 = graphA.createWorker({ projectId: "P3", role: "helper", parentWorkerId: lead }).id;
    child2 = graphA.createWorker({ projectId: "P3", role: "helper", parentWorkerId: lead }).id;
    // ... and a phase handoff through the real MissionStore handoff path
    const storeA = MissionStore.open(JsonlEventStore.inMemory());
    storeA.setLineage(hostA.emitter);
    storeA.addHandoffRecord({
      id: "hf-s3",
      kind: "phase_transition",
      state: "prepared",
      missionId: "MSN-s3a",
      predecessor: { sessionId: "s3-old", generation: 1 },
      createdAt: new Date().toISOString(),
    });
    storeA.transitionHandoffRecord("hf-s3", "validated");
    storeA.transitionHandoffRecord("hf-s3", "acknowledged", { sessionId: "s3-new", generation: 2 });

    // Host B (workspace ws-b): its own agent from a real MissionStore execution on its own git repo
    hostB = await startPiHost(plane, { key: "hostB", instanceId: "pi-b", roomId, workspaceId: "ws-b" });
    const storeB = MissionStore.open(JsonlEventStore.inMemory());
    storeB.setLineage(hostB.emitter);
    const baseB = execFileSync("git", ["-C", REPO_B, "rev-parse", "HEAD"]).toString().trim();
    const m = storeB.createMission({
      mission_id: "MSN-s3b",
      title: "b",
      goal: "g",
      user_request: "u",
      repository: REPO_B,
      base_ref: "main",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    storeB.bindWorkspaceManifest(manifest(m.mission_id, REPO_B, baseB));
    const task = storeB.createTask({
      task_id: "task-b",
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "implement",
      repo_id: "repo-1",
      acceptance_ids: ["AC-1"],
      deliverables: ["implementation"],
      execution_budget_ms: 60_000,
      checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
      candidate_generation: 0,
      mission_generation: 0,
      fencing_token: 0,
    });
    const ex = storeB.createExecution({
      task_id: task.task_id,
      mission_id: m.mission_id,
      backend: "agent",
      checkpoint_id: "TCP-b",
      repo_id: "repo-1",
      base_sha: baseB,
    });
    storeB.setExecutionStatus(ex.execution_id, "RUNNING", {});
    agentB = task.task_id;

    await Promise.all([hostA.drain(), hostB.drain()]);
    await eventually(async () => {
      const es = await edgesOf();
      return (
        ofType(es, "handoff").length === 1 &&
        ofType(es, "spawn").length >= 4 &&
        ids((await listing("alice")).body.nodes).includes(`agent:${agentB}`)
      );
    }, "both hosts' lineage to reach the room graph");
  });

  after(async () => {
    await plane?.stop();
  });

  it("two hosts report through two distinct sources, each gap-free and attributed to its own key", async () => {
    const piSources = Object.values(await plane.sources()).filter((s) => String(s.source).startsWith("pi-"));
    assert.equal(piSources.length, 2, JSON.stringify(piSources));
    assert.notEqual(piSources[0]?.source, piSources[1]?.source);
    const actors = new Set(piSources.map((s) => (s as unknown as { actor: string }).actor));
    assert.deepEqual(actors, new Set([plane.pid("hostA"), plane.pid("hostB")]));
    for (const s of piSources) {
      assert.deepEqual(s.gaps, []);
      assert.ok((s.last_sequence ?? 0) > 0);
      assert.equal((s as unknown as { status: string }).status, "healthy");
    }
  });

  it("spawn: parent -> each child only; no spawn between siblings, to a session, or across hosts", async () => {
    const es = await edgesOf();
    const spawn = ofType(es, "spawn");
    assert.deepEqual(
      spawn.filter(([f]) => f.startsWith("agent:")).sort(),
      [
        [`agent:${lead}`, `agent:${child1}`],
        [`agent:${lead}`, `agent:${child2}`],
      ].sort(),
    );
    assert.deepEqual(
      spawn.filter(([f]) => f.startsWith("attempt:")).sort(),
      [
        [`attempt:${lead}.g1`, `attempt:${child1}.g1`],
        [`attempt:${lead}.g1`, `attempt:${child2}.g1`],
      ].sort(),
    );
    assert.ok(!spawn.some(([f, t]) => f === `agent:${child1}` && t === `agent:${child2}`), "no sibling spawn");
    assert.ok(!spawn.some(([, t]) => t.startsWith("session:")), "a session is never spawned");
    assert.ok(!spawn.some(([f, t]) => f.includes(agentB) || t.includes(agentB)), "host B's agent is nobody's child");
  });

  it("handoff: its own edge type, session -> session, never agent -> agent", async () => {
    const es = await edgesOf();
    assert.deepEqual(ofType(es, "handoff"), [["session:s3-old", "session:s3-new"]]);
    assert.ok(!ofType(es, "spawn").some(([f, t]) => f === "session:s3-old" || t === "session:s3-new"));
  });

  it("nothing is inferred from chat; a peer consultation adds ONLY a consultation edge", async () => {
    const before = JSON.stringify((await edgesOf()).map((e) => [e.edge_type, e.from_id, e.to_id]).sort());
    assert.deepEqual(ofType(await edgesOf(), "consultation"), [], "no consultation before anyone asks");
    const chat = await plane.c("POST", `/rooms/${roomId}/messages`, {
      user: "bob",
      body: {
        text: `agent ${lead} spawned a third helper, handed off to ${child1} and consulted alice`,
        idempotency_key: "chat-1",
      },
    });
    assert.ok(chat.status === 200 || chat.status === 201, JSON.stringify(chat.body));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      JSON.stringify((await edgesOf()).map((e) => [e.edge_type, e.from_id, e.to_id]).sort()),
      before,
      "chat text created no edge",
    );

    // negative controls first: guest and an outsider cannot ask; positive: contributor can
    const body = (id: string) => ({
      target: { kind: "user", id: "alice" },
      subject: { kind: "node", node_id: `agent:${lead}` },
      question: "is the plan sound?",
      idempotency_key: id,
    });
    for (const who of ["carol", "dave", "mallory"]) {
      const r = await plane.c("POST", `/rooms/${roomId}/consultations`, { user: who, body: body(`n-${who}`) });
      assert.ok(r.status === 403 || r.status === 404, `${who}: ${r.status}`);
    }
    const ask = await plane.c("POST", `/rooms/${roomId}/consultations`, { user: "bob", body: body("k1") });
    assert.equal(ask.status, 201, JSON.stringify(ask.body));
    const cid = ask.body.consultation.consult_id as string;
    const es = await edgesOf();
    const cons = es.filter((e) => e.edge_type === "consultation");
    assert.equal(cons.length, 1);
    assert.equal(cons[0]?.from_id, `thread:hcn-consult.${cid}`);
    assert.equal(cons[0]?.to_id, `agent:${lead}`);
    // asker and answerer are attributes of the consultation thread, not endpoints and not agents
    const thread = await plane.c("GET", `/graph/nodes/${encodeURIComponent(`thread:hcn-consult.${cid}`)}`, {
      user: "alice",
    });
    assert.equal(thread.status, 200, JSON.stringify(thread.body));
    assert.equal(thread.body.node.attrs.asked_by, "bob");
    assert.equal(thread.body.node.attrs.target, "alice");
    assert.equal(thread.body.node.attrs.executable, false);
    assert.equal(thread.body.node.state, "open");
    // answering changes the thread's state only
    const ans = await plane.c("POST", `/rooms/${roomId}/consultations/${cid}/answer`, {
      user: "alice",
      body: { answer: "yes, proceed" },
    });
    assert.equal(ans.status, 200, JSON.stringify(ans.body));
    await eventually(
      async () =>
        (await plane.c("GET", `/graph/nodes/${encodeURIComponent(`thread:hcn-consult.${cid}`)}`, { user: "alice" }))
          .body.node.state === "answered",
      "answered state",
    );
    const after = await edgesOf();
    assert.deepEqual(ofType(after, "spawn"), ofType(es, "spawn"));
    assert.deepEqual(ofType(after, "handoff"), ofType(es, "handoff"));
    assert.equal(ofType(after, "consultation").length, 1);
  });

  it("timeline: ordered, typed markers for spawn, handoff and consultation; ledger steps are contiguous", async () => {
    const t = (await plane.c("GET", `/graph/lineage/timeline?room_id=${roomId}`, { user: "alice" })).body;
    const markers = (t.markers as Marker[]).filter((m) => m.kind === "edge");
    const types = new Set(markers.map((m) => m.edge_type));
    assert.deepEqual([...types].sort(), ["consultation", "handoff", "spawn"]);
    for (let i = 1; i < markers.length; i++) {
      assert.ok((markers[i] as Marker).step > (markers[i - 1] as Marker).step, "markers are in step order");
      assert.ok((markers[i] as Marker).at >= (markers[i - 1] as Marker).at, "server receipt times never go backwards");
    }
    const lastSpawn = Math.max(...markers.filter((m) => m.edge_type === "spawn").map((m) => m.step));
    const handoff = markers.find((m) => m.edge_type === "handoff") as Marker;
    const consult = markers.find((m) => m.edge_type === "consultation") as Marker;
    assert.ok(
      handoff.step > lastSpawn && consult.step > handoff.step,
      "spawns, then the handoff, then the consultation, as they happened",
    );
    assert.equal(handoff.from_id, "session:s3-old");
    assert.equal(consult.to_id, `agent:${lead}`);
    const lanes = (t.lanes as Array<{ node_id: string; state: string }>).map((l) => l.node_id);
    assert.ok(lanes.includes(`agent:${lead}`) && lanes.includes(`agent:${agentB}`));
    const ev = (await plane.c("GET", `/graph/lineage/events?room_id=${roomId}`, { user: "alice" })).body
      .events as Array<{ step: number }>;
    assert.deepEqual(
      ev.map((e) => e.step),
      ev.map((_, i) => i + 1),
    );
  });

  it("tabs and panes: Herdr's own client model shows each primary agent as a tab and each helper as a pane under its parent", async () => {
    const graph = (await listing("alice")).body;
    const links = (await plane.c("GET", `/rooms/${roomId}/workspaces`, { user: "alice" })).body;
    const model = tabsModel([graph], links.links ?? links);
    const tabIds = model.tabs.map((t) => t.agent_id).sort();
    assert.deepEqual(tabIds, [`agent:${lead}`, `agent:${agentB}`].sort());
    const leadTab = model.tabs.find((t) => t.agent_id === `agent:${lead}`);
    assert.deepEqual(leadTab?.panes.map((p) => p.agent_id).sort(), [`agent:${child1}`, `agent:${child2}`].sort());
    assert.deepEqual(model.tabs.find((t) => t.agent_id === `agent:${agentB}`)?.panes, []);
    // the server's own spawn edges are the only source: the helpers have a visible parent, the leads do not
    const spawnTargets = new Set(ofType(await edgesOf(), "spawn").map(([, t]) => t));
    assert.ok(!spawnTargets.has(`agent:${lead}`) && !spawnTargets.has(`agent:${agentB}`));
  });

  it("GAP: no Pi code path emits tab/pane surface nodes, so a pane close cannot reach Herdr from Pi", async () => {
    for (const type of ["pane", "tab"]) {
      const r = await listing("alice", type);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.nodes, [], `Pi emitted a ${type} node: lineage.ts has no tab/pane primitive`);
    }
    // structural: the only closePane call in Pi's Herdr runtime is inside terminate() (which cancels the attempt on
    // purpose), never a "surface closed" report
    assert.deepEqual(
      enclosingMethods(
        fileURLToPath(new URL("../../src/runtime/herdr/HerdrAgentRuntime.ts", import.meta.url)),
        "closePane",
      ),
      ["terminate"],
    );
  });

  it("closing a pane never kills the worker (SERVER CONTRACT via raw ingest, not Pi-path evidence)", async () => {
    // positive control: the raw key writes its OWN surface node and the change is visible
    const pane = "pane:hosta-w1.p2";
    let seq = 0;
    const put = (entity: string, type: string, payload: Record<string, unknown>) =>
      plane.call("POST", "/api/v1/ingest", { key: "raw", body: raw("e2e-raw3", ++seq, entity, type, payload) });
    assert.equal(
      (
        await put(pane, "node.upsert", {
          node_type: "pane",
          node_id: pane,
          state: "open",
          attrs: { agent_id: `agent:${lead}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (await put(pane, "node.state", { node_id: pane, state: "closed", reason: "pane closed by the user" })).status,
      200,
    );
    const paneNode = await plane.c("GET", `/graph/nodes/${encodeURIComponent(pane)}`, { user: "alice" });
    assert.equal(paneNode.body.node.state, "closed");

    // the worker is untouched: agent still running, attempt not cancelled, helpers still listed
    const agent = await plane.c("GET", `/graph/nodes/${encodeURIComponent(`agent:${lead}`)}`, { user: "alice" });
    assert.equal(agent.body.node.state, "running");
    const attempt = await plane.c("GET", `/graph/nodes/${encodeURIComponent(`attempt:${lead}.g1`)}`, { user: "alice" });
    assert.notEqual(attempt.body.node.state, "cancelled");
    const model = tabsModel([(await listing("alice")).body, (await listing("alice", "pane")).body]);
    const tab = model.tabs.find((t) => t.agent_id === `agent:${lead}`);
    assert.equal(tab?.state, "running");
    assert.equal(tab?.surface?.closed, true, "the client shows the surface as closed");
    assert.equal(tab?.panes.length, 2);

    // a surface writer cannot flip someone else's agent: the closing path has no authority over the worker
    const before = JSON.stringify(
      (await plane.c("GET", `/graph/nodes/${encodeURIComponent(`agent:${lead}`)}`, { user: "alice" })).body.node,
    );
    const kill = await put(`agent:${lead}`, "node.state", { node_id: `agent:${lead}`, state: "cancelled" });
    assert.equal(kill.status, 403);
    assert.equal(kill.body.reason, "lineage_forbidden");
    assert.equal(
      JSON.stringify(
        (await plane.c("GET", `/graph/nodes/${encodeURIComponent(`agent:${lead}`)}`, { user: "alice" })).body.node,
      ),
      before,
    );
  });

  it("a key may address only the rooms the operator listed; a refused event leaves no trace", async () => {
    const stable = async () =>
      Object.fromEntries(
        Object.entries(await plane.sources()).map(([k, v]) => [
          k,
          { seq: v.last_sequence, gaps: v.gaps, seen: (v as unknown as { last_seen_at: string }).last_seen_at },
        ]),
      );
    const before = await stable();
    const refused = await plane.call("POST", "/api/v1/ingest", {
      key: "scoped",
      body: raw("e2e-scoped", 0, "agent:intruder", "node.upsert", {
        node_type: "agent",
        node_id: "agent:intruder",
        state: "running",
      }),
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.reason, "lineage_forbidden");
    assert.deepEqual(await stable(), before, "no sequence consumed, no source created");
    assert.ok(!ids((await listing("alice")).body.nodes).includes("agent:intruder"));
    // positive control: the same key is accepted for the room the operator listed
    const ok = await plane.call("POST", "/api/v1/ingest", {
      key: "scoped",
      body: raw(
        "e2e-scoped",
        0,
        "agent:elsewhere",
        "node.upsert",
        { node_type: "agent", node_id: "agent:elsewhere", state: "running" },
        { room_id: "room-elsewhere", workspace_id: undefined },
      ),
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(
      !ids((await listing("alice")).body.nodes).includes("agent:elsewhere"),
      "and it does not show up in this room",
    );
  });

  it("membership-scoped reads: members read; guests, outsiders and other rooms' members get one indistinguishable 404", async () => {
    for (const who of ["alice", "bob"]) {
      const r = await listing(who);
      assert.equal(r.status, 200, who);
      assert.ok(ids(r.body.nodes).includes(`agent:${lead}`));
      assert.equal((await lineage(who)).status, 200);
      assert.equal(
        (await plane.c("GET", `/graph/nodes/${encodeURIComponent(`agent:${lead}`)}`, { user: who })).status,
        200,
      );
    }
    // control: dave has a graph of his own room
    assert.equal((await listing("dave", "agent", room2)).status, 200);
    assert.deepEqual((await listing("dave", "agent", room2)).body.nodes, []);
    const missing = await plane.c("GET", `/graph/nodes/${encodeURIComponent("agent:does-not-exist")}`, {
      user: "dave",
    });
    for (const who of ["carol", "mallory", "dave"]) {
      for (const path of [
        `/graph/nodes?node_type=agent&edge_type=spawn&room_id=${roomId}`,
        `/graph/lineage?room_id=${roomId}`,
        `/graph/lineage/timeline?room_id=${roomId}`,
        `/graph/lineage/events?room_id=${roomId}`,
      ]) {
        const r = await plane.c("GET", path, { user: who });
        assert.equal(r.status, 404, `${who} ${path}`);
        assert.deepEqual(r.body, { error: "not found" });
      }
      const guess = await plane.c("GET", `/graph/nodes/${encodeURIComponent(`agent:${lead}`)}`, { user: who });
      assert.equal(guess.status, 404);
      assert.deepEqual(
        guess.body,
        (await plane.c("GET", `/graph/nodes/${encodeURIComponent("agent:does-not-exist")}`, { user: who })).body,
      );
      assert.deepEqual(guess.body, missing.body, "an existing and a missing node answer alike");
    }
    // the keyed fleet API does not turn room-scoped lineage into something a viewer key can read; an HCN token is no key
    assert.equal((await plane.node(`agent:${lead}`, "viewer")).status, 404);
    assert.equal((await plane.node(`agent:${lead}`, "operator")).status, 200);
    assert.equal(
      (await plane.call("GET", `/api/v1/graph/nodes/${encodeURIComponent(`agent:${lead}`)}`, { user: "alice" })).status,
      401,
    );
  });

  it("a workspace link that grants nothing hides that workspace's agents at the next read; restoring the grant brings them back", async () => {
    const hasB = async () => ids((await listing("alice")).body.nodes).includes(`agent:${agentB}`);
    assert.equal(await hasB(), true, "control: visible while granted");
    const off = await plane.c("POST", `/rooms/${roomId}/workspaces/${linkB}/grants`, {
      user: "alice",
      body: { grants: [] },
    });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(await hasB(), false);
    assert.ok(ids((await listing("alice")).body.nodes).includes(`agent:${lead}`), "workspace A is unaffected");
    const on = await plane.c("POST", `/rooms/${roomId}/workspaces/${linkB}/grants`, {
      user: "alice",
      body: { grants: ["status", "tabs", "panes"] },
    });
    assert.equal(on.status, 200);
    assert.equal(await hasB(), true);
  });

  it("revoking a member takes effect on the very next read", async () => {
    assert.equal((await listing("bob")).status, 200, "control");
    const rm = await plane.c("POST", `/rooms/${roomId}/members/bob/remove`, { user: "alice" });
    assert.equal(rm.status, 200, JSON.stringify(rm.body));
    assert.equal((await listing("bob")).status, 404);
    assert.equal((await lineage("bob")).status, 404);
    assert.equal(
      (await plane.c("GET", `/graph/nodes/${encodeURIComponent(`agent:${lead}`)}`, { user: "bob" })).status,
      404,
    );
    assert.equal((await listing("alice")).status, 200, "the owner still reads");
  });

  it("no fake progress: every source still gap-free after all of the above", async () => {
    for (const s of Object.values(await plane.sources())) assert.deepEqual(s.gaps, [], String(s.source));
  });
});
