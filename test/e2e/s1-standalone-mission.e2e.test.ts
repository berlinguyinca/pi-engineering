import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CheckpointManager } from "../../src/orchestration/checkpoints.ts";
import { buildCandidateEvidenceIdentity, hashCandidateEvidenceIdentity } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { WorkspaceManifest } from "../../src/orchestration/types.ts";
import { WorkGraph } from "../../src/platform/WorkGraph.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { loadLineageEmitter } from "../../src/runtime/herdr/lineageConfig.ts";
import { type FakePlannotator, makeFakePlannotator } from "./support/fakePlannotator.ts";
import { Plane, eventually } from "./support/plane.ts";
/**
 * ACCEPTANCE SCENARIO 1 - standalone Pi mission, AutoSpec disabled.
 * "risk-based plan, skipped or approved Plannotator, worker spawn, review, evidence and Herdr graph."
 *
 * Real pieces: the `scripts/pi-engineering.ts plan` CLI as a child process (clean environment, network/subprocess guard
 * preloaded), Pi's real HerdrPlannotatorTransport driving a FAKE bridge script, the real MissionStore/CheckpointManager/
 * WorkGraph lineage hooks, the real YAML-configured emitter (loadLineageEmitter) and a REAL Herdr control-plane process.
 * Nothing here calls AutoSpec, GitHub or a model.
 */
import { scratch } from "./support/scratch.ts";

const PI = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GUARD = join(PI, "test/e2e/support/guardPreload.ts");

interface PlanRun {
  code: number;
  json: any;
  stderr: string;
  guardAttempts: string[];
}

/** Run the REAL plan CLI in a clean child: no PI_AUTOSPEC_*, GITHUB, HERDR or InferWeave variables. */
function runPlan(
  args: string[],
  body: unknown,
  o: { agentDir: string; cwd: string; allowSpawnUnder?: string; guard?: boolean },
): Promise<PlanRun> {
  return new Promise((res, rej) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: o.cwd,
      PI_CODING_AGENT_DIR: o.agentDir, // Pi's own mechanism to point at a global engineering.yaml (test isolation)
      PI_ENGINEERING_STATE_DIR: join(o.cwd, "state"),
      PI_ENGINEERING_HOME: join(o.cwd, "home"),
      ...(o.allowSpawnUnder ? { TEST_ALLOW_SPAWN_UNDER: o.allowSpawnUnder } : {}),
    };
    // `guard: false` is for the runs that are CONFIGURED to talk to the real plane (a `herdr:` block): the guard would
    // block exactly the loopback traffic under test. Every run without a `herdr:` block keeps the guard.
    const preload = o.guard === false ? [] : ["--import", GUARD];
    const child = spawn(process.execPath, [...preload, join(PI, "scripts/pi-engineering.ts"), "plan", ...args], {
      cwd: o.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", rej);
    child.on("close", (code) => {
      const m = err.match(/__GUARD__(\[.*\])/);
      let json: any = null;
      try {
        json = out.trim() ? JSON.parse(out.trim().split("\n").pop() as string) : null;
      } catch {
        /* leave null */
      }
      res({
        code: code ?? -1,
        json,
        stderr: err.replace(/\n?__GUARD__.*\n?/, ""),
        guardAttempts: m ? JSON.parse(m[1] as string) : ["GUARD LINE MISSING"],
      });
    });
    child.stdin.end(JSON.stringify(body));
  });
}

const LOW = { goal: "tidy the docs", tasks: [{ objective: "tidy the docs", write_domains: ["docs/x.md"] }] };
const MEDIUM = {
  goal: "add an endpoint",
  tasks: [
    { objective: "add endpoint", write_domains: ["src/api/**"] },
    { objective: "add tests", write_domains: ["test/**"] },
  ],
};
const HIGH = {
  goal: "change login token handling",
  tasks: [{ objective: "change login token handling", write_domains: ["src/auth/**"] }],
};

