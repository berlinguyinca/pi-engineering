/**
 * ACCEPTANCE SCENARIO 2 - AutoSpec mission.
 * "existing GitHub issue DAG, Pi adapter, multiple worktrees, PR, independent AI reviewer, defect repair, head change
 *  invalidates the old verdict, CI and guarded merge."
 *
 * Real pieces: `scripts/pi-engineering.ts plan --from-autospec` as a child process; real git repos (a bare remote, a
 * working clone and three real `git worktree`s created through Pi's GitRepo); Pi's GhCliClient + linkPullRequest +
 * emitLinkRecorded + the YAML-configured LineageEmitter; a REAL Herdr control-plane process with a YAML `review_quorum`;
 * the REAL `autospec review-quorum publish` binary acting as two independent reviewers; Pi's decideMerge.
 * Not real: GitHub. test/e2e/fake_gh_s2/gh ("FAKE - test shim") answers the few `gh api` calls Pi makes; the PR head it
 * reports is read from the REAL bare remote, so a real defect-repair commit really moves it.
 * Environment: PATH/HOME for child processes only, plus PI_CODING_AGENT_DIR (Pi's own agent-dir input, the one the unit
 * tests also pass) so the plan CLI reads our temp engineering.yaml. Nothing configures Herdr or Pi through the environment.
 *
 * Gaps are named `GAP: ...` and assert today's behaviour; none is filled by calling emitter primitives from the test.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { createGithubClient } from "../../src/github/client.ts";
import { emitLinkRecorded } from "../../src/github/lineage.ts";
import { linkPullRequest } from "../../src/github/prLinks.ts";
import { reconcileGithubLinks } from "../../src/github/reconcile.ts";
import { ingestAutoSpecDag } from "../../src/integrations/autospec/dagIngest.ts";
import { decideMerge } from "../../src/merge/mergeGate.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { WorkspaceManifest } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { loadLineageEmitter } from "../../src/runtime/herdr/lineageConfig.ts";
import { Plane, eventually, sha40 } from "./support/plane.ts";

const PI = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FAKE_GH = join(PI, "test/e2e/fake_gh_s2");
const REPO = "acme/widgets";
const PR_NODE = (n: number) => `pr:github.com/${REPO}#${n}`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();

function dagFixture(): { mission: Record<string, any>; tasks: Array<Record<string, any>> } {
  const d = JSON.parse(readFileSync(join(PI, "test/fixtures/autospec-dag/valid.json"), "utf8"));
  d.mission.state = "PLANNED";
  const [t1, t2] = d.tasks;
  t2.executor = "pi-local";
  t2.state = "READY";
  const t3 = structuredClone(t1);
  Object.assign(t3, { task_id: "t-3", sequence: 3, idempotency_key: "idem-task-3", depends_on: ["t-1"] });
  t3.affected_surfaces = [{ path: "docs/guide.md" }];
  t1.required_extensions = ["autospec.issue_refs"];
  t1.extensions = { "autospec.issue_refs": ["acme/widgets#12", "acme/other#3"] };
  t2.required_extensions = ["autospec.issue_refs"];
  t2.extensions = { "autospec.issue_refs": ["acme/widgets#13"] };
  d.tasks.push(t3);
  return d;
}

interface CliRun {
  code: number;
  json: any;
  stderr: string;
}
function runPlan(args: string[], cwd: string, agentDir: string): Promise<CliRun> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(PI, "scripts/pi-engineering.ts"), "plan", ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        PI_CODING_AGENT_DIR: agentDir, // Pi's own mechanism to find the global engineering.yaml
        PI_ENGINEERING_STATE_DIR: join(cwd, "state"),
        PI_ENGINEERING_HOME: join(cwd, "home"),
      },
      stdio: ["ignore", "pipe", "pipe"],
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
      let json: any = null;
      try {
        json = out.trim() ? JSON.parse(out.trim().split("\n").pop() as string) : null;
      } catch {
        /* leave null */
      }
      res({ code: code ?? -1, json, stderr: err });
    });
  });
}

