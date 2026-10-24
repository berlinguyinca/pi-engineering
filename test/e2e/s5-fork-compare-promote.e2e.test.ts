/**
 * ACCEPTANCE SCENARIO 5 (Pi side). A reviewer's verdict failed at a historical commit. A room contributor comments on
 * the failed review, proposes a fork of the attempt from that historical commit with a changed requirement, the room
 * owner confirms it, Pi's steering receiver applies it at its own safe boundary (isolated worktree, original branch and
 * evidence untouched), the alternatives are compared through Herdr, and the winner is promoted by compare-and-set with
 * a real push to a real bare remote and a draft PR opened through a fake `gh`.
 *
 * Real pieces: a real Herdr control-plane process (YAML-configured, hot-reloaded for the kill switch), a Pi "host"
 * (global engineering.yaml `herdr:`/`steering:`/`forks:` blocks, key file, state dir) with the REAL fork runtime and the
 * REAL SteeringReceiver wired the way EngineeringRuntime wires them, a real MissionStore publishing the attempt and
 * its checkpoint, a real git repository with a real bare `origin`. The only fake is test/e2e/fake_gh_s5/gh (GitHub's
 * REST API), which reports the head SHA the bare repository really holds.
 *
 * Gaps are named `GAP:` and assert the CURRENT behaviour. Nothing here calls an emitter primitive to fill a gap.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { forkIdFor } from "../../src/orchestration/forks.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { SteeringPorts } from "../../src/orchestration/steering.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { type SteeringReceiver, createSteeringReceiver } from "../../src/runtime/herdr/SteeringReceiver.ts";
import { type ForkRuntime, createForkRuntime } from "../../src/runtime/herdr/forkWiring.ts";
import { type PiHost, startPiHost } from "./support/piHost.ts";
import { Plane, eventually } from "./support/plane.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const enc = encodeURIComponent;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t16@example.invalid", "-c", "user.name=t16", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
const bareGit = (bare: string, ...args: string[]): string =>
  execFileSync("git", ["--git-dir", bare, ...args], { encoding: "utf8" }).trim();
const tryBare = (bare: string, ...args: string[]): string | null => {
  try {
    return bareGit(bare, ...args);
  } catch {
    return null;
  }
};

describe("scenario 5: comment on a failed review, fork from history, compare, promote", () => {
  let plane: Plane;
  let roomId = "";
  let host: PiHost;
  let hostOther: PiHost;
  let hostSameKey: PiHost;
  let runtime: ForkRuntime;
  let receiver: SteeringReceiver;
  let rxOtherKey: SteeringReceiver;
  let rxOtherInstance: SteeringReceiver;
  let store: MissionStore;
  let executionId = "";
  let attemptNode = "";
  let repo = "";
  let bare = "";
  let ghDir = "";
  const sha: Record<"C0" | "C1" | "C2", string> = { C0: "", C1: "", C2: "" };
  let mainAtStart = "";
  let edgesBefore: string[] = [];
  const seq: Record<string, number> = {};
  const forks: Record<string, { steeringId: string; id: string; node: string; branch: string; worktree: string }> = {};
  const rec: Record<string, string> = {};

  // ---- raw lineage by an operator key (what an external reviewer or CI writes; Pi never writes these)
  const send = async (key: string, type: string, entity: string, payload: Record<string, unknown>) => {
    seq[key] = (seq[key] ?? 0) + 1;
    const r = await plane.call("POST", "/api/v1/ingest", {
      key,
      body: {
        schema_version: 2,
        event_id: `s5-${key}-${seq[key]}`,
        source: `s5-${key}`,
        source_sequence: seq[key],
        occurred_at: new Date().toISOString(),
        entity_type: "lineage",
        entity_id: entity,
        event_type: type,
        payload,
        visibility_scope: "room",
        room_id: roomId,
        evidence_refs: [],
      },
    });
    assert.equal(r.status, 200, `${type} ${entity}: ${JSON.stringify(r.body)}`);
  };
  const rawNode = (key: string, id: string, state: string, attrs: Record<string, unknown> = {}) =>
    send(key, "node.upsert", id, { node_type: id.split(":")[0], node_id: id, state, attrs });
  const rawEdge = (key: string, edge_type: string, from_id: string, to_id: string, attrs?: Record<string, unknown>) =>
    send(key, "edge.add", from_id, { edge_type, from_id, to_id, ...(attrs ? { attrs } : {}) });

  // ---- Herdr (HCN) helpers
  const target = (node: string, user = "alice") =>
    plane.c("GET", `/rooms/${roomId}/steering/target?node_id=${enc(node)}`, { user });
  const propose = async (user: string, action: string, node: string, extra: Record<string, unknown> = {}) => {
    const t = await target(node);
    return plane.c("POST", `/rooms/${roomId}/steering`, {
      user,
      body: {
        action,
        node_id: node,
        expected_fence: t.body.fence,
        idempotency_key: `k-${Math.random().toString(16).slice(2)}`,
        ...extra,
      },
    });
  };
  const confirm = async (user: string, st: { steering_id: string; digest: string }, node: string) =>
    plane.c("POST", `/rooms/${roomId}/steering/${st.steering_id}/confirm`, {
      user,
      body: { digest: st.digest, expected_fence: (await target(node)).body.fence },
    });
  const steeringList = async (user = "alice") =>
    ((await plane.c("GET", `/rooms/${roomId}/steering`, { user })).body.steering ?? []) as Array<{
      steering_id: string;
      status: string;
      action: string;
      ack?: { outcome: string; note: string };
    }>;
  const statusOf = async (id: string) => (await steeringList()).find((s) => s.steering_id === id);
  const comparison = (user: string, node = attemptNode) =>
    plane.c("GET", `/rooms/${roomId}/forks?node_id=${enc(node)}`, { user });
  const setSteering = (patch: Record<string, unknown>) => {
    const file = join(plane.workdir, "plane-fleet.yaml");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.sections.control_plane.values.collab.steering = {
      enabled: true,
      self_confirm: false,
      actions: ["pause", "redirect", "fork", "promote"],
      forks: {
        enabled: true,
        evidence_writers: [plane.pid("ci")],
        require_validation: true,
        max_forks_per_origin: 5,
        max_open_forks_per_room: 8,
      },
      ...patch,
    };
    writeFileSync(file, JSON.stringify(doc));
    chmodSync(file, 0o600);
  };
  const edgeKeys = async (node: string) => (await plane.edges(node)).map((e) => e.join("|"));

  // ---- the "agent" doing work inside a fork's worktree (a real commit on the fork's own branch)
  const worktreeOf = (branch: string): string => {
    const out = git(repo, "worktree", "list", "--porcelain");
    for (const block of out.split("\n\n")) {
      if (block.includes(`branch refs/heads/${branch}`)) return block.split("\n")[0]?.replace("worktree ", "") ?? "";
    }
    return "";
  };
  const work = (name: string, file: string, text: string): string => {
    const wt = forks[name]?.worktree as string;
    mkdirSync(dirname(join(wt, file)), { recursive: true });
    writeFileSync(join(wt, file), text);
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", `work for ${name}`);
    return git(wt, "rev-parse", "HEAD");
  };
  const reportedHead = async (node: string) => {
    const r = await plane.node(node);
    return (r.body.node?.attrs?.head_sha as string | undefined) ?? null;
  };

  /** propose (bob) + confirm (alice) a fork from the historical commit; returns the steering id */
  const requestFork = async (name: string, label: string): Promise<string> => {
    const p = await propose("bob", "fork", attemptNode, { base_sha: sha.C1, label });
    assert.ok([200, 201].includes(p.status), JSON.stringify(p.body));
    const c = await confirm("alice", p.body.steering, attemptNode);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const steeringId = p.body.steering.steering_id as string;
    const id = forkIdFor(steeringId);
    forks[name] = { steeringId, id, node: `approach:${id}`, branch: `pi-fork/${id}`, worktree: "" };
    return steeringId;
  };
  const applyFork = async (name: string) => {
    const r = await receiver.pollOnce();
    assert.equal(r.error, null);
    const f = forks[name] as (typeof forks)[string];
    await eventually(async () => (await plane.node(f.node)).status === 200, `${f.node} reported`);
    f.worktree = worktreeOf(f.branch);
    assert.ok(f.worktree && existsSync(f.worktree), "the fork has its own worktree");
    return r;
  };

  before(async () => {
    plane = await Plane.start({
      keys: { pi: "ingest", other: "ingest", ci: "operator", rev: "operator" },
      users: ["alice", "bob", "carol", "dave", "mallory"],
      scopes: { pi: { rooms: ["*"], missions: ["*"] }, other: { rooms: ["*"], missions: ["*"] } },
    });
    await plane.verifyFeatures("alice");
    roomId = (await plane.makeRoom("alice", "p5", "room-5")).roomId;
    await plane.addMember("alice", roomId, "bob", "contributor");
    await plane.addMember("alice", roomId, "carol", "viewer");
    await plane.addMember("alice", roomId, "dave", "guest");
    setSteering({});

    // a real repository: C0 base, C1 the attempt's (reviewed, failed) result, C2 main moved on since
    const parent = mkdtempSync(join(tmpdir(), "t16-s5-"));
    repo = join(parent, "repo");
    bare = join(parent, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "work.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "c0");
    sha.C0 = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "work.txt"), "base\nretry loop\n");
    git(repo, "commit", "-q", "-am", "c1 attempt result");
    sha.C1 = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "docs.txt"), "later docs\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "c2 main moved on");
    sha.C2 = git(repo, "rev-parse", "HEAD");
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-q", "origin", "main");
    mainAtStart = sha.C2;

    // the fake gh and its sidecar config (the bare repository is the "remote")
    ghDir = mkdtempSync(join(tmpdir(), "t16-s5-gh-"));
    copyFileSync(join(HERE, "fake_gh_s5", "gh"), join(ghDir, "gh"));
    const script = readFileSync(join(ghDir, "gh"), "utf8").replace("#!/usr/bin/env node", `#!${process.execPath}`);
    writeFileSync(join(ghDir, "gh"), script);
    chmodSync(join(ghDir, "gh"), 0o755);
    writeFileSync(join(ghDir, "gh.config.json"), JSON.stringify({ bare, repo: "acme/widgets", firstNumber: 100 }));

    // the Pi host
    host = await startPiHost(plane, { key: "pi", instanceId: "inst-a", roomId });
    appendFileSync(
      join(host.agentDir, "engineering.yaml"),
      [
        "steering:",
        "  enabled: true",
        "  poll_seconds: 1",
        "forks:",
        "  enabled: true",
        "  max_total: 6",
        "  max_per_origin: 5",
        "  min_free_mb: 0",
        "  refresh_seconds: 5",
        "  promote:",
        "    enabled: true",
        "    draft: true",
        `    remote_url: ${bare}`,
        "    github:",
        "      hosts: [github.com]",
        "      default_repo: acme/widgets",
        `      gh_path: ${join(ghDir, "gh")}`,
        "",
      ].join("\n"),
    );

    // the mission and its attempt, published through the real store + emitter
    store = MissionStore.open(JsonlEventStore.inMemory());
    store.setLineage(host.emitter);
    const mission = store.createMission({
      mission_id: "MSN-s5",
      title: "retry loop",
      goal: "make the client retry",
      user_request: "retry",
      repository: repo,
      base_ref: "main",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.bindWorkspaceManifest({
      manifestId: "WM-s5",
      missionId: mission.mission_id,
      generation: 1,
      authorizedRoots: [{ canonicalPath: repo, source: "existing_manifest", access: "write" }],
      repositories: [
        { repoId: "repo-1", canonicalRoot: repo, baseRef: "main", baseSha: sha.C0, writableDomains: ["**"] },
      ],
      dependencyEdges: [],
      hash: "hash-s5",
      createdAt: new Date().toISOString(),
    });
    const task = store.createTask({
      task_id: "task-a",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "retry",
      repo_id: "repo-1",
      acceptance_ids: ["AC-1"],
      deliverables: ["retry"],
      execution_budget_ms: 60_000,
      checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
      candidate_generation: 0,
      mission_generation: 0,
      fencing_token: 0,
    });
    const execution = store.createExecution({
      task_id: task.task_id,
      mission_id: mission.mission_id,
      backend: "agent",
      checkpoint_id: "TCP-s5",
      repo_id: "repo-1",
      base_sha: sha.C0,
    });
    executionId = execution.execution_id;
    attemptNode = `attempt:${executionId}`;
    store.setExecutionStatus(executionId, "RUNNING", {});
    await store.publishCheckpointIfAuthoritative({
      checkpointId: "TCP-s5",
      executionId,
      missionId: mission.mission_id,
      taskId: task.task_id,
      repoId: "repo-1",
      baseSha: sha.C0,
      candidateSha: sha.C1,
      branch: "main",
      worktree: repo,
      committedChanges: [],
      preservedUncommittedChanges: [],
      completedDeliverables: [],
      remainingDeliverables: [],
      acceptanceIds: ["AC-1"],
      validationEvidenceRefs: [],
      artifactRefs: [],
      artifactHashes: [],
      workerId: null,
      sessionId: null,
      model: null,
      sequence: 1,
      missionGeneration: 0,
      candidateGeneration: 0,
      fencingToken: 0,
      createdAt: new Date().toISOString(),
    });
    await host.drain();

    // the failed review: an external reviewer's operator key writes a `reviewed` edge bound to C1. (AutoSpec's own
    // publisher writes org-scoped nodes a room member cannot read, so it cannot be the comment target: see GAP below.)
    await rawNode("rev", "review:r1", "failed", {});
    await rawEdge("rev", "reviewed", "review:r1", attemptNode, { commit: sha.C1, verdict: "changes_requested" });

    // Pi's runtime pieces, wired the way EngineeringRuntime wires them
    const sources = {
      getTask: (id: string) => store.getTask(id),
      getExecution: (id: string) => store.getExecution(id),
      getMission: (id: string) => store.getMission(id),
      boundRoot: (_repoId: string) => repo,
      openRoot: async (path: string) => (await GitRepo.open(path))?.root ?? null,
      links: store,
    };
    const rt = await createForkRuntime({
      agentDir: host.agentDir,
      stateDir: host.stateDir,
      lineage: host.emitter,
      sources,
      log: () => undefined,
    });
    assert.ok(rt, "forks.enabled in the global YAML builds the fork runtime");
    runtime = rt;
    const ports: SteeringPorts = {
      forks: runtime.port,
      resolve: () => null,
      steerRunning: () => "no_channel",
      resumeMission: async () => ({ changed: false }),
      now: () => Math.floor(Date.now() / 1000),
    };
    const rx = await createSteeringReceiver({ agentDir: host.agentDir, stateDir: host.stateDir, ports });
    assert.ok(rx, "steering.enabled + herdr block build the receiver");
    receiver = rx;

    // two more receivers: a different key, and the same key under a different instance_id. They know no fork, so they
    // can only ever observe what Herdr offers them.
    const notMine: SteeringPorts = {
      forks: { knows: () => false, apply: async () => ({ outcome: "unsupported", note: "not mine" }) },
      resolve: () => null,
      steerRunning: () => "no_channel",
      resumeMission: async () => ({ changed: false }),
      now: () => Math.floor(Date.now() / 1000),
    };
    const steeringYaml = "steering:\n  enabled: true\n  poll_seconds: 1\n";
    hostOther = await startPiHost(plane, { key: "other", instanceId: "inst-b", roomId });
    appendFileSync(join(hostOther.agentDir, "engineering.yaml"), steeringYaml);
    rxOtherKey = (await createSteeringReceiver({
      agentDir: hostOther.agentDir,
      stateDir: hostOther.stateDir,
      ports: notMine,
    })) as SteeringReceiver;
    hostSameKey = await startPiHost(plane, { key: "pi", instanceId: "inst-c", roomId });
    appendFileSync(join(hostSameKey.agentDir, "engineering.yaml"), steeringYaml);
    rxOtherInstance = (await createSteeringReceiver({
      agentDir: hostSameKey.agentDir,
      stateDir: hostSameKey.stateDir,
      ports: notMine,
    })) as SteeringReceiver;
    assert.ok(rxOtherKey && rxOtherInstance);
    edgesBefore = await edgeKeys(attemptNode);
  });

  after(async () => {
    runtime?.stop();
    receiver?.stop();
    await plane?.stop();
  });

  it("the review failed at the historical commit and the room can see it (control for every refusal below)", async () => {
    assert.ok(edgesBefore.includes(`reviewed|review:r1|${attemptNode}`), edgesBefore.join(","));
    assert.ok(
      edgesBefore.some((e) => e.startsWith("produced|")),
      "the checkpoint binds the attempt to C1",
    );
    const lineage = (user: string) => plane.c("GET", `/graph/lineage?room_id=${roomId}&limit=200`, { user });
    const seen = (await lineage("carol")).body.edges.map((e: { edge_type: string }) => e.edge_type);
    assert.ok(seen.includes("reviewed"), "a viewer sees the failed review");
    const outsider = await lineage("mallory");
    assert.ok(outsider.status === 403 || outsider.status === 404, `outsider: ${outsider.status}`);
    const t = await target(attemptNode, "bob");
    assert.equal(t.status, 200);
    assert.ok(t.body.actions.includes("fork"), `fork offered: ${t.body.actions}`);
    assert.ok(Object.keys(t.body.fork.base_candidates).includes(sha.C1), "C1 is a base candidate; C0 is not the head");
  });

  it("a contributor COMMENTS on the failed review: a durable note on the graph node, not a change request", async () => {
    const post = (user: string, text: string) =>
      plane.c("POST", `/rooms/${roomId}/comments`, {
        user,
        body: { anchor: { kind: "node", node_id: "review:r1" }, text, idempotency_key: `c-${Math.random()}` },
      });
    const ok = await post("bob", "the retry loop never terminates under load");
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    for (const who of ["carol", "dave", "mallory"]) {
      const r = await post(who, "should not be able to");
      assert.ok([403, 404].includes(r.status), `${who}: ${r.status}`);
    }
    const listed = await plane.c("GET", `/rooms/${roomId}/comments?anchor_kind=node&node_id=review:r1`, {
      user: "carol",
    });
    assert.equal(listed.body.comments.length, 1);
    assert.equal(listed.body.comments[0].author.id, "bob");
    // durable: the plane keeps it across the comment being read by anyone later
    const again = await plane.c("GET", `/rooms/${roomId}/comments?anchor_kind=node&node_id=review:r1`, {
      user: "alice",
    });
    assert.equal(again.body.comments[0].comment_id, listed.body.comments[0].comment_id);
    // a comment is not a request: no steering exists, the review and the attempt are untouched, Pi is offered nothing
    assert.deepEqual(await steeringList(), []);
    assert.deepEqual(await edgeKeys(attemptNode), edgesBefore);
    assert.equal((await receiver.pollOnce()).received, 0);
  });

  it("only owners and contributors can propose a fork, and base commits must be real candidates", async () => {
    const t = await target(attemptNode, "bob");
    for (const who of ["carol", "dave", "mallory"]) {
      const r = await plane.c("POST", `/rooms/${roomId}/steering`, {
        user: who,
        body: {
          action: "fork",
          node_id: attemptNode,
          expected_fence: t.body.fence,
          idempotency_key: `n-${who}`,
          base_sha: sha.C1,
          label: "nope",
        },
      });
      assert.ok([403, 404].includes(r.status), `${who}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual(await steeringList(), [], "nothing was recorded for the refused callers");
    const dangling = await propose("bob", "fork", attemptNode, { base_sha: "e".repeat(40), label: "x" });
    assert.ok([400, 409].includes(dangling.status), JSON.stringify(dangling.body));
    // POSITIVE CONTROL: the same request from the contributor with a real candidate is accepted (not a feature-off 403)
    const ok = await propose("bob", "fork", attemptNode, { base_sha: sha.C1, label: "control" });
    assert.ok([200, 201].includes(ok.status), JSON.stringify(ok.body));
    const rej = await plane.c("POST", `/rooms/${roomId}/steering/${ok.body.steering.steering_id}/reject`, {
      user: "alice",
      body: {},
    });
    assert.equal(rej.status, 200, JSON.stringify(rej.body));
  });

  it("the owner confirms; a different key is offered nothing and the kill switch withholds the request without a restart", async () => {
    rec.fk1Label = "queue based retry (max 3 tries, 5s cap)";
    await requestFork("fk1", rec.fk1Label);
    const bobSelf = await propose("bob", "fork", attemptNode, { base_sha: sha.C1, label: "second" });
    assert.ok([200, 201].includes(bobSelf.status));
    assert.equal((await confirm("bob", bobSelf.body.steering, attemptNode)).status, 403, "the proposer cannot confirm");
    await plane.c("POST", `/rooms/${roomId}/steering/${bobSelf.body.steering.steering_id}/reject`, {
      user: "alice",
      body: {},
    });

    // delivery is pinned to the key that reported the node
    const otherKey = await rxOtherKey.pollOnce();
    assert.deepEqual([otherKey.received, otherKey.acked], [0, 0], "a different key is offered nothing");

    // kill switch: rewrite the plane's YAML (no restart); the confirmed request is withheld and new ones refused
    const pid = plane.proc?.pid;
    setSteering({ kill_switch: true });
    const killed = await receiver.pollOnce();
    assert.deepEqual([killed.received, killed.error], [0, null], "kill switch withholds a confirmed request");
    const refused = await plane.c("POST", `/rooms/${roomId}/steering`, {
      user: "bob",
      body: {
        action: "fork",
        node_id: attemptNode,
        expected_fence: "x",
        idempotency_key: "ks",
        base_sha: sha.C1,
        label: "ks",
      },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "steering_disabled");
    setSteering({});
    assert.equal(plane.proc?.pid, pid, "no restart was needed");
    assert.ok(plane.alive());
  });

  it("the same key under another instance_id is NOT offered the request: the emitter stamps attrs.instance_id (T16 glue)", async () => {
    // Herdr pins a request to the target node's attrs.instance_id. Pi's emitter now stamps the YAML `herdr.instance_id`
    // on every node it upserts, so two Pi instances sharing a key are separated.
    const node = (await plane.node(attemptNode)).body.node;
    assert.equal(node.attrs.instance_id, "inst-a");
    const sameKey = await rxOtherInstance.pollOnce();
    assert.deepEqual([sameKey.received, sameKey.skipped, sameKey.acked], [0, 0, 0]);
    // positive control: the instance named in the pin IS offered it (the next test applies and acks it)
  });

  it("the right host applies the confirmed fork at its own boundary: isolated worktree, original untouched, acked", async () => {
    const steeringId = (forks.fk1 as (typeof forks)[string]).steeringId;
    const applied = await applyFork("fk1");
    assert.equal(applied.received, 1);
    assert.equal(applied.acked, 1);
    const st = await statusOf(steeringId);
    assert.equal(st?.ack?.outcome, "applied", JSON.stringify(st));
    const f = forks.fk1 as (typeof forks)[string];
    assert.ok(st?.ack?.note.includes(f.node), st?.ack?.note);
    assert.equal(git(f.worktree, "rev-parse", "HEAD"), sha.C1, "the fork starts exactly at the historical commit");
    assert.equal(git(repo, "rev-parse", "main"), mainAtStart, "the original branch ref did not move");
    assert.notEqual(f.worktree, repo, "an isolated worktree");
  });

  it("the fork is a new approach beside the original; the original attempt and its evidence are untouched", async () => {
    const f = forks.fk1 as (typeof forks)[string];
    await host.drain();
    const node = (await plane.node(f.node)).body.node;
    assert.equal(node.attrs.base_sha, sha.C1);
    assert.equal(node.label, rec.fk1Label);
    const edges = await edgeKeys(attemptNode);
    assert.ok(edges.includes(`fork|${attemptNode}|${f.node}`), edges.join(","));
    for (const e of edgesBefore) assert.ok(edges.includes(e), `original edge preserved: ${e}`);
    const original = (await plane.node(attemptNode)).body.node;
    assert.equal(original.state, "running", "the original attempt keeps its state");
    // Herdr's target now lists the approach as a promotable node and the original as forked once
    const t = await target(attemptNode, "bob");
    assert.equal(t.body.fork.existing_forks, 1);
    // the Pi registry knows it; the review of C1 still stands on C1, it was not transferred to the fork
    const reviewed = (await plane.hood(attemptNode)).body.edges.find(
      (e: { edge_type: string }) => e.edge_type === "reviewed",
    );
    assert.equal(reviewed.attrs.commit, sha.C1);
    assert.equal(reviewed.stale ?? false, false);
  });

  it("GAP: the changed requirement can only travel as the fork's 80-character label", async () => {
    // Herdr refuses `instruction` on a fork (it is for redirect only) and a `reason` is stored but never delivered, and
    // Pi's ForkManager.create reads only base_sha and label. So the new requirement reaches the worktree's agent as
    // a label and nothing more; the rest has to be restated to that agent.
    const withInstruction = await propose("bob", "fork", attemptNode, {
      base_sha: sha.C1,
      label: "second approach",
      instruction: "Use a bounded queue instead of recursion; cap retries at 3.",
    });
    assert.equal(withInstruction.status, 400);
    assert.match(JSON.stringify(withInstruction.body), /instruction is only for redirect/);
    const requirement = "Use a bounded queue instead of recursion; cap retries at 3.";
    const p = await propose("bob", "fork", attemptNode, {
      base_sha: sha.C1,
      label: "bounded queue, retries capped at 3",
      reason: requirement,
    });
    assert.ok([200, 201].includes(p.status), JSON.stringify(p.body));
    assert.equal((await confirm("alice", p.body.steering, attemptNode)).status, 200);
    const offered = await plane.call("GET", "/api/v1/steering/pending?instance_id=inst-a", { key: "pi" });
    const item = offered.body.steering.find(
      (i: { steering_id: string }) => i.steering_id === p.body.steering.steering_id,
    );
    assert.ok(item, "offered to the reporting key and instance");
    assert.ok(!JSON.stringify(item).includes("bounded queue instead"), "the reason text is not part of the delivery");
    const id = forkIdFor(p.body.steering.steering_id);
    forks.fk2 = {
      steeringId: p.body.steering.steering_id,
      id,
      node: `approach:${id}`,
      branch: `pi-fork/${id}`,
      worktree: "",
    };
    await applyFork("fk2");
    const f2 = forks.fk2 as (typeof forks)[string];
    const node = (await plane.node(f2.node)).body.node;
    assert.equal(node.label, "bounded queue, retries capped at 3");
    assert.ok(!JSON.stringify(node.attrs).includes("instead of recursion"));
    assert.equal(git(f2.worktree, "rev-parse", "HEAD"), sha.C1);
  });

  it("two alternatives are worked, reported and compared; only trusted head-bound evidence counts", async () => {
    const f1 = forks.fk1 as (typeof forks)[string];
    const f2 = forks.fk2 as (typeof forks)[string];
    const h1 = work("fk1", "src/queue.txt", "bounded queue, 3 tries\n");
    const h2 = work("fk2", "src/recursion.txt", "recursive retry\n");
    await eventually(
      async () => (await reportedHead(f1.node)) === h1 && (await reportedHead(f2.node)) === h2,
      "heads reported",
      30_000,
    );
    // evidence: the trusted CI key validates fk1 at its head; fk2 only has a pass bound to an older head
    await rawNode("ci", "ci:run-fk1", "done", {});
    await rawEdge("ci", "validated", "ci:run-fk1", f1.node, { commit: h1 });
    await rawNode("ci", "ci:run-fk2-old", "done", {});
    await rawEdge("ci", "validated", "ci:run-fk2-old", f2.node, { commit: sha.C1 });
    // a non-operator key cannot attach evidence to a node it does not own
    await rawNode("ci", "ci:forged", "done", {});
    const forged = await plane.call("POST", "/api/v1/ingest", {
      key: "other",
      body: {
        schema_version: 2,
        event_id: "s5-other-forged",
        source: "s5-other",
        source_sequence: 1,
        occurred_at: new Date().toISOString(),
        entity_type: "lineage",
        entity_id: "ci:forged",
        event_type: "edge.add",
        payload: { edge_type: "validated", from_id: "ci:forged", to_id: f2.node, attrs: { commit: h2 } },
        visibility_scope: "room",
        room_id: roomId,
        evidence_refs: [],
      },
    });
    assert.equal(forged.status, 403);

    const cmp = await comparison("carol");
    assert.equal(cmp.status, 200, JSON.stringify(cmp.body));
    const cards = Object.fromEntries(
      (cmp.body.forks as Array<{ approach_id: string }>).map((c) => [c.approach_id, c]),
    ) as Record<string, any>;
    assert.deepEqual(Object.keys(cards).sort(), [f1.node, f2.node].sort());
    assert.equal(cards[f1.node].head_sha, h1);
    assert.equal(cards[f1.node].base_sha, sha.C1);
    assert.deepEqual(cards[f1.node].impact.touched_paths, ["src/queue.txt"]);
    assert.deepEqual(cards[f2.node].impact.touched_paths, ["src/recursion.txt"]);
    assert.equal(cards[f1.node].evidence.counted_validations, 1);
    assert.equal(cards[f2.node].evidence.counted_validations, 0);
    assert.equal(cards[f1.node].readiness.ready, true);
    assert.equal(cards[f2.node].readiness.ready, false);
    assert.equal(cards[f1.node].provenance.verified, false, "self-reported diff data is labelled as such");
    // the comparison is a room read: an outsider is refused, a guest too
    assert.ok([403, 404].includes((await comparison("mallory")).status));
    rec.h1 = h1;
    rec.h2 = h2;
  });

  it("only the affected gate is reported stale; Herdr reports and Pi supersedes, neither invalidates a gate", async () => {
    // task A depends on the forked attempt (its PR is linked from the attempt) and has a gate validated at C1;
    // task B is independent and has its own gate at C1.
    await rawNode("ci", "pr:github.com/acme/widgets#11", "open", { head_sha: sha.C1 });
    await rawEdge("ci", "issue_link", attemptNode, "pr:github.com/acme/widgets#11");
    await rawNode("ci", "gate:A", "done", {});
    await rawEdge("ci", "validated", "gate:A", "pr:github.com/acme/widgets#11", { commit: sha.C1 });
    await rawNode("ci", "pr:github.com/acme/widgets#12", "open", { head_sha: sha.C1 });
    await rawNode("ci", "gate:B", "done", {});
    await rawEdge("ci", "validated", "gate:B", "pr:github.com/acme/widgets#12", { commit: sha.C1 });
    const cmp = (await comparison("bob")).body;
    const down = cmp.downstream;
    const ids = down.nodes.map((n: { id: string }) => n.id).sort();
    assert.deepEqual(ids, ["gate:A", "pr:github.com/acme/widgets#11"]);
    const f1 = forks.fk1 as (typeof forks)[string];
    const perFork = Object.fromEntries(down.per_fork.map((p: { approach_id: string }) => [p.approach_id, p]));
    const left = (perFork[f1.node]?.evidence_left_on_other_head ?? []) as Array<{ commit: string }>;
    assert.equal(left.length, 1);
    assert.equal(left[0]?.commit, sha.C1);
    assert.ok(!JSON.stringify(down).includes("#12"), "the independent task is not reported");
    rec.gateEdgesBefore = JSON.stringify(await edgeKeys("pr:github.com/acme/widgets#11"));
    rec.gateBEdgesBefore = JSON.stringify(await edgeKeys("pr:github.com/acme/widgets#12"));
  });

  it("a stale promotion is refused: evidence follows the head, and a confirmed promotion is fenced when the head moves", async () => {
    const steeringId = await requestFork("fk3", "third approach");
    await applyFork("fk3");
    const f3 = forks.fk3 as (typeof forks)[string];
    const h3 = work("fk3", "src/third.txt", "third\n");
    await eventually(async () => (await reportedHead(f3.node)) === h3, "fk3 head reported", 30_000);
    // POSITIVE: no validation yet -> not ready (refusal says why), then validated -> accepted
    const early = await propose("bob", "promote", f3.node, { expected_head: h3 });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, "not_ready");
    await rawNode("ci", "ci:run-fk3", "done", {});
    await rawEdge("ci", "validated", "ci:run-fk3", f3.node, { commit: h3 });
    const p = await propose("bob", "promote", f3.node, { expected_head: h3 });
    assert.ok([200, 201].includes(p.status), JSON.stringify(p.body));
    assert.equal((await confirm("alice", p.body.steering, f3.node)).status, 200);
    // the agent keeps working after the confirmation: the confirmed head is no longer the fork's head
    const h3b = work("fk3", "src/third.txt", "third, changed after the confirmation\n");
    await eventually(async () => (await reportedHead(f3.node)) === h3b, "fk3 moved head reported", 30_000);
    const r = await receiver.pollOnce();
    assert.equal(r.received, 0, "the stale confirmation is not delivered");
    assert.equal((await statusOf(p.body.steering.steering_id))?.status, "fenced");
    assert.equal(tryBare(bare, "rev-parse", "--verify", `refs/heads/${f3.branch}`), null, "nothing was pushed");
    const again = await propose("bob", "promote", f3.node, { expected_head: h3b });
    assert.equal(again.body.code, "not_ready", "the validation was for the old head");
    assert.ok(steeringId);
  });

  it("promote by compare-and-set: one winner, a real push, a draft PR; the loser's request is refused", async () => {
    const f1 = forks.fk1 as (typeof forks)[string];
    const f2 = forks.fk2 as (typeof forks)[string];
    await rawNode("ci", "ci:run-fk2", "done", {});
    await rawEdge("ci", "validated", "ci:run-fk2", f2.node, { commit: rec.h2 as string });
    const sa = await propose("bob", "promote", f1.node, { expected_head: rec.h1 });
    const sb = await propose("bob", "promote", f2.node, { expected_head: rec.h2 });
    assert.ok([200, 201].includes(sa.status) && [200, 201].includes(sb.status), "both can be proposed");
    assert.equal((await confirm("alice", sa.body.steering, f1.node)).status, 200);
    const late = await confirm("alice", sb.body.steering, f2.node);
    assert.equal(late.status, 409);
    assert.equal(late.body.code, "promotion_in_flight", JSON.stringify(late.body));
    const third = await propose("bob", "promote", f2.node, { expected_head: rec.h2 });
    assert.equal(third.body.code, "promotion_in_flight");

    const r = await receiver.pollOnce();
    assert.deepEqual([r.received, r.acked], [1, 1], JSON.stringify(r));
    const done = await statusOf(sa.body.steering.steering_id);
    assert.equal(done?.ack?.outcome, "applied", JSON.stringify(done));
    // a REAL push to the REAL bare remote, at exactly the confirmed commit; main never moved; nothing merged
    assert.equal(bareGit(bare, "rev-parse", `refs/heads/${f1.branch}`), rec.h1);
    assert.equal(bareGit(bare, "rev-parse", "refs/heads/main"), mainAtStart);
    assert.equal(tryBare(bare, "rev-parse", "--verify", `refs/heads/${f2.branch}`), null, "the loser was not pushed");
    // the fake gh saw a list, a create (draft) and reads - no merge, no force
    const calls = readFileSync(join(ghDir, "gh.calls.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    const creates = calls.filter((c) => c.includes("POST"));
    assert.equal(creates.length, 1);
    assert.ok(creates[0]?.includes("draft=true"));
    assert.ok(
      !calls.some((c) => c.some((a) => /\/merge$/.test(a)) || c.includes("PUT") || c.includes("DELETE")),
      "no merge, no delete",
    );
    const prs = JSON.parse(readFileSync(join(ghDir, "gh.state.json"), "utf8")).prs as Record<string, { head: string }>;
    assert.deepEqual(
      Object.values(prs).map((p) => p.head),
      [f1.branch],
    );
    await host.drain();
    await eventually(async () => (await plane.node(f1.node)).body.node?.state === "selected", "winner selected");
    rec.pr = Object.keys(prs)[0] as string;
  });

  it("the losers are superseded, not deleted; a second or rival promotion is refused", async () => {
    const f1 = forks.fk1 as (typeof forks)[string];
    const f2 = forks.fk2 as (typeof forks)[string];
    const f3 = forks.fk3 as (typeof forks)[string];
    await eventually(async () => (await plane.node(f2.node)).body.node?.state === "superseded", "fk2 superseded");
    const edges = await edgeKeys(f1.node);
    assert.ok(edges.includes(`supersession|${f1.node}|${f2.node}`), edges.join(","));
    assert.ok(edges.includes(`supersession|${f1.node}|${f3.node}`));
    for (const f of [f2, f3]) {
      assert.ok(existsSync(f.worktree), `${f.id} worktree kept`);
      assert.ok(git(repo, "rev-parse", "--verify", `refs/heads/${f.branch}`), `${f.id} branch kept`);
    }
    assert.equal(git(repo, "rev-parse", "main"), mainAtStart);
    // the winner cannot be promoted twice and the loser cannot be promoted now
    const twice = await propose("bob", "promote", f1.node, { expected_head: rec.h1 });
    assert.ok(twice.status >= 400, JSON.stringify(twice.body));
    const rival = await propose("bob", "promote", f2.node, { expected_head: rec.h2 });
    assert.ok(rival.status >= 400, JSON.stringify(rival.body));
    assert.deepEqual(
      await steeringList().then((l) => l.filter((s) => s.action === "promote" && s.status === "pending")),
      [],
    );
    assert.equal((await receiver.pollOnce()).received, 0);
    assert.equal(
      Object.keys(JSON.parse(readFileSync(join(ghDir, "gh.state.json"), "utf8")).prs).length,
      1,
      "still one PR",
    );
    // the original evidence is preserved
    const edgesAfter = await edgeKeys(attemptNode);
    for (const e of edgesBefore) assert.ok(edgesAfter.includes(e), `original edge preserved: ${e}`);
  });

  it("GAP: promoting a fork invalidates no gate or review; the dependent gate stays validated at the old commit", async () => {
    // Herdr's downstream check only REPORTS evidence left on another head; Pi only emits supersession edges. Nothing
    // marks gate:A (task A, downstream of the forked attempt) stale, and nothing touches gate:B (independent task B).
    const gateA = (await plane.hood("gate:A")).body.edges as Array<{
      edge_type: string;
      stale?: boolean;
      removed?: boolean;
    }>;
    const validatedA = gateA.find((e) => e.edge_type === "validated");
    assert.ok(validatedA && !validatedA.removed);
    assert.ok(!validatedA.stale, "gate A is NOT marked stale");
    const gateB = (await plane.hood("gate:B")).body.edges as Array<{
      edge_type: string;
      stale?: boolean;
      removed?: boolean;
    }>;
    const validatedB = gateB.find((e) => e.edge_type === "validated");
    assert.ok(validatedB && !validatedB.removed && !validatedB.stale);
    assert.equal(JSON.stringify(await edgeKeys("pr:github.com/acme/widgets#11")), rec.gateEdgesBefore);
    assert.equal(JSON.stringify(await edgeKeys("pr:github.com/acme/widgets#12")), rec.gateBEdgesBefore);
  });

  it("GAP: AutoSpec's review publisher writes org-scoped nodes that room members cannot comment on", async () => {
    // `autospec review-quorum publish` stamps visibility_scope "org". A node nobody in the room can read is not a
    // comment anchor, so a human cannot comment on an AutoSpec-published review from the room; it can only be done
    // for reviews the room can see (as above). Asserted here as the plane's current behaviour for an org-scoped node.
    const r = await plane.call("POST", "/api/v1/ingest", {
      key: "rev",
      body: {
        schema_version: 2,
        event_id: "s5-org-review",
        source: "s5-org",
        source_sequence: 1,
        occurred_at: new Date().toISOString(),
        entity_type: "lineage",
        entity_id: "review:org-published",
        event_type: "node.upsert",
        payload: { node_type: "review", node_id: "review:org-published", state: "failed" },
        visibility_scope: "org",
        evidence_refs: [],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = await plane.c("POST", `/rooms/${roomId}/comments`, {
      user: "bob",
      body: { anchor: { kind: "node", node_id: "review:org-published" }, text: "x", idempotency_key: "org-1" },
    });
    assert.ok([400, 404].includes(c.status), `${c.status}`);
    const missing = await plane.c("POST", `/rooms/${roomId}/comments`, {
      user: "bob",
      body: { anchor: { kind: "node", node_id: "review:does-not-exist" }, text: "x", idempotency_key: "org-2" },
    });
    assert.equal(missing.status, c.status, "the refusal does not reveal that the org node exists");
    assert.deepEqual(missing.body, c.body);
  });
});