function workdir(label: string): { cwd: string; agentDir: string; store: string } {
  const cwd = scratch(`t16-s1-${label}-`);
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  return { cwd, agentDir, store: join(cwd, "store") };
}

describe("scenario 1 / plan gate (real CLI, no Herdr, no AutoSpec, no network)", () => {
  let fake: FakePlannotator;
  before(() => {
    fake = makeFakePlannotator();
  });

  it("low risk: review policy SKIP, may proceed, and the child made no network or subprocess attempt", async () => {
    const w = workdir("low");
    const r = await runPlan(["--store", w.store], LOW, w);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.result, "may_proceed");
    assert.equal(r.json.riskClass, "low");
    assert.equal(r.json.mode, "skip");
    assert.equal(r.json.outcome, "skipped");
    assert.match(r.json.planDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(r.guardAttempts, [], "standalone planning must not touch the network or spawn anything");
  });

  it("the guard really bites inside the child (positive control: a Plannotator-less require plan that DOES spawn is recorded)", async () => {
    const w = workdir("guard");
    const r = await runPlan(["--store", w.store, "--plannotator-command", fake.command], HIGH, w); // no allowSpawnUnder
    assert.notDeepEqual(r.guardAttempts, [], "spawning outside the allowed dir must be recorded");
    assert.ok(
      r.guardAttempts.some((a) => a.startsWith("child_process.spawn(")),
      r.guardAttempts.join(","),
    );
    assert.equal(r.code, 1, "an unreachable reviewer fails closed");
  });

  it("medium risk: OFFER. Without a reviewer the offer is recorded as skipped; with one it is approved on the exact digest", async () => {
    const w = workdir("medium");
    const skipped = await runPlan(["--store", w.store], MEDIUM, w);
    assert.equal(skipped.code, 0, skipped.stderr);
    assert.equal(skipped.json.riskClass, "medium");
    assert.equal(skipped.json.mode, "offer");
    assert.equal(skipped.json.outcome, "skipped");
    assert.deepEqual(skipped.guardAttempts, []);

    const w2 = workdir("medium-approved");
    fake.setMode("approve");
    const before = fake.calls().length;
    const ok = await runPlan(["--store", w2.store, "--plannotator-command", fake.command], MEDIUM, {
      ...w2,
      allowSpawnUnder: fake.dir,
    });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.json.mode, "offer");
    assert.equal(ok.json.outcome, "approved");
    assert.equal(fake.calls().length, before + 1);
    assert.equal(fake.calls().at(-1), ok.json.planDigest, "the bridge reviewed exactly the plan digest Pi holds");
    assert.deepEqual(ok.guardAttempts, [], "only the allow-listed fake bridge was spawned");
  });

  it("high risk: REQUIRE. No Plannotator blocks (exit 1, fail closed); an approver on the exact digest lets it proceed", async () => {
    const w = workdir("high");
    const blocked = await runPlan(["--store", w.store], HIGH, w);
    assert.equal(blocked.code, 1);
    assert.equal(blocked.json.result, "blocked");
    assert.equal(blocked.json.code, "plannotator_unavailable");
    assert.equal(blocked.json.mode, "require");

    fake.setMode("approve");
    const ok = await runPlan(["--store", w.store, "--plannotator-command", fake.command], HIGH, {
      ...w,
      allowSpawnUnder: fake.dir,
    });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.json.result, "may_proceed");
    assert.equal(ok.json.outcome, "approved");
    assert.equal(
      ok.json.planDigest,
      blocked.json.planDigest,
      "same plan, same digest across the block and the approval",
    );
    assert.equal(fake.calls().at(-1), ok.json.planDigest);
  });

  it("require fails closed on: approval that echoes a DIFFERENT digest, a dismissed review, a crashing bridge, garbage output", async () => {
    for (const mode of ["approve-wrong-digest", "dismiss", "crash", "garbage"]) {
      const w = workdir(`fail-${mode}`);
      fake.setMode(mode);
      const r = await runPlan(["--store", w.store, "--plannotator-command", fake.command], HIGH, {
        ...w,
        allowSpawnUnder: fake.dir,
      });
      assert.equal(r.code, 1, `${mode}: ${r.stderr}`);
      assert.equal(r.json.result, "blocked", mode);
      assert.notEqual(r.json.outcome, "approved", mode);
    }
  });

  it("changes requested: the CLI has no replanner, so the plan is blocked with the reviewer's request recorded (no silent proceed)", async () => {
    const w = workdir("annotate");
    fake.setMode("annotate");
    const r = await runPlan(["--store", w.store, "--plannotator-command", fake.command], HIGH, {
      ...w,
      allowSpawnUnder: fake.dir,
    });
    assert.equal(r.code, 1);
    assert.equal(r.json.result, "blocked");
    assert.match(String(r.json.code), /changes|replan/i, JSON.stringify(r.json));
    assert.equal(r.json.code, "changes_requested");
    // resubmitting the SAME plan stays blocked: the reviewer's request is not forgotten, a new approval is not implied
    fake.setMode("approve");
    const same = await runPlan(["--store", w.store, "--plannotator-command", fake.command], HIGH, {
      ...w,
      allowSpawnUnder: fake.dir,
    });
    assert.equal(same.code, 1);
    assert.equal(same.json.code, "changes_requested");
    // the REVISED plan (idempotency key kept via the same goal) is a new revision with its own digest and its own review
    const revised = {
      goal: HIGH.goal,
      tasks: [{ objective: "split the auth change", write_domains: ["src/auth/token.ts"] }],
    };
    const again = await runPlan(["--store", w.store, "--plannotator-command", fake.command], revised, {
      ...w,
      allowSpawnUnder: fake.dir,
    });
    assert.equal(again.code, 2, "the same goal with a changed plan needs a new idempotency key");
    const next = await runPlan(
      ["--store", w.store, "--plannotator-command", fake.command],
      { ...revised, idempotencyKey: "revision-2" },
      { ...w, allowSpawnUnder: fake.dir },
    );
    assert.equal(next.code, 0, `${next.stderr} ${JSON.stringify(next.json)}`);
    assert.equal(next.json.outcome, "approved");
    assert.notEqual(
      next.json.planDigest,
      r.json.planDigest,
      "a different plan has a different digest; approval is not carried over",
    );
    assert.equal(fake.calls().at(-1), next.json.planDigest);
  });

  it("an explicit, reasoned override proceeds and is recorded; an override without a reason is refused (exit 2)", async () => {
    const w = workdir("override");
    const noReason = await runPlan(["--store", w.store, "--review", "skip"], HIGH, w);
    assert.equal(noReason.code, 2);
    const ok = await runPlan(
      ["--store", w.store, "--review", "skip", "--reason", "offline hotfix", "--operator", "alice"],
      HIGH,
      w,
    );
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.json.mode, "skip");
    const backend = await JsonlEventStore.open(join(w.store, "orchestration.jsonl"));
    const store = MissionStore.open(backend);
    const policies = store.listPlanPolicies(ok.json.missionId);
    assert.equal(policies.at(-1)?.source, "override");
    assert.equal(policies.at(-1)?.overrideReason, "offline hotfix");
    assert.equal(store.listPlanDecisions(ok.json.missionId).at(-1)?.planDigest, ok.json.planDigest);
    backend.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────── worker spawn + Herdr graph

function writeAgentDir(agentDir: string, o: { url: string; key: string; roomId: string; instance: string }): void {
  mkdirSync(agentDir, { recursive: true });
  const keyFile = join(agentDir, "ingest.key");
  writeFileSync(keyFile, `${o.key}\n`);
  chmodSync(keyFile, 0o600);
  writeFileSync(
    join(agentDir, "engineering.yaml"),
    `${["herdr:", `  url: ${o.url}`, `  api_key_file: ${keyFile}`, `  instance_id: ${o.instance}`, "  lineage: true", "  visibility: room", `  room_id: ${o.roomId}`].join("\n")}\n`,
  );
}

function manifest(missionId: string): WorkspaceManifest {
  return {
    manifestId: "WM-s1",
    missionId,
    generation: 1,
    authorizedRoots: [{ canonicalPath: "/repo", source: "existing_manifest", access: "write" }],
    repositories: [
      { repoId: "repo-1", canonicalRoot: "/repo", baseRef: "main", baseSha: "base-a", writableDomains: ["**"] },
    ],
    dependencyEdges: [],
    hash: "manifest-s1",
    createdAt: new Date().toISOString(),
  };
}

const SHA = "c".repeat(40);

describe("scenario 1 / worker spawn, review evidence and the Herdr graph (real plane)", () => {
  let plane: Plane;
  let roomId: string;
  let mission = "";
  let ws: ReturnType<typeof workdir>;
  let store: MissionStore;
  let backend: JsonlEventStore;
  let envDir: string;
  const taskIds = { lead: "TSK-s1-lead", impl: "TSK-s1-impl", review: "TSK-s1-review" };

  before(async () => {
    plane = await Plane.start({
      keys: { pi: "ingest" },
      users: ["alice", "bob"],
      scopes: { pi: { rooms: ["*"], missions: ["*"] } },
    });
    await plane.verifyFeatures("alice");
    roomId = (await plane.makeRoom("alice", "s1", "s1-room")).roomId;
    ws = workdir("graph");
    writeAgentDir(ws.agentDir, { url: plane.url, key: plane.keys.pi as string, roomId, instance: "pi-s1" });
    const r = await runPlan(["--store", ws.store], LOW, { ...ws, guard: false });
    assert.equal(r.code, 0, r.stderr);
    mission = r.json.missionId;
    planRun = r;
    envDir = join(ws.cwd, "envelopes");
    backend = await JsonlEventStore.open(join(ws.store, "orchestration.jsonl"));
    store = MissionStore.open(backend);
    const emitter = await loadLineageEmitter({ agentDir: ws.agentDir, envelopeDir: envDir });
    assert.ok(emitter, "the YAML herdr: block must yield a lineage emitter");
    store.setLineage(emitter);
    emitterRef = emitter;
    store.bindWorkspaceManifest(manifest(mission));
  });
  after(async () => {
    backend?.close();
    await plane?.stop();
  });
  let planRun: PlanRun;
  let emitterRef: NonNullable<Awaited<ReturnType<typeof loadLineageEmitter>>>;

  const task = (id: string, kind: "agent" | "review", role: string, extra: object = {}) =>
    store.createTask({
      task_id: id,
      mission_id: mission,
      kind,
      role,
      objective: `${role} work`,
      repo_id: "repo-1",
      acceptance_ids: kind === "review" ? ["AC-1"] : [],
      deliverables: ["implementation"],
      execution_budget_ms: 60_000,
      checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
      candidate_generation: 0,
      mission_generation: 0,
      fencing_token: 0,
      ...extra,
    } as never);

  const read = (id: string, user: string) => plane.c("GET", `/graph/nodes/${encodeURIComponent(id)}`, { user });

  it("spawns an implementer through the real createExecution path; the room member sees it, an outsider and a wrong id see the same 404", async () => {
    task(taskIds.lead, "agent", "lead");
    const ex = store.createExecution({
      task_id: taskIds.lead,
      mission_id: mission,
      backend: "agent",
      checkpoint_id: "TCP-s1",
      repo_id: "repo-1",
      base_sha: "base-a",
    });
    store.setExecutionStatus(ex.execution_id, "RUNNING", { session_id: "S1" });
    await store.flush();
    await emitterRef.idle();
    const seen = await eventually(async () => {
      const r = await read(`agent:${taskIds.lead}`, "alice");
      return r.status === 200 ? r : false;
    }, "the spawned agent to reach the room graph");
    assert.equal(seen.body.node.node_id ?? seen.body.node.id, `agent:${taskIds.lead}`);
    assert.equal(seen.body.node.state, "running");
    // paired negatives: bob is signed in but in no room; a node that does not exist answers identically
    const outsider = await read(`agent:${taskIds.lead}`, "bob");
    const missing = await read("agent:does-not-exist", "bob");
    assert.equal(outsider.status, 404);
    assert.deepEqual(outsider.body, missing.body);
    const attempt = await read(`attempt:${ex.execution_id}`, "alice");
    assert.equal(attempt.status, 200);
  });

  it("a checkpoint is evidence: an artifact PRODUCED by the attempt, bound to the exact commit; a new session rolls over without changing agent/attempt ids", async () => {
    task(taskIds.impl, "agent", "implementer");
    const ex = store.createExecution({
      task_id: taskIds.impl,
      mission_id: mission,
      backend: "agent",
      checkpoint_id: "TCP-impl",
      repo_id: "repo-1",
      base_sha: "base-a",
    });
    store.setExecutionStatus(ex.execution_id, "RUNNING", { session_id: "S-a" });
    await new CheckpointManager({
      store,
      snapshot: async () => ({
        candidateSha: SHA,
        branch: "b",
        worktree: "/wt",
        committedChanges: ["src/a.ts"],
        preservedUncommittedChanges: [],
      }),
    }).persist({ taskId: taskIds.impl, executionId: ex.execution_id, sessionId: "S-b" });
    await store.flush();
    await emitterRef.idle();
    await eventually(async () => (await read("artifact:TCP-impl", "alice")).status === 200, "checkpoint artifact");
    const hood = await plane.c(
      "GET",
      `/graph/nodes/${encodeURIComponent(`attempt:${ex.execution_id}`)}/neighborhood?depth=1`,
      { user: "alice" },
    );
    const edges = (hood.body.edges ?? []).map((e: any) => [e.edge_type, e.from_id, e.to_id, e.attrs?.commit]);
    assert.deepEqual(
      edges.filter((e: any[]) => e[0] === "produced"),
      [["produced", `attempt:${ex.execution_id}`, "artifact:TCP-impl", SHA]],
    );
    // rollover: S-a rolled_over, S-b running, agent id unchanged
    await eventually(
      async () => (await read("session:S-a", "alice")).body?.node?.state === "rolled_over",
      "old session rolled over",
    );
    assert.equal((await read("session:S-b", "alice")).body.node.state, "running");
    assert.equal((await read(`agent:${taskIds.impl}`, "alice")).status, 200);
  });

  it("spawn edges come only from REAL parent data: a WorkGraph parent->child worker has one, MissionStore executions (no recorded parent) have none", async () => {
    const graph = WorkGraph.create(JsonlEventStore.inMemory());
    graph.setLineage(emitterRef);
    const lead = graph.createWorker({ projectId: "P-s1", role: "lead" });
    const child = graph.createWorker({ projectId: "P-s1", role: "helper", parentWorkerId: lead.id });
    await graph.flush();
    await emitterRef.idle();
    await eventually(async () => (await read(`agent:${child.id}`, "alice")).status === 200, "child worker node");
    const hood = await plane.c("GET", `/graph/nodes/${encodeURIComponent(`agent:${lead.id}`)}/neighborhood?depth=1`, {
      user: "alice",
    });
    assert.ok(
      (hood.body.edges ?? []).some(
        (e: any) => e.edge_type === "spawn" && e.from_id === `agent:${lead.id}` && e.to_id === `agent:${child.id}`,
      ),
    );
    // the mission-store agents were not given a parent, so Herdr must not show one
    const mhood = await plane.c(
      "GET",
      `/graph/nodes/${encodeURIComponent(`agent:${taskIds.impl}`)}/neighborhood?depth=2`,
      { user: "alice" },
    );
    assert.deepEqual(
      (mhood.body.edges ?? []).filter((e: any) => e.edge_type === "spawn"),
      [],
      "no spawn edge may be guessed",
    );
  });

  it("review evidence exists in the Pi mission store (independent reviewer, candidate-bound); the reviewer WORKER reaches the graph", async () => {
    const identity = buildCandidateEvidenceIdentity({
      workspaceManifestHash: "manifest-s1",
      missionGeneration: 0,
      repoId: "repo-1",
      baseSha: "base-a",
      candidateSha: SHA,
      diffHash: "diff-a",
      acceptanceIds: ["AC-1"],
      artifactHashes: ["sha256:artifact-a"],
    });
    store.addAcceptanceCriterion(mission, "reviewed against the criterion", undefined, "AC-1");
    task(taskIds.review, "review", "independent-reviewer");
    store.transitionTask(taskIds.review, "READY");
    const ex = store.createExecution({
      task_id: taskIds.review,
      backend: "review",
      mission_id: mission,
      repo_id: "repo-1",
      base_sha: "base-a",
    });
    store.transitionTask(taskIds.review, "RUNNING", "system", { assigned_execution_id: ex.execution_id });
    store.setExecutionStatus(ex.execution_id, "RUNNING");
    store.setExecutionStatus(ex.execution_id, "SUCCEEDED");
    store.transitionTask(taskIds.review, "SUCCEEDED");
    store.recordCandidate(mission, identity, "integration", { taskId: taskIds.review, executionId: ex.execution_id });
    store.recordReviewEvidence({
      evidenceId: "RE-s1",
      missionId: mission,
      taskId: taskIds.review,
      executionId: ex.execution_id,
      identity,
      identityHash: hashCandidateEvidenceIdentity(identity),
      reviewerSessionId: "review-session-1",
      model: "model-a",
      provider: "provider-a",
      verdict: "approve",
      independenceMode: "independent",
      findings: [],
      outputValid: true,
      accessible: true,
      acceptanceResults: [{ acceptanceId: "AC-1", status: "passed", detail: "reviewed against criterion" }],
      recordedAt: new Date().toISOString(),
    } as never);
    // a review whose output was not valid gave no verdict: it must never be projected
    task("TSK-s1-review-bad", "review", "independent-reviewer");
    store.transitionTask("TSK-s1-review-bad", "READY");
    const exInvalid = store.createExecution({
      task_id: "TSK-s1-review-bad",
      backend: "review",
      mission_id: mission,
      repo_id: "repo-1",
      base_sha: "base-a",
    });
    store.transitionTask("TSK-s1-review-bad", "RUNNING", "system", { assigned_execution_id: exInvalid.execution_id });
    store.setExecutionStatus(exInvalid.execution_id, "RUNNING");
    store.setExecutionStatus(exInvalid.execution_id, "SUCCEEDED");
    store.transitionTask("TSK-s1-review-bad", "SUCCEEDED");
    store.recordCandidate(mission, identity, "integration", {
      taskId: "TSK-s1-review-bad",
      executionId: exInvalid.execution_id,
    });
    store.recordReviewEvidence({
      evidenceId: "RE-s1-invalid",
      missionId: mission,
      taskId: "TSK-s1-review-bad",
      executionId: exInvalid.execution_id,
      identity,
      identityHash: hashCandidateEvidenceIdentity(identity),
      reviewerSessionId: "review-session-2",
      model: "model-a",
      provider: "provider-a",
      verdict: "approve",
      independenceMode: "independent",
      findings: [],
      outputValid: false,
      accessible: true,
      acceptanceResults: [],
      recordedAt: new Date().toISOString(),
    } as never);
    await store.flush();
    await emitterRef.idle();
    const rec = store.listReviewEvidence(mission).filter((r) => r.evidenceId === "RE-s1");
    assert.equal(rec.length, 1);
    assert.equal(rec[0]?.verdict, "approve");
    assert.equal(rec[0]?.identity.candidateSha, SHA);
    await eventually(
      async () => (await read(`agent:${taskIds.review}`, "alice")).status === 200,
      "reviewer worker node",
    );
    assert.equal((await read(`agent:${taskIds.review}`, "alice")).body.node.state, "done");
  });

  it("the worker-review VERDICT reaches Herdr: a review node, a `reviewed` edge bound to the exact candidate commit, and a produced edge from the reviewing attempt", async () => {
    const rn = await eventually(async () => {
      const r = await read("review:RE-s1", "alice");
      return r.status === 200 ? r : false;
    }, "the review node");
    assert.equal(rn.body.node.attrs.verdict, "approve");
    assert.equal(rn.body.node.attrs.candidate_sha, SHA);
    const hood = await eventually(async () => {
      const h = await plane.c("GET", `/graph/nodes/${encodeURIComponent("review:RE-s1")}/neighborhood?depth=1`, {
        user: "alice",
      });
      const ed = (h.body.edges ?? []).filter((e: any) => e.edge_type === "reviewed");
      return ed.length ? h : false;
    }, "the reviewed edge");
    const reviewed = (hood.body.edges ?? []).filter((e: any) => e.edge_type === "reviewed");
    assert.deepEqual(
      reviewed.map((e: any) => [e.from_id, e.to_id]),
      [["review:RE-s1", `commit:${SHA}`]],
    );
    assert.equal(reviewed[0].attrs.commit, SHA, "the edge is bound to the candidate commit");
    const produced = (hood.body.edges ?? []).filter((e: any) => e.edge_type === "produced");
    assert.equal(produced.length, 1, "the reviewing attempt produced the review");
    // paired negative: a signed-in non-member sees nothing, and a request-changes style id that was never recorded is absent
    assert.equal((await read("review:RE-s1", "bob")).status, 404);
    assert.equal((await read("review:RE-never", "alice")).status, 404);
    assert.equal((await read("review:RE-s1-invalid", "alice")).status, 404, "an invalid review is not a verdict");
  });

  it("the plan revision, digest and Plannotator decision reach Herdr FROM THE CLI: mission and plan nodes bound to the digest, a produced edge, and an approval as a reviewed edge on the same digest", async () => {
    const hoodOf = (id: string) =>
      plane.c("GET", `/graph/nodes/${encodeURIComponent(id)}/neighborhood?depth=1`, { user: "alice" });
    // 1. the skipped-by-policy plan of the graph workdir (the CLI wrote it; no test code emitted anything)
    const planNode = `plan:${mission}/${planRun.json.revision}`;
    const n = await eventually(async () => {
      const r = await read(planNode, "alice");
      return r.status === 200 ? r : false;
    }, "the plan node written by the CLI");
    assert.equal(n.body.node.attrs.plan_digest, planRun.json.planDigest, "the node carries the CLI's digest");
    assert.equal(n.body.node.attrs.risk_class, planRun.json.riskClass);
    assert.equal(n.body.node.state, "proceeding", "skipped by policy: allowed to proceed, not 'approved'");
    const m = await read(`mission:${mission}`, "alice");
    assert.equal(m.status, 200, "the CLI defined the mission node the produced edge needs");
    assert.equal(m.body.node.label, "tidy the docs");
    const produced = ((await hoodOf(planNode)).body.edges ?? []).filter((e: any) => e.edge_type === "produced");
    assert.deepEqual(
      produced.map((e: any) => [e.from_id, e.to_id]),
      [[`mission:${mission}`, planNode]],
    );
    // paired negative: the same read by a signed-in non-member answers like an absent node
    assert.equal((await read(planNode, "bob")).status, 404);

    // 2. a Plannotator approval on the exact digest is a `reviewed` edge bound to that digest
    const fake2 = makeFakePlannotator();
    fake2.setMode("approve");
    const w = workdir("graph-approved");
    writeAgentDir(w.agentDir, { url: plane.url, key: plane.keys.pi as string, roomId, instance: "pi-s1-plan" });
    const ok = await runPlan(["--store", w.store, "--plannotator-command", fake2.command], MEDIUM, {
      ...w,
      allowSpawnUnder: fake2.dir,
      guard: false,
    });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.json.outcome, "approved");
    const approvedPlan = `plan:${ok.json.missionId}/${ok.json.revision}`;
    const edges = ((await hoodOf(approvedPlan)).body.edges ?? []).filter((e: any) => e.edge_type === "reviewed");
    assert.equal(edges.length, 1, JSON.stringify(edges));
    assert.equal(edges[0].attrs.plan_digest, ok.json.planDigest);
    assert.equal(edges[0].attrs.decision, "approved");
    assert.equal((await read(approvedPlan, "alice")).body.node.state, "approved");
    // the digest the bridge reviewed is the digest Herdr holds
    assert.equal(fake2.calls().at(-1), (await read(approvedPlan, "alice")).body.node.attrs.plan_digest);
  });

  it("the whole outbox drained: nothing pending, nothing rejected, nothing dead-lettered", async () => {
    const st = new EnvelopeStore({ dir: envDir });
    await eventually(async () => (await st.outbox.pending()).length === 0, "outbox drained");
    const sources = Object.values(await plane.sources());
    assert.ok(sources.length >= 1 && sources.every((s) => (s.gaps?.length ?? 0) === 0), JSON.stringify(sources));
  });
});

