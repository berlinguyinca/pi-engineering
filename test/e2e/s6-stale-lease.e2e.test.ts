import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import type { MissionLease, WorkspaceManifest } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { startPiHost } from "./support/piHost.ts";
import { Plane, eventually } from "./support/plane.ts";
/**
 * ACCEPTANCE SCENARIO 6 (Pi side, stale lease). A mission controller loses its lease (it stalled past the lease TTL);
 * a second controller on ANOTHER host takes over with a higher generation and fencing token. The old holder's
 * identity must be refused ("stale ... fencing identity"), the takeover must reuse the same logical agent id, and
 * Herdr must show only what the authoritative holders really did: no fabricated completion for the old attempt.
 *
 * Real pieces: real MissionOwnership/MissionStore over a durable JSONL file (reopened = process restart), two Pi
 * hosts with their own YAML-configured emitters against a real control plane. Time is injected into the Pi lease
 * clock (a Pi test seam), not faked on the server.
 */
import { scratch } from "./support/scratch.ts";

function gitRepo(): string {
  const d = scratch("t16-s6lease-repo-");
  const g = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t16@example.invalid");
  g("config", "user.name", "t16");
  writeFileSync(join(d, "README.md"), "x\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  return d;
}

const manifest = (missionId: string, repo: string, base: string): WorkspaceManifest => ({
  manifestId: `WM-${missionId}`,
  missionId,
  generation: 1,
  authorizedRoots: [{ canonicalPath: repo, source: "existing_manifest", access: "write" }],
  repositories: [{ repoId: "repo-1", canonicalRoot: repo, baseRef: "main", baseSha: base, writableDomains: ["**"] }],
  dependencyEdges: [],
  hash: `hash-${missionId}`,
  createdAt: new Date().toISOString(),
});

describe("scenario 6 (Pi): stale lease, takeover, fencing", () => {
  let plane: Plane;
  let roomId = "";
  let leaseA: MissionLease;
  let leaseB: MissionLease;
  let ownershipB: MissionOwnership;
  const MISSION = "MSN-s6lease";
  const TASK = "task-s6lease";
  let exA = "";
  let exB = "";
  let exC = "";

  before(async () => {
    plane = await Plane.start({
      keys: { fleet: "ingest", rogue: "ingest" },
      users: ["alice"],
      scopes: { fleet: { rooms: ["*"] }, rogue: { rooms: ["*"] } },
    });
    await plane.verifyFeatures("alice");
    roomId = (await plane.makeRoom("alice", "lease", "lease-room")).roomId;
    const repo = gitRepo();
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
    const dir = scratch("t16-s6lease-");
    const file = join(dir, "events.jsonl");
    let now = Date.parse("2026-09-26T10:00:00.000Z");

    // ---- controller A (host A) holds the lease and spawns attempt A
    const hostA = await startPiHost(plane, { key: "fleet", instanceId: "ctl-a", roomId });
    const backendA = await JsonlEventStore.open(file);
    const storeA = MissionStore.open(backendA);
    storeA.setLineage(hostA.emitter);
    storeA.createMission({
      mission_id: MISSION,
      title: "lease",
      goal: "g",
      user_request: "u",
      repository: repo,
      base_ref: "main",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    storeA.bindWorkspaceManifest(manifest(MISSION, repo, base));
    const mk = (s: MissionStore) =>
      s.createTask({
        task_id: TASK,
        mission_id: MISSION,
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
    mk(storeA);
    const ownershipA = new MissionOwnership(storeA, { ownerId: "controller-a", now: () => now, leaseMs: 10_000 });
    leaseA = await ownershipA.acquire(MISSION);
    exA = storeA.createExecution({
      task_id: TASK,
      mission_id: MISSION,
      backend: "agent",
      checkpoint_id: "TCP-a",
      repo_id: "repo-1",
      base_sha: base,
    }).execution_id;
    storeA.setExecutionStatus(exA, "RUNNING", {});
    await storeA.flush();
    await hostA.drain();
    backendA.close();

    // ---- A stalls past its TTL; controller B (host B, SAME fleet key, own source) restarts from the durable file
    now += 10_001;
    const hostB = await startPiHost(plane, { key: "fleet", instanceId: "ctl-b", roomId });
    const backendB = await JsonlEventStore.open(file);
    const storeB = MissionStore.open(backendB);
    storeB.setLineage(hostB.emitter);
    ownershipB = new MissionOwnership(storeB, { ownerId: "controller-b", now: () => now, leaseMs: 10_000 });
    leaseB = await ownershipB.acquire(MISSION);
    exB = storeB.createExecution({
      task_id: TASK,
      mission_id: MISSION,
      backend: "agent",
      checkpoint_id: "TCP-b",
      repo_id: "repo-1",
      base_sha: base,
    }).execution_id;
    storeB.setExecutionStatus(exB, "RUNNING", {});
    await storeB.flush();
    await hostB.drain();

    // ---- a third controller on a host with a DIFFERENT key tries to continue the same logical agent
    const hostC = await startPiHost(plane, { key: "rogue", instanceId: "ctl-c", roomId });
    const storeC = MissionStore.open(JsonlEventStore.inMemory());
    storeC.setLineage(hostC.emitter);
    storeC.createMission({
      mission_id: MISSION,
      title: "lease",
      goal: "g",
      user_request: "u",
      repository: repo,
      base_ref: "main",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    storeC.bindWorkspaceManifest(manifest(MISSION, repo, base));
    mk(storeC);
    exC = storeC.createExecution({
      task_id: TASK,
      mission_id: MISSION,
      backend: "agent",
      checkpoint_id: "TCP-c",
      repo_id: "repo-1",
      base_sha: base,
    }).execution_id;
    storeC.setExecutionStatus(exC, "RUNNING", {});
    await hostC.drain();
    await eventually(async () => {
      const src = Object.values(await plane.sources()).filter((s) => String(s.source).startsWith("pi-"));
      return (
        src.length >= 3 &&
        (await plane.node(`attempt:${exA}`)).status === 200 &&
        (await plane.node(`attempt:${exB}`)).status === 200
      );
    }, "all three hosts to have reported");
  });

  after(async () => {
    await plane?.stop();
  });

  it("the stale holder's identity is refused after takeover; the new holder's is authoritative (control)", () => {
    assert.equal(leaseB.generation, leaseA.generation + 1);
    assert.ok(leaseB.fencingToken > leaseA.fencingToken);
    assert.throws(() => ownershipB.assertAuthoritative(leaseA), /stale.*fencing/i);
    assert.doesNotThrow(() => ownershipB.assertAuthoritative(leaseB));
  });

  it("the SAME owner id re-acquiring after expiry gets a higher generation/token, and its own older identity is refused", async () => {
    // Same ownerId on purpose: the owner-id comparison cannot tell the two epochs apart, only generation/fencingToken can.
    let now = Date.parse("2026-09-26T12:00:00.000Z");
    const store = MissionStore.open(JsonlEventStore.inMemory());
    store.createMission({
      mission_id: "MSN-same-owner",
      title: "t",
      goal: "g",
      user_request: "u",
      repository: "/tmp/none",
      base_ref: "main",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const own = new MissionOwnership(store, { ownerId: "controller-same", now: () => now, leaseMs: 10_000 });
    const first = await own.acquire("MSN-same-owner");
    assert.doesNotThrow(() => own.assertAuthoritative(first)); // control: before expiry it IS authoritative
    now += 10_001;
    const second = await own.acquire("MSN-same-owner");
    assert.equal(second.ownerId, first.ownerId);
    assert.ok(second.generation > first.generation && second.fencingToken > first.fencingToken);
    assert.throws(() => own.assertAuthoritative(first), /stale.*fencing/i);
    await assert.rejects(() => own.renew(first), /stale.*fencing/i);
    assert.doesNotThrow(() => own.assertAuthoritative(second)); // control: the new epoch is authoritative
    // a forged identity: right owner, right generation, OLD token
    assert.throws(() => own.assertAuthoritative({ ...second, fencingToken: first.fencingToken }), /stale.*fencing/i);
    assert.throws(() => own.assertAuthoritative({ ...second, generation: first.generation }), /stale.*fencing/i);
  });

  it("Herdr shows the takeover under ONE stable logical agent with two attempts, attributed to their own hosts", async () => {
    const agent = await plane.node(`agent:${TASK}`);
    assert.equal(agent.status, 200);
    const nodes = await Promise.all([exA, exB].map((e) => plane.node(`attempt:${e}`)));
    for (const n of nodes) assert.equal(n.status, 200);
    assert.notEqual(
      nodes[0]?.body.node.attrs.instance_id,
      nodes[1]?.body.node.attrs.instance_id,
      "attempts carry their own instance",
    );
    assert.equal(nodes[0]?.body.node.attrs.instance_id, "ctl-a");
    assert.equal(nodes[1]?.body.node.attrs.instance_id, "ctl-b");
    assert.equal(nodes[0]?.body.node.attrs.agent_id, `agent:${TASK}`);
    assert.equal(nodes[1]?.body.node.attrs.agent_id, `agent:${TASK}`);
  });

  it("no fabricated progress: the stalled holder's attempt keeps exactly what it last reported; nobody marks it done or cancelled", async () => {
    const a = await plane.node(`attempt:${exA}`);
    assert.equal(a.body.node.state, "running", "its last real report");
    const hood = await plane.hood(`attempt:${exA}`, "operator", 1);
    assert.deepEqual(
      (hood.body.nodes as Array<{ id: string }>).map((n) => n.id).sort(),
      [`attempt:${exA}`],
      "no edge or node was invented around it",
    );
  });

  it("a controller under ANOTHER key cannot rewrite the logical agent it did not create (host-migration trust)", async () => {
    const agent = await plane.node(`agent:${TASK}`);
    const writers = new Set<string>();
    for (const f of Object.values(agent.body.node.fields ?? {}) as Array<unknown>) {
      const v = f as { writer?: string };
      if (v?.writer) writers.add(v.writer);
    }
    assert.ok(writers.has(plane.pid("fleet")), "the creating fleet key wrote the agent");
    assert.ok(!writers.has(plane.pid("rogue")), "the rogue key's agent upsert was refused, not merged");
    // positive control: the same fleet key on the takeover host DID write (state moved to running by host B too)
    assert.equal(agent.body.node.state, "running");
  });
});
