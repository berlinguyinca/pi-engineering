import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverGithubLinks } from "../../src/github/discovery.ts";
import { linkPullRequest } from "../../src/github/prLinks.ts";
import type { QuorumView } from "../../src/github/quorum.ts";
import { type GithubRef, parseGithubRef } from "../../src/github/refs.ts";
import { githubSync } from "../../src/github/sync.ts";
import type { RestCheckRun } from "../../src/merge/checkRunIngest.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { FakeGithubClient } from "../support/fakeGithubClient.ts";

const cfg = { defaultRepo: "acme/widgets" };
const NOW = () => "2026-10-23T00:00:00.000Z";
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const PR = "pr:github.com/acme/widgets#30";

const ref = (t: string): GithubRef => {
  const r = parseGithubRef(t, cfg);
  if (!r.ok) throw new Error(r.reason);
  return r.ref;
};

class ChecksClient extends FakeGithubClient {
  runs: RestCheckRun[] = [];
  async listCheckRuns(_ref: GithubRef, sha: string): Promise<RestCheckRun[]> {
    return this.runs.map((r) => ({ ...r, head_sha: r.head_sha ?? sha }));
  }
}

/** Records every emitter call, in the shape of the real LineageEmitter's primitives. */
class Recorder {
  readonly calls: Array<{ op: string; args: unknown[] }> = [];
  nodeUpsert(...args: unknown[]) {
    this.calls.push({ op: "nodeUpsert", args });
  }
  nodeState(...args: unknown[]) {
    this.calls.push({ op: "nodeState", args });
  }
  edgeAdd(...args: unknown[]) {
    this.calls.push({ op: "edgeAdd", args });
  }
  edgeRemove(...args: unknown[]) {
    this.calls.push({ op: "edgeRemove", args });
  }
  edges(type: string) {
    return this.calls
      .filter((c) => c.op === "edgeAdd" && c.args[0] === type)
      .map((c) => [c.args[1], c.args[2], c.args[4]]);
  }
  node(id: string) {
    return this.calls.filter((c) => c.op === "nodeUpsert" && c.args[0] === id);
  }
}

async function world() {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    title: "m",
    goal: "work on #12",
    user_request: "g",
    repository: ".",
    base_ref: "b",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  const client = new ChecksClient();
  client.put("github.com/acme/widgets#12", {
    title: "Issue",
    state: "open",
    body: "## Dependencies\n- Blocked by #7\n",
  });
  client.put("github.com/acme/widgets#7", { title: "Prereq", state: "open" });
  client.put("github.com/acme/widgets#30", {
    title: "PR",
    state: "open",
    pr: { state: "open", headSha: SHA1, body: "x" },
  });
  await discoverGithubLinks(client, store, cfg, { missionId: mission.mission_id, goal: "work on #12" }, NOW);
  await linkPullRequest(
    client,
    store,
    {
      missionId: mission.mission_id,
      prRef: ref("https://github.com/acme/widgets/pull/30"),
      subjects: [{ kind: "task", id: "t1" }],
    },
    NOW,
  );
  return { store, mission, client, rec: new Recorder() };
}

const quorum = (q: Partial<QuorumView>) => async () => ({
  status: "insufficient",
  head: SHA1,
  counted: [],
  rereviewRequired: false,
  ...q,
});
const green: RestCheckRun[] = [{ name: "ci", status: "completed", conclusion: "success" }];