describe("scenario 1 / standalone survives the control plane being absent or down", () => {
  it("no herdr: block at all: the mission path runs and nothing is queued anywhere", async () => {
    const w = workdir("nohrd");
    const r = await runPlan(["--store", w.store], LOW, w);
    assert.equal(r.code, 0);
    assert.deepEqual(r.guardAttempts, []);
    assert.equal(
      await loadLineageEmitter({ agentDir: w.agentDir, envelopeDir: join(w.cwd, "env") }),
      null,
      "no block, no emitter",
    );
  });

  it("herdr: block pointing at a dead port: plan and worker spawn are unaffected, events queue durably (pending > 0)", async () => {
    const w = workdir("dead");
    writeAgentDir(w.agentDir, {
      url: "http://127.0.0.1:9",
      key: "dead-key-not-a-secret",
      roomId: "room-dead",
      instance: "pi-dead",
    });
    const r = await runPlan(["--store", w.store], LOW, w);
    assert.equal(r.code, 0, r.stderr);
    const be = await JsonlEventStore.open(join(w.store, "orchestration.jsonl"));
    const s = MissionStore.open(be);
    const env = join(w.cwd, "env");
    const em = await loadLineageEmitter({ agentDir: w.agentDir, envelopeDir: env });
    assert.ok(em);
    s.setLineage(em);
    s.bindWorkspaceManifest(manifest(r.json.missionId));
    s.createTask({
      task_id: "TSK-dead",
      mission_id: r.json.missionId,
      kind: "agent",
      role: "implementer",
      objective: "x",
      repo_id: "repo-1",
      acceptance_ids: [],
      deliverables: ["implementation"],
      execution_budget_ms: 60_000,
      checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
      candidate_generation: 0,
      mission_generation: 0,
      fencing_token: 0,
    } as never);
    const ex = s.createExecution({
      task_id: "TSK-dead",
      mission_id: r.json.missionId,
      backend: "agent",
      repo_id: "repo-1",
      base_sha: "base-a",
    });
    s.setExecutionStatus(ex.execution_id, "RUNNING", { session_id: "S-dead" });
    await s.flush();
    await em.idle();
    assert.equal(s.getExecution(ex.execution_id)?.status, "RUNNING", "mission state is authoritative and unaffected");
    const st = new EnvelopeStore({ dir: env });
    assert.ok((await st.outbox.pending()).length > 0, "undelivered lineage must be queued, not dropped");
    be.close();
  });
});