/** The real autospec binary, configured by a 0600 YAML file, publishing one reviewer's verdict for (PR, commit). */
function publish(bin: string, tmp: string, plane: Plane, label: string, pr: string, commit: string, n: number) {
  const cfg = join(tmp, `autospec-${label}.yml`);
  writeFileSync(cfg, `herdr:\n  enabled: true\n  url: ${plane.url}\n  ingest_key: ${plane.keys[label]}\n`);
  chmodSync(cfg, 0o600);
  const d = join(tmp, `receipt-${label}-${n}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "request.json"), JSON.stringify({ commit, pr }));
  writeFileSync(join(d, "verdict.json"), JSON.stringify({ commit, verdict: "lgtm", reviewer: label, n }));
  const out = execFileSync(
    bin,
    [
      "review-quorum",
      "publish",
      "--config",
      cfg,
      "--request",
      join(d, "request.json"),
      "--verdict",
      join(d, "verdict.json"),
      "--pr-node",
      pr,
      "--scratch-dir",
      join(tmp, "scratch"),
    ],
    { env: { PATH: process.env.PATH ?? "", HOME: tmp }, encoding: "utf8" },
  );
  return JSON.parse(out);
}

describe("scenario 2 / AutoSpec mission: DAG -> worktrees -> PR -> independent review -> repair -> guarded merge", () => {
  let plane: Plane;
  let tmp: string;
  let agentDir: string;
  let storeDir: string;
  let bare: string;
  let clone: string;
  let autospecBin: string;
  let missionId: string;
  let plan: CliRun;
  let backend: JsonlEventStore;
  let store: MissionStore;
  let emitter: NonNullable<Awaited<ReturnType<typeof loadLineageEmitter>>>;
  let prNumber = 0;
  let head1 = "";
  let head2 = "";
  const worktrees: Record<string, { path: string; branch: string }> = {};
  const ghCalls = () =>
    readFileSync(join(tmp, "gh", "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  const quorum = async () => {
    const r = await plane.call("GET", `/api/v1/graph/nodes/${encodeURIComponent(PR_NODE(prNumber))}/review-quorum`, {
      key: "operator",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };

  before(async () => {
    const { loadAcceptance } = await import("./support/plane.ts");
    autospecBin = (await loadAcceptance()).autospecBin;
    plane = await Plane.start({
      keys: { pi: "ingest", r1: "ingest", r2: "ingest" },
      quorum: {
        required: 2,
        trusted_head_writers: ["@pi"],
        reviewers: { "@r1": {}, "@r2": {} },
      },
    });
    tmp = mkdtempSync(join(tmpdir(), "t16-s2-"));
    agentDir = join(tmp, "agent");
    mkdirSync(agentDir, { recursive: true });
    const keyFile = join(agentDir, "ingest.key");
    writeFileSync(keyFile, `${plane.keys.pi}\n`);
    chmodSync(keyFile, 0o600);
    writeFileSync(
      join(agentDir, "engineering.yaml"),
      `${[
        "autospec:",
        "  dag:",
        "    enabled: true",
        "herdr:",
        `  url: ${plane.url}`,
        `  api_key_file: ${keyFile}`,
        "  instance_id: pi-s2",
        "  lineage: true",
        "  visibility: org",
      ].join("\n")}\n`,
    );
    storeDir = join(tmp, "store");
    // real git: bare remote + working clone with one commit on main
    bare = join(tmp, "origin.git");
    clone = join(tmp, "work", "widgets");
    mkdirSync(clone, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    git(clone, "init", "-q", "-b", "main");
    writeFileSync(join(clone, "README.md"), "widgets\n");
    git(clone, "add", ".");
    git(clone, "commit", "-q", "-m", "init");
    git(clone, "remote", "add", "origin", bare);
    git(clone, "push", "-q", "origin", "main");
    // the fake gh, copied so its state lives beside it
    cpSync(FAKE_GH, join(tmp, "gh"), { recursive: true });
    writeFileSync(
      join(tmp, "gh", "state.json"),
      JSON.stringify({
        remote: bare,
        repo: REPO,
        author: "pi-bot",
        nextPr: 41,
        prs: {},
        issues: { 12: "Add widget cache", 13: "Document widget cache" },
      }),
    );
    writeFileSync(join(tmp, "gh", "calls.jsonl"), "");
  });

  after(async () => {
    backend?.close();
    await plane?.stop();
  });

  // ---------------------------------------------------------------------------------------------------- the DAG
  it("the real plan CLI ingests the existing AutoSpec issue DAG: may_proceed, tasks, deps, cross-repo issue refs, digest", async () => {
    const dagFile = join(tmp, "dag.json");
    const dag = dagFixture();
    writeFileSync(dagFile, JSON.stringify(dag));
    plan = await runPlan(["--store", storeDir, "--from-autospec", dagFile], tmp, agentDir);
    assert.equal(plan.code, 0, plan.stderr);
    assert.equal(plan.json.result, "may_proceed");
    missionId = plan.json.missionId;
    assert.equal(missionId, "m-fixture-1");
    assert.deepEqual(
      plan.json.tasks.map((t: any) => [t.taskId, t.dependsOn]),
      [
        ["t-1", []],
        ["t-2", ["t-1"]],
        ["t-3", ["t-1"]],
      ],
    );
    assert.deepEqual(plan.json.issueRefs, {
      "t-1": ["acme/other#3", "acme/widgets#12"],
      "t-2": ["acme/widgets#13"],
      "t-3": [],
    });
    const again = ingestAutoSpecDag({ mission: dag.mission, tasks: dag.tasks });
    assert.ok(again.ok, "the same input ingests in-process");
    assert.match(plan.json.planDigest, /^[0-9a-f]{64}$/);
  });

  it("negative control: a task that AutoSpec has not assigned to Pi (autospec-managed) is rejected by the same CLI", async () => {
    const bad = dagFixture();
    (bad.tasks[1] as { executor: string }).executor = "autospec-managed";
    const f = join(tmp, "dag-bad.json");
    writeFileSync(f, JSON.stringify(bad));
    const r = await runPlan(["--store", join(tmp, "store-bad"), "--from-autospec", f], tmp, agentDir);
    assert.equal(r.code, 2);
    assert.equal(r.json.result, "rejected");
  });

  it("the mission is persisted by the CLI; with no plan reviewer configured the plan is explicitly unreviewed (no revision)", async () => {
    backend = await JsonlEventStore.open(join(storeDir, "orchestration.jsonl"));
    store = MissionStore.open(backend);
    assert.ok(store.getMission(missionId), "mission exists");
    assert.equal(plan.json.reviewed, false, plan.json.reason);
    assert.deepEqual(store.listPlanRevisions(missionId), [], "unreviewed means no review revision was recorded");
  });

  it("GAP: the plan CLI itself writes nothing to Herdr (planCli never builds a lineage emitter), so the mission is absent from the graph", async () => {
    const sources = Object.keys(await plane.sources());
    assert.deepEqual(
      sources.filter((s) => s.includes("pi")),
      [],
      "no Pi source has registered after the CLI ran with a configured herdr: block",
    );
    assert.equal((await plane.node(`mission:${missionId}`)).status, 404);
  });

  // ------------------------------------------------------------------------------------------ worktrees + spawn
  it("one real git worktree per task, each on its own branch, as siblings of the repo (isolated)", async () => {
    const repo = await GitRepo.open(clone);
    assert.ok(repo);
    const base = git(clone, "rev-parse", "HEAD");
    for (const id of ["t-1", "t-2", "t-3"]) {
      const wt = await repo.createWorktree(base, `pi-eng-s2-${id}`);
      worktrees[id] = wt;
    }
    const listed = git(clone, "worktree", "list", "--porcelain");
    for (const id of ["t-1", "t-2", "t-3"])
      assert.ok(listed.includes(worktrees[id]!.path), `${id} is a registered worktree`);
    assert.equal(new Set(Object.values(worktrees).map((w) => w.path)).size, 3);
    assert.equal(new Set(Object.values(worktrees).map((w) => w.branch)).size, 3);
    // isolation: a commit in t-1 is invisible to t-2 (positive: it is visible in t-1)
    writeFileSync(join(worktrees["t-1"]!.path, "cache.txt"), "cache v1\n");
    git(worktrees["t-1"]!.path, "add", ".");
    git(worktrees["t-1"]!.path, "commit", "-q", "-m", "t-1: add cache");
    assert.equal(git(worktrees["t-1"]!.path, "ls-files", "cache.txt"), "cache.txt");
    assert.equal(git(worktrees["t-2"]!.path, "ls-files", "cache.txt"), "");
  });

  it("the YAML-configured emitter + the real createExecution path put the spawned tasks into the Herdr graph", async () => {
    const em = await loadLineageEmitter({ agentDir, envelopeDir: join(tmp, "envelopes") });
    assert.ok(em, "the herdr: block yields a lineage emitter");
    emitter = em;
    store.setLineage(emitter);
    store.bindWorkspaceManifest({
      manifestId: "WM-s2",
      missionId,
      generation: 1,
      authorizedRoots: [{ canonicalPath: clone, source: "existing_manifest", access: "write" }],
      repositories: [
        {
          repoId: "repo-1",
          canonicalRoot: clone,
          baseRef: "main",
          baseSha: git(clone, "rev-parse", "main"),
          writableDomains: ["**"],
        },
      ],
      dependencyEdges: [],
      hash: "manifest-s2",
      createdAt: new Date().toISOString(),
    } as WorkspaceManifest);
    for (const t of plan.json.tasks as Array<{ taskId: string }>) {
      store.createTask({
        task_id: `TSK-${t.taskId}`,
        mission_id: missionId,
        kind: "agent",
        role: "implementer",
        objective: `AutoSpec ${t.taskId}`,
        repo_id: "repo-1",
        acceptance_ids: [],
        deliverables: ["implementation"],
        execution_budget_ms: 60_000,
        checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
        candidate_generation: 0,
        mission_generation: 0,
        fencing_token: 0,
      } as never);
      const ex = store.createExecution({
        task_id: `TSK-${t.taskId}`,
        mission_id: missionId,
        backend: "agent",
        checkpoint_id: `TCP-${t.taskId}`,
        repo_id: "repo-1",
        base_sha: git(clone, "rev-parse", "main"),
      });
      store.setExecutionStatus(ex.execution_id, "RUNNING", { session_id: `S-${t.taskId}` });
    }
    await store.flush();
    await emitter.idle();
    for (const id of ["t-1", "t-2", "t-3"]) {
      const r = await eventually(async () => {
        const n = await plane.node(`agent:TSK-${id}`);
        return n.status === 200 ? n : false;
      }, `agent:TSK-${id} in the graph`);
      assert.equal(r.body.node.state, "running");
    }
    assert.equal((await plane.node("agent:TSK-t-99")).status, 404, "control: a task that was never spawned is absent");
  });

  // ------------------------------------------------------------------------------------------------------- the PR
  it("Pi opens a PR through its GhCliClient (fake gh over the real remote) and links it to the task and the cross-repo issue", async () => {
    git(worktrees["t-1"]!.path, "push", "-q", "origin", `${worktrees["t-1"]!.branch}:${worktrees["t-1"]!.branch}`);
    const client = createGithubClient({ enabled: true, ghPath: join(tmp, "gh", "gh") });
    assert.ok(client?.createPullRequest);
    const pr = await client.createPullRequest({
      repo: { host: "github.com", owner: "acme", repo: "widgets" },
      head: worktrees["t-1"]!.branch,
      base: "main",
      title: "t-1: add cache",
      body: "Closes acme/widgets#12",
      draft: false,
    });
    prNumber = pr.ref.number;
    head1 = pr.headSha;
    assert.equal(head1, git(worktrees["t-1"]!.path, "rev-parse", "HEAD"), "the PR head is the real commit");
    const links = await linkPullRequest(client, store, {
      missionId,
      prRef: pr.ref,
      subjects: [{ kind: "task", id: "TSK-t-1" }],
      headSha: head1,
      provenance: "pr_create_output",
    });
    assert.equal(links.length, 1);
    for (const l of links) emitLinkRecorded(emitter, l);
    await emitter.idle();
    const node = await eventually(async () => {
      const n = await plane.node(PR_NODE(prNumber));
      return n.status === 200 ? n : false;
    }, "the PR node");
    assert.equal(node.body.node.attrs.head_sha, head1);
    assert.deepEqual(
      (await plane.edges(PR_NODE(prNumber))).filter(([t]) => t === "issue_link"),
      [["issue_link", "task:TSK-t-1", PR_NODE(prNumber)]],
      "the task is linked to the PR",
    );
  });

  it("GAP: the issue ids of the DAG (acme/widgets#12, acme/other#3) never become issue nodes or issue_link edges in Herdr", async () => {
    // positive control above: the task->PR link exists. The DAG's own issue refs have no runtime emitter caller.
    for (const id of ["issue:github.com/acme/widgets#12", "issue:github.com/acme/other#3"]) {
      assert.equal((await plane.node(id)).status, 404, id);
    }
  });

  it("GAP: no CI validation node, no 'validated' edge and no dependency edge is emitted for the PR by any runtime path", async () => {
    const edges = await plane.edges(PR_NODE(prNumber));
    assert.ok(edges.length >= 1, "control: the PR does have edges");
    assert.deepEqual(
      edges.filter(([t]) => t === "validated" || t === "dependency"),
      [],
    );
  });

  // ----------------------------------------------------------------------- independent reviewers and head change
  it("two independent AI reviewers (real autospec binary) at the PR head satisfy Herdr's quorum; one does not", async () => {
    assert.equal((await quorum()).status, "insufficient"); // control: nobody has reviewed
    assert.equal((await quorum()).head, head1, "Herdr knows the head Pi wrote");
    assert.equal(publish(autospecBin, tmp, plane, "r1", PR_NODE(prNumber), head1, 1).outcome, "published");
    assert.equal((await quorum()).status, "insufficient");
    assert.equal(publish(autospecBin, tmp, plane, "r2", PR_NODE(prNumber), head1, 2).outcome, "published");
    const q = await quorum();
    assert.equal(q.status, "satisfied");
    assert.equal(q.counted.length, 2);
  });

  it("a verdict for a PR no trusted writer has reported is refused by Herdr (paired with the accepted publish above)", async () => {
    assert.throws(
      () => publish(autospecBin, tmp, plane, "r1", PR_NODE(99), sha40("stray"), 3),
      /HTTP 403/,
      "publishing against an unknown PR must fail",
    );
    assert.equal((await quorum()).status, "satisfied", "control: the real PR is unaffected");
  });

  // ---------------------------------------------------------------------------------------- merge gate (before repair)
  const decision = (candidate: string, prHead: string, reviewSha: string | null, ci: "pass" | "fail" | "pending") =>
    decideMerge({
      repo: REPO,
      prNumber,
      candidateSha: candidate,
      prHeadSha: prHead,
      baseSha: git(clone, "rev-parse", "main"),
      checks: [{ name: "ci", status: ci, sha: prHead }],
      requiredChecks: ["ci"],
      review: reviewSha === null ? null : { verdict: "PASS", sha: reviewSha },
      queue: [],
    });

  it("Pi's decideMerge merges only when review and green CI are on the live head; no review waits, red CI rejects", async () => {
    const q = await quorum();
    assert.equal(q.status, "satisfied");
    const verdictSha = q.head; // the test maps a satisfied quorum to a PASS verdict: no product code does (see GAP below)
    assert.equal(decision(head1, head1, verdictSha, "pass").decision, "merge");
    assert.equal(decision(head1, head1, null, "pass").decision, "wait");
    assert.equal(decision(head1, head1, verdictSha, "pending").decision, "wait");
    assert.equal(decision(head1, head1, verdictSha, "fail").decision, "reject");
  });

  // -------------------------------------------------------------------------------------------------- defect repair
  it("defect repair: a real commit on the task worktree moves the PR head; Pi re-links; Herdr's old verdicts go stale", async () => {
    const wt = worktrees["t-1"]!;
    writeFileSync(join(wt.path, "cache.txt"), "cache v2 (defect repaired)\n");
    git(wt.path, "commit", "-q", "-am", "t-1: repair cache defect");
    git(wt.path, "push", "-q", "origin", `${wt.branch}:${wt.branch}`);
    head2 = git(wt.path, "rev-parse", "HEAD");
    assert.notEqual(head2, head1);
    const client = createGithubClient({ enabled: true, ghPath: join(tmp, "gh", "gh") });
    assert.ok(client);
    const relink = await linkPullRequest(client, store, {
      missionId,
      prRef: { host: "github.com", owner: "acme", repo: "widgets", number: prNumber, kind: "pr" },
      subjects: [{ kind: "task", id: "TSK-t-1" }],
      provenance: "pr_create_output",
    });
    assert.equal(relink[0]?.observed.headSha, head1, "control: re-linking is idempotent and keeps the recorded head");
    // the real head-move path is the reconciler: it asks GitHub (fake over the real remote), corrects the link,
    // emits the new head to Herdr and records a stale signal for evidence bound to the old head
    const result = await reconcileGithubLinks(client, store, { hosts: ["github.com"] }, { missionId, sink: emitter });
    assert.equal(result.status, "ok");
    assert.equal(result.corrections.length, 1, JSON.stringify(result));
    assert.equal(result.staleSignals.length, 1);
    assert.equal(store.getGithubLink(relink[0]!.linkId)?.observed.headSha, head2);
    await emitter.idle();
    await eventually(
      async () => (await plane.node(PR_NODE(prNumber))).body.node?.attrs?.head_sha === head2,
      "new head in graph",
    );
    const q = await quorum();
    assert.equal(q.head, head2);
    assert.equal(q.status, "insufficient", "both verdicts were for the old head");
    assert.deepEqual(q.counted, []);
    assert.equal(q.rereview_required, true);
  });

  it("the old verdict no longer merges: decideMerge rejects a PASS pinned to the previous head, CI included", async () => {
    assert.equal(decision(head2, head2, head1, "pass").decision, "reject"); // stale review
    assert.equal(decision(head1, head2, head2, "pass").decision, "reject"); // candidate is the old commit
    assert.equal(decision(head2, head2, head2, "pass").decision, "merge"); // control: everything on the new head
  });

  it("fresh independent verdicts at the new head satisfy the quorum again, and then the gate merges", async () => {
    // a verdict that arrives late for the OLD head is accepted as history but counts for nothing
    publish(autospecBin, tmp, plane, "r1", PR_NODE(prNumber), head1, 6);
    publish(autospecBin, tmp, plane, "r2", PR_NODE(prNumber), head1, 7);
    const late = await quorum();
    assert.equal(late.status, "insufficient");
    assert.deepEqual(late.counted, []);
    publish(autospecBin, tmp, plane, "r1", PR_NODE(prNumber), head2, 4);
    assert.equal((await quorum()).status, "insufficient", "one fresh verdict is not enough");
    publish(autospecBin, tmp, plane, "r2", PR_NODE(prNumber), head2, 5);
    const q = await quorum();
    assert.equal(q.status, "satisfied");
    assert.equal(q.head, head2);
    assert.equal(decision(head2, head2, q.head, "pass").decision, "merge");
  });

  it("the author attr Pi writes for the PR reaches Herdr readable (was stored as [REDACTED] until the T16 redact fix)", async () => {
    const attrs = (await plane.node(PR_NODE(prNumber))).body.node.attrs;
    assert.equal(attrs.head_sha, head2, "control: sibling attrs survive");
    assert.equal(attrs.author, "pi-bot", "the head-bound quorum needs the login to exclude the author's own approval");
  });

  it("GAP: nothing in Pi calls the reconciler or reacts to github.evidence_stale (no automatic re-review request)", async () => {
    const callers = spawnSync("grep", ["-rlE", "reconcileGithubLinks|github\\.evidence_stale", join(PI, "src")], {
      encoding: "utf8",
    })
      .stdout.trim()
      .split("\n")
      .map((f) => f.replace(`${PI}/`, ""))
      .sort();
    assert.ok(callers.includes("src/github/reconcile.ts"), "control: the reconciler exists");
    assert.ok(
      !callers.some((f) => f.startsWith("src/runtime/") || f.startsWith("src/orchestration/forks")),
      callers.join(","),
    );
  });

  it("GAP: nothing in Pi connects Herdr's review quorum to its merge gate (decideMerge has no runtime caller, no quorum reader)", async () => {
    const src = (p: string) => readFileSync(join(PI, p), "utf8");
    assert.ok(src("src/merge/mergeGate.ts").includes("export function decideMerge"), "control: the gate exists");
    const callers = execFileSync("grep", ["-rl", "decideMerge", join(PI, "src")], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((f) => f.replace(`${PI}/`, ""))
      .filter((f) => f !== "src/merge/mergeGate.ts");
    assert.ok(
      callers.every((f) => f.startsWith("src/merge/")),
      `no non-merge caller: ${callers.join(",")}`,
    );
    const quorumReaders = spawnSync("grep", ["-rliE", "review-quorum|review_quorum", join(PI, "src")], {
      encoding: "utf8",
    });
    assert.equal(quorumReaders.status, 1, `grep finds no reader: ${quorumReaders.stdout}`); // 1 = no match
  });

  it("the fake gh was only asked for the calls Pi's client makes (no merge, no review-write)", async () => {
    const calls = ghCalls();
    assert.ok(calls.length >= 3);
    assert.ok(calls.every((c) => c[0] === "api"));
    assert.ok(!calls.some((c) => c.join(" ").includes("merge")));
  });
});