describe("githubSync", () => {
  it("is inert without a client", async () => {
    const { store, rec } = await world();
    const r = await githubSync({ client: null, store, cfg, lineage: rec as never });
    assert.equal(r.status, "disabled");
    assert.equal(rec.calls.length, 0);
  });

  it("projects green CI as a validated edge bound to the head, and none for a failing head", async () => {
    const w = await world();
    w.client.runs = green;
    await githubSync({ client: w.client, store: w.store, cfg, lineage: w.rec as never, now: NOW });
    const validated = w.rec.edges("validated");
    assert.equal(validated.length, 1);
    assert.deepEqual(validated[0]?.slice(1, 3), [PR, { commit: SHA1 }]);

    const f = await world();
    f.client.runs = [{ name: "ci", status: "completed", conclusion: "failure" }];
    await githubSync({ client: f.client, store: f.store, cfg, lineage: f.rec as never, now: NOW });
    assert.equal(f.rec.edges("validated").length, 0, "control: red CI validates nothing");
    assert.equal(f.rec.calls.filter((c) => c.op === "nodeUpsert" && String(c.args[0]).startsWith("ci:")).length, 1);
  });

  it("a moved PR head becomes ONE durable re-review request, the command runs once, and a second tick is idempotent", async () => {
    const w = await world();
    const ran: string[][] = [];
    const run = async (argv: string[]) => {
      ran.push(argv);
      return true;
    };
    const deps = {
      client: w.client,
      store: w.store,
      cfg,
      lineage: w.rec as never,
      now: NOW,
      rereviewCommand: ["/bin/request"],
      run,
    };
    await githubSync(deps); // establishes the head
    assert.equal(ran.length, 0, "control: no head change, no request");
    w.client.items.get("github.com/acme/widgets#30")!.pr!.headSha = SHA2;
    const first = await githubSync(deps);
    assert.equal(first.rereviews.length, 1);
    assert.equal(first.rereviews[0]?.headSha, SHA2);
    assert.equal(first.rereviews[0]?.dispatch, "ok");
    assert.deepEqual(ran[0]?.slice(0, 5), ["/bin/request", "--pr", PR, "--head", SHA2]);
    const second = await githubSync(deps);
    assert.equal(second.rereviews.length, 0);
    assert.equal(ran.length, 1);
    assert.equal(w.store.listGithubRereviews().length, 1);
    const pr = w.rec.node(PR).filter((c) => (c.args[1] as { attrs?: { rereview_head?: string } }).attrs?.rereview_head);
    assert.equal(pr.length, 1, "the PR node says which head wants a re-review");
  });

  it("the merge gate reads Herdr's quorum: satisfied + green merges, no quorum waits, a head that moved is rejected", async () => {
    const w = await world();
    w.client.runs = green;
    const base = { client: w.client, store: w.store, cfg, lineage: w.rec as never, now: NOW };
    const wait = await githubSync({ ...base, quorum: quorum({ status: "insufficient" }) });
    assert.equal(wait.gates[0]?.decision, "wait");
    assert.equal(w.rec.edges("validated").filter((e) => String(e[0]).startsWith("gate:")).length, 0);
    const unreadable = await githubSync({ ...base, quorum: async () => null });
    assert.equal(unreadable.gates[0]?.decision, "wait", "an unreadable quorum is no review");
    const ok = await githubSync({ ...base, quorum: quorum({ status: "satisfied" }) });
    assert.equal(ok.gates[0]?.decision, "merge");
    const gateEdges = w.rec.edges("validated").filter((e) => String(e[0]).startsWith("gate:"));
    assert.equal(gateEdges.length, 1);
    assert.deepEqual(gateEdges[0]?.[2], { commit: SHA1, source: "merge-gate" });
    // the head moves under a quorum that still names the old head
    w.client.items.get("github.com/acme/widgets#30")!.pr!.headSha = SHA2;
    const moved = await githubSync({ ...base, quorum: quorum({ status: "satisfied", head: SHA1 }) });
    assert.equal(moved.gates[0]?.decision, "reject");
    assert.ok(moved.gates[0]?.reasons.some((x) => /candidate sha/.test(x)));
  });

  it("dependency edges are emitted after both issue nodes are defined with fields", async () => {
    const w = await world();
    const r = await githubSync({ client: w.client, store: w.store, cfg, lineage: w.rec as never, now: NOW });
    assert.equal(r.dependencyEdges, 1);
    const dep = w.rec.edges("dependency");
    assert.deepEqual(
      dep.map((e) => [e[0], e[1]]),
      [["issue:github.com/acme/widgets#12", "issue:github.com/acme/widgets#7"]],
    );
    const order = w.rec.calls.map((c) => `${c.op}:${c.args[0]}`);
    const edgeAt = order.findIndex((x) => x === "edgeAdd:dependency");
    for (const n of ["issue:github.com/acme/widgets#12", "issue:github.com/acme/widgets#7"])
      assert.ok(order.indexOf(`nodeUpsert:${n}`) !== -1 && order.indexOf(`nodeUpsert:${n}`) < edgeAt, n);
  });
});
