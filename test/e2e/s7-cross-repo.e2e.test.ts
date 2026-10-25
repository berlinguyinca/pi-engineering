import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverGithubLinks } from "../../src/github/discovery.ts";
import {
  type DependencyItem,
  buildDependencyGraph,
  canonicalId,
  emitDependencyEdges,
  emitLinkRecorded,
  parseGithubRef,
  refKey,
} from "../../src/github/index.ts";
import type { GithubLinkRecord } from "../../src/github/types.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { loadLineageEmitter } from "../../src/runtime/herdr/lineageConfig.ts";
import { FakeGithubClient } from "../support/fakeGithubClient.ts";
import { Plane, eventually } from "./support/plane.ts";
/**
 * ACCEPTANCE SCENARIO 7 (non-visual part) - cross-repo issue references.
 * "Test cross-repo issues ..." Pi's REAL github layer (refs, dependency graph, link records, lineage projection) feeds a
 * REAL YAML-configured lineage emitter into a REAL Herdr control plane; the room member navigates the graph across repos.
 * (Plannotator digest echo and PR-head validity are in herdr tests/e2e/test_s7_integrity.py.)
 */
import { scratch } from "./support/scratch.ts";

const PI = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ref = (s: string) => {
  const p = parseGithubRef(s);
  assert.ok(p.ok, s);
  return p.ref;
};

describe("scenario 7 / cross-repo issues in the Herdr graph", () => {
  let plane: Plane;
  let roomId: string;
  let envDir: string;
  let emitter: NonNullable<Awaited<ReturnType<typeof loadLineageEmitter>>>;

  before(async () => {
    plane = await Plane.start({
      keys: { pi: "ingest" },
      users: ["alice", "bob"],
      scopes: { pi: { rooms: ["*"], missions: ["*"] } },
    });
    await plane.verifyFeatures("alice");
    roomId = (await plane.makeRoom("alice", "s7", "s7-room")).roomId;
    const root = scratch("t16-s7-");
    const agentDir = join(root, "agent");
    envDir = join(root, "env");
    mkdirSync(agentDir, { recursive: true });
    const keyFile = join(root, "k");
    writeFileSync(keyFile, `${plane.keys.pi}\n`);
    chmodSync(keyFile, 0o600);
    writeFileSync(
      join(agentDir, "engineering.yaml"),
      `herdr:\n  url: ${plane.url}\n  api_key_file: ${keyFile}\n  lineage: true\n  visibility: room\n  room_id: ${roomId}\n`,
    );
    const e = await loadLineageEmitter({ agentDir, envelopeDir: envDir });
    assert.ok(e);
    emitter = e;
  });
  after(async () => {
    await plane?.stop();
  });

  const api7 = "github.com/acme/api#7";
  const web7 = "github.com/acme/web#7";
  const web9 = "github.com/acme/web#9";
  const read = (id: string, user: string) => plane.c("GET", `/graph/nodes/${encodeURIComponent(id)}`, { user });
  const hood = (id: string, user: string, depth = 1) =>
    plane.c("GET", `/graph/nodes/${encodeURIComponent(id)}/neighborhood?depth=${depth}`, { user });

  it("projects a DAG with a cross-repo dependency and per-repo issue links; same number in two repos stays two nodes", async () => {
    const items: DependencyItem[] = [
      { ref: ref("https://github.com/acme/api/issues/7"), state: "open" },
      { ref: ref("https://github.com/acme/web/issues/7"), state: "open" },
      {
        ref: ref("https://github.com/acme/web/issues/9"),
        state: "open",
        body: "## Dependencies\n\nBlocked by acme/api#7\n",
      },
    ];
    const graph = buildDependencyGraph(items);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0]?.crossRepo, true, "the edge crosses repositories");
    const refs = new Map(items.map((i) => [refKey(i.ref), i.ref]));
    // the endpoints are materialised first: the plane refuses an edge whose endpoint exists only as an "ensure" placeholder
    for (const i of items)
      emitter.nodeUpsert(canonicalId(i.ref), { label: `Issue in ${refKey(i.ref)}`, state: "pending" }, "s7-seed", {
        mission_id: "M-s7",
      });
    emitDependencyEdges(emitter, graph.edges, refs, { mission_id: "M-s7" });
    // each repo's issue is also linked from a Pi task (the real link-record projection)
    for (const [n, target] of [
      ["t-api", api7],
      ["t-web", web7],
    ] as const) {
      const link: GithubLinkRecord = {
        linkId: `L-${n}`,
        missionId: "M-s7",
        subject: { kind: "task", id: n },
        target: `issue:${target}`,
        targetKind: "issue",
        provenance: "explicit",
        source: "goal",
        observed: { state: "open", title: `Issue in ${target}` },
        status: "active",
        recordedAt: new Date().toISOString(),
      } as never;
      emitLinkRecorded(emitter, link);
    }
    await emitter.idle();

    const a = await eventually(async () => {
      const r = await read(`issue:${api7}`, "alice");
      return r.status === 200 ? r : false;
    }, "api#7 in the room graph");
    const w = await read(`issue:${web7}`, "alice");
    assert.equal(w.status, 200);
    assert.notEqual(
      a.body.node.node_id ?? a.body.node.id,
      w.body.node.node_id ?? w.body.node.id,
      "same number, two repos, two nodes",
    );
    assert.equal(w.body.node.label, `Issue in ${web7}`);
    // the sibling repo's issue is not linked to the other repo's task
    const web7edges = (await hood(`issue:${web7}`, "alice")).body.edges.map((e: any) => [e.edge_type, e.from_id]);
    assert.deepEqual(web7edges, [["issue_link", "task:t-web"]]);
  });

  it("the cross-repo dependency is navigable from either side with its provenance", async () => {
    const out = await eventually(async () => {
      const r = await hood(`issue:${web9}`, "alice");
      return (r.body.edges ?? []).length ? r : false;
    }, "web#9 dependency edge");
    const dep = out.body.edges.find((e: any) => e.edge_type === "dependency");
    assert.equal(dep.from_id, `issue:${web9}`);
    assert.equal(dep.to_id, `issue:${api7}`);
    assert.equal(dep.attrs.cross_repo, true);
    assert.equal(dep.attrs.source, "body");
    // from the prerequisite, the dependent is reachable (incoming edge), crossing the repo boundary the other way
    const back = await hood(`issue:${api7}`, "alice", 2);
    assert.ok(back.body.edges.some((e: any) => e.edge_type === "dependency" && e.from_id === `issue:${web9}`));
    const ids = new Set((back.body.nodes ?? []).map((n: any) => n.node_id ?? n.id));
    assert.ok(ids.has(`issue:${web9}`) && ids.has(`issue:${api7}`));
  });

  it("only the room reads it: a signed-in non-member gets the same 404 as for an absent issue (positive control: the member read above)", async () => {
    const hidden = await read(`issue:${api7}`, "bob");
    const absent = await read("issue:github.com/acme/nothing#1", "bob");
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body, absent.body);
    assert.equal((await read(`issue:${api7}`, "alice")).status, 200);
  });

  it("negative control: the bare library call emitDependencyEdges on endpoints that were never fully upserted is refused by the plane (403 lineage_forbidden, dead-lettered), which is why the runtime caller seeds the issue nodes first", async () => {
    const items: DependencyItem[] = [
      { ref: ref("https://github.com/acme/api/issues/21"), state: "open" },
      {
        ref: ref("https://github.com/acme/web/issues/22"),
        state: "open",
        body: "## Dependencies\n\nBlocked by acme/api#21\n",
      },
    ];
    const g = buildDependencyGraph(items);
    emitDependencyEdges(emitter, g.edges, new Map(items.map((i) => [refKey(i.ref), i.ref])), { mission_id: "M-s7" });
    await emitter.idle();
    await eventually(
      async () => (await new EnvelopeStore({ dir: envDir }).outbox.pending()).length === 0,
      "outbox settled",
    );
    const dead = readdirSync(envDir)
      .filter((f) => f.endsWith(".deadletter.jsonl"))
      .map((f) => readFileSync(join(envDir, f), "utf8"))
      .join("");
    assert.match(dead, /lineage_forbidden/);
    assert.match(dead, /issue:github\.com\/acme\/web#22/);
    const h = await hood("issue:github.com/acme/web#22", "alice");
    assert.deepEqual(h.body.edges ?? [], [], "no dependency edge reached the graph");
  });

  it("the runtime caller exists: `pi-engineering github sync` seeds the issue nodes with fields, then emits the cross-repo dependency edge, and the room member navigates it", async () => {
    const root = scratch("t16-s7-sync-");
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const keyFile = join(root, "k");
    writeFileSync(keyFile, `${plane.keys.pi}\n`);
    chmodSync(keyFile, 0o600);
    cpSync(join(PI, "test/e2e/fake_gh_s7"), join(root, "gh"), { recursive: true });
    writeFileSync(
      join(agentDir, "engineering.yaml"),
      `${[
        "herdr:",
        `  url: ${plane.url}`,
        `  api_key_file: ${keyFile}`,
        "  lineage: true",
        "  visibility: room",
        `  room_id: ${roomId}`,
        "github:",
        "  enabled: true",
        `  gh_path: ${JSON.stringify(join(root, "gh", "gh"))}`,
      ].join("\n")}\n`,
    );
    // the links a mission would hold (recorded in-process through the real discovery), in a store the CLI then reads
    const storeDir = join(root, "store");
    mkdirSync(storeDir, { recursive: true });
    const backend = await JsonlEventStore.open(join(storeDir, "orchestration.jsonl"));
    const store = MissionStore.open(backend);
    const mission = store.createMission({
      title: "s7",
      goal: "acme/api#31 and acme/web#32",
      user_request: "g",
      repository: ".",
      base_ref: "b",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const fake = new FakeGithubClient();
    fake.put("github.com/acme/api#31", { title: "Provide the API", state: "open" });
    fake.put("github.com/acme/web#32", { title: "Use the API", state: "open" });
    await discoverGithubLinks(fake, store, {}, { missionId: mission.mission_id, goal: "acme/api#31 and acme/web#32" });
    assert.equal(store.listGithubLinks().length, 2, "control: both issues are linked");
    await store.flush();
    backend.close();

    const out = await new Promise<{ code: number; stdout: string; stderr: string }>((res, rej) => {
      const child = spawn(
        process.execPath,
        [join(PI, "scripts/pi-engineering.ts"), "github", "sync", "--store", storeDir],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: root,
            PI_CODING_AGENT_DIR: agentDir,
            PI_ENGINEERING_STATE_DIR: join(root, "state"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", rej);
      child.on("close", (code) => res({ code: code ?? -1, stdout, stderr }));
    });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout.trim().split("\n").pop() as string).dependencyEdges, 1);
    const dep = await eventually(async () => {
      const r = await hood("issue:github.com/acme/web#32", "alice");
      const e = (r.body.edges ?? []).find((x: any) => x.edge_type === "dependency");
      return e ?? false;
    }, "the dependency edge written by the CLI");
    assert.equal(dep.to_id, "issue:github.com/acme/api#31");
    assert.equal(dep.attrs.cross_repo, true);
    assert.equal((await read("issue:github.com/acme/api#31", "alice")).body.node.label, "acme/api#31");
    assert.equal((await hood("issue:github.com/acme/web#32", "bob")).status, 404, "a non-member sees nothing");
  });

  it("canonical ids are repo-qualified and reject ambiguity (a bare #7 without a default repo is not a node)", () => {
    assert.equal(canonicalId(ref("https://github.com/acme/api/issues/7")), `issue:${api7}`);
    assert.equal(parseGithubRef("#7").ok, false);
    assert.equal(parseGithubRef("acme/api#7").ok, true);
  });
});
