import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDependencyGraph } from "../../src/github/dependencies.ts";
import { discoverGithubLinks } from "../../src/github/discovery.ts";
import {
  type GithubLineageSink,
  emitCiValidation,
  emitDependencyEdges,
  emitLinkRecorded,
  subjectNodeId,
} from "../../src/github/lineage.ts";
import { linkClosingIssues, linkPullRequest } from "../../src/github/prLinks.ts";
import { reconcileGithubLinks } from "../../src/github/reconcile.ts";
import { type GithubRef, parseGithubRef } from "../../src/github/refs.ts";
import { normalizeCheckRuns } from "../../src/merge/checkRunIngest.ts";
import type { CheckRun } from "../../src/merge/mergeGate.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { FakeGithubClient } from "../support/fakeGithubClient.ts";

const cfg = { defaultRepo: "acme/widgets" };
const NOW = () => "2026-10-23T00:00:00.000Z";
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

const ref = (t: string): GithubRef => {
  const r = parseGithubRef(t, cfg);
  if (!r.ok) throw new Error(r.reason);
  return r.ref;
};

class RecordingSink implements GithubLineageSink {
  readonly events: Array<[string, ...unknown[]]> = [];
  nodeUpsert(...a: Parameters<GithubLineageSink["nodeUpsert"]>): void {
    this.events.push(["nodeUpsert", ...a]);
  }
  nodeState(...a: Parameters<GithubLineageSink["nodeState"]>): void {
    this.events.push(["nodeState", ...a]);
  }
  edgeAdd(...a: Parameters<GithubLineageSink["edgeAdd"]>): void {
    this.events.push(["edgeAdd", ...a]);
  }
  edgeRemove(...a: Parameters<GithubLineageSink["edgeRemove"]>): void {
    this.events.push(["edgeRemove", ...a]);
  }
  kinds(): string[] {
    return this.events.map((e) => (e[0] === "edgeAdd" || e[0] === "edgeRemove" ? `${e[0]}:${e[1]}` : (e[0] as string)));
  }
}

async function world() {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    title: "m",
    goal: "g",
    user_request: "g",
    repository: ".",
    base_ref: "b",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  const client = new FakeGithubClient();
  client.put("github.com/acme/widgets#12", { title: "Issue", state: "open" });
  client.put("github.com/acme/widgets#30", {
    title: "PR",
    state: "open",
    pr: { state: "open", headSha: SHA1, body: "Fixes #12" },
  });
  const subjects = [
    { kind: "task" as const, id: "t1" },
    { kind: "attempt" as const, id: "a1" },
  ];
  await discoverGithubLinks(client, store, cfg, { missionId: mission.mission_id, goal: "work on #12" }, NOW);
  await linkPullRequest(
    client,
    store,
    { missionId: mission.mission_id, prRef: ref("https://github.com/acme/widgets/pull/30"), subjects },
    NOW,
  );
  await linkClosingIssues(
    client,
    store,
    cfg,
    {
      missionId: mission.mission_id,
      prRef: ref("https://github.com/acme/widgets/pull/30"),
      prBody: "Fixes #12",
      subjects: [{ kind: "task", id: "t1" }],
    },
    NOW,
  );
  await store.flush();
  return { backend, store, mission, client };
}

describe("reconciler", () => {
  it("makes no change and emits nothing when GitHub matches the record", async () => {
    const { store, backend, client } = await world();
    const before = backend.count();
    const result = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    await store.flush();
    assert.equal(result.status, "ok");
    assert.deepEqual([result.corrections.length, result.staleSignals.length, result.errors.length], [0, 0, 0]);
    assert.ok(result.checked >= 4);
    assert.equal(backend.count(), before);
  });

  it("issue closed then reopened: corrects once each, and a second pass is a no-op", async () => {
    const { store, client } = await world();
    const item = client.items.get("github.com/acme/widgets#12");
    assert.ok(item);
    item.state = "closed";
    const first = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.ok(first.corrections.length >= 1);
    assert.ok(first.corrections.every((c) => /issue closed/.test(c.reason)));
    const second = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.equal(second.corrections.length, 0);
    item.state = "open";
    const third = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.ok(third.corrections.length >= 1 && third.corrections.every((c) => c.reason === "issue reopened"));
    assert.ok(
      store
        .listGithubLinks()
        .filter((l) => l.targetKind === "issue")
        .every((l) => l.observed.state === "open"),
    );
  });

  it("PR merged is recorded; PR closed unmerged is distinct", async () => {
    const { store, client } = await world();
    const pr = client.items.get("github.com/acme/widgets#30");
    assert.ok(pr?.pr);
    pr.pr.state = "merged";
    pr.state = "closed";
    const r = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.ok(r.corrections.length >= 2);
    assert.ok(
      store
        .listGithubLinks()
        .filter((l) => l.targetKind === "pr")
        .every((l) => l.observed.state === "merged"),
    );
    assert.equal((await reconcileGithubLinks(client, store, cfg, { now: NOW })).corrections.length, 0);
  });

  it("head SHA change emits one stale signal per link, exactly once, bound to the old and new SHA", async () => {
    const { store, client, mission } = await world();
    const pr = client.items.get("github.com/acme/widgets#30");
    assert.ok(pr?.pr);
    pr.pr.headSha = SHA2;
    const sink = new RecordingSink();
    const r = await reconcileGithubLinks(client, store, cfg, { now: NOW, sink });
    assert.equal(r.staleSignals.length, 2, "task->PR and attempt->PR");
    assert.ok(
      r.staleSignals.every((s) => s.previousHeadSha === SHA1 && s.headSha === SHA2 && s.reason === "pr_head_changed"),
    );
    assert.equal(store.listGithubStaleSignals(mission.mission_id).length, 2);
    assert.ok(
      sink.events.some(
        (e) => e[0] === "nodeUpsert" && (e[2] as { attrs?: { head_sha?: string } }).attrs?.head_sha === SHA2,
      ),
    );
    const again = await reconcileGithubLinks(client, store, cfg, { now: NOW, sink });
    assert.equal(again.staleSignals.length, 0);
    assert.equal(store.listGithubStaleSignals().length, 2);
  });

  it("a closing line removed from the PR body marks the link removed (tombstoned with a reason)", async () => {
    const { store, client } = await world();
    const pr = client.items.get("github.com/acme/widgets#30");
    assert.ok(pr?.pr);
    pr.pr.body = "No longer closes anything";
    const sink = new RecordingSink();
    const r = await reconcileGithubLinks(client, store, cfg, { now: NOW, sink });
    const removed = store.listGithubLinks().filter((l) => l.status === "removed");
    assert.equal(removed.length, 1);
    assert.equal(removed[0]?.viaPr, "pr:github.com/acme/widgets#30");
    const remove = sink.events.find((e) => e[0] === "edgeRemove");
    assert.deepEqual(
      [remove?.[1], remove?.[2], remove?.[3]],
      ["issue_link", "task:t1", "issue:github.com/acme/widgets#12"],
    );
    assert.match(String(remove?.[4]), /no longer present/);
    assert.ok(r.corrections.some((c) => c.patch.status === "removed"));
    // The mission-goal link to the same issue is untouched.
    assert.ok(store.listGithubLinks().some((l) => l.subject.kind === "mission" && l.status === "active"));
    assert.equal((await reconcileGithubLinks(client, store, cfg, { now: NOW })).corrections.length, 0);
  });

  it("deleted target: 404 is an explicit not_found correction, never 'closed'", async () => {
    const { store, client } = await world();
    client.items.delete("github.com/acme/widgets#12");
    const r = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.ok(r.corrections.every((c) => c.patch.status === "not_found"));
    const missing = store.listGithubLinks().filter((l) => l.status === "not_found");
    assert.ok(missing.length >= 1 && missing.every((l) => l.observed.state === "open"), "state untouched");
    assert.equal((await reconcileGithubLinks(client, store, cfg, { now: NOW })).corrections.length, 0);
  });

  it("transient/auth errors change nothing and are visible; healing resumes normally", async () => {
    const { store, client, backend } = await world();
    client.items.get("github.com/acme/widgets#12")!.state = "closed";
    await store.flush();
    const before = backend.count();
    const snapshot = JSON.stringify(store.listGithubLinks());
    client.fail("*", "transient");
    const r = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    await store.flush();
    assert.equal(r.corrections.length, 0);
    assert.ok(r.errors.length >= 1 && r.errors.every((e) => e.kind === "transient"));
    assert.equal(JSON.stringify(store.listGithubLinks()), snapshot);
    assert.equal(backend.count(), before);
    client.heal("*");
    assert.ok((await reconcileGithubLinks(client, store, cfg, { now: NOW })).corrections.length >= 1);
  });

  it("rate limit stops the pass, reports retry-after, changes nothing", async () => {
    const { store, client } = await world();
    client.items.get("github.com/acme/widgets#12")!.state = "closed";
    client.fail("*", "rate_limited", 30_000);
    const r = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.equal(r.status, "rate_limited");
    assert.equal(r.corrections.length, 0);
    assert.equal(r.errors[0]?.retryAfterMs, 30_000);
    assert.ok(r.skipped >= 1, "later links were not attempted");
    assert.equal(client.calls.filter((c) => c.startsWith("issue") || c.startsWith("pr")).length > 0, true);
  });

  it("fetches each target once per pass", async () => {
    const { store, client } = await world();
    client.calls.length = 0;
    await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.equal(client.calls.filter((c) => c === "pr github.com/acme/widgets#30").length, 1);
    assert.equal(client.calls.filter((c) => c === "issue github.com/acme/widgets#12").length, 1);
  });

  it("a number that is really a PR does not flip an issue link", async () => {
    const { store, client } = await world();
    client.items.set("github.com/acme/widgets#12", {
      title: "now a PR?",
      state: "closed",
      pr: { state: "open", headSha: SHA1 },
    });
    const r = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.ok(r.errors.some((e) => e.kind === "invalid"));
    assert.ok(
      store
        .listGithubLinks()
        .filter((l) => l.targetKind === "issue")
        .every((l) => l.observed.state === "open"),
    );
  });

  it("GitHub absent: inert, touches nothing", async () => {
    const { store, backend } = await world();
    const before = backend.count();
    const r = await reconcileGithubLinks(null, store, cfg, { now: NOW });
    assert.deepEqual([r.status, r.checked, r.corrections.length], ["disabled", 0, 0]);
    assert.equal(backend.count(), before);
  });

  it("replay reproduces corrected state", async () => {
    const { store, backend, client } = await world();
    client.items.get("github.com/acme/widgets#12")!.state = "closed";
    client.items.get("github.com/acme/widgets#30")!.pr!.headSha = SHA2;
    await reconcileGithubLinks(client, store, cfg, { now: NOW });
    await store.flush();
    const replayed = MissionStore.open(backend);
    assert.deepEqual(replayed.listGithubLinks(), store.listGithubLinks());
    assert.deepEqual(replayed.listGithubStaleSignals(), store.listGithubStaleSignals());
  });
});

describe("lineage through an injected sink", () => {
  it("emits nothing when no sink is configured", async () => {
    const { store, client } = await world();
    (client.items.get("github.com/acme/widgets#12") as { state: string }).state = "closed";
    await reconcileGithubLinks(client, store, cfg, { now: NOW, sink: null });
    for (const l of store.listGithubLinks()) emitLinkRecorded(null, l);
    emitDependencyEdges(null, [], new Map());
    emitCiValidation(null, ref("https://github.com/acme/widgets/pull/30"), SHA1, []);
    assert.ok(true, "no sink: nothing to observe and nothing thrown");
  });

  it("issue_link, produced and node state follow the contract", async () => {
    const { store } = await world();
    const sink = new RecordingSink();
    for (const l of store.listGithubLinks()) emitLinkRecorded(sink, l);
    const edges = sink.events.filter((e) => e[0] === "edgeAdd");
    assert.ok(edges.some((e) => e[1] === "issue_link" && e[3] === "issue:github.com/acme/widgets#12"));
    const produced = edges.find((e) => e[1] === "produced");
    assert.deepEqual([produced?.[2], produced?.[3]], ["attempt:a1", "pr:github.com/acme/widgets#30"]);
    for (const e of edges)
      assert.match(String(e[3]), /^(issue|pr):github\.com\/acme\/widgets#\d+$/, "issue_link only targets issue/pr");
  });

  it("dependency edges run dependent -> prerequisite with repo-qualified ids", () => {
    const sink = new RecordingSink();
    const items = [
      { ref: ref("acme/widgets#1"), state: "open" as const, operatorDeps: [ref("acme/api#2")] },
      { ref: ref("acme/api#2"), state: "open" as const },
    ];
    const g = buildDependencyGraph(items, { cfg });
    emitDependencyEdges(
      sink,
      g.edges,
      new Map(items.map((i) => [`${i.ref.host}/${i.ref.owner}/${i.ref.repo}#${i.ref.number}`, i.ref])),
    );
    assert.deepEqual(sink.events[0]?.slice(0, 4), [
      "edgeAdd",
      "dependency",
      "issue:github.com/acme/widgets#1",
      "issue:github.com/acme/api#2",
    ]);
    assert.deepEqual(sink.events[0]?.[5], { source: "operator", cross_repo: true });
  });

  it("validated edges only for passing checks on the exact head, bound by attrs.commit", () => {
    const sink = new RecordingSink();
    const runs: CheckRun[] = normalizeCheckRuns({
      headSha: SHA1,
      restCheckRuns: [
        { name: "build", head_sha: SHA1, status: "completed", conclusion: "success" },
        { name: "lint", head_sha: SHA1, status: "completed", conclusion: "failure" },
        { name: "stale-run", head_sha: SHA2, status: "completed", conclusion: "success" },
        { name: "queued", head_sha: SHA1, status: "queued" },
      ],
    });
    emitCiValidation(sink, ref("https://github.com/acme/widgets/pull/30"), SHA1, runs);
    const validated = sink.events.filter((e) => e[0] === "edgeAdd" && e[1] === "validated");
    assert.equal(validated.length, 1);
    assert.deepEqual(validated[0]?.[5], { commit: SHA1 });
    assert.equal(validated[0]?.[3], "pr:github.com/acme/widgets#30");
    assert.match(String(validated[0]?.[2]), /^ci:github\.com\/acme\/widgets#30@1{12}\/build$/);
    assert.ok(!sink.events.some((e) => String(e[1] ?? e[2]).includes("stale-run")));
  });

  it("drops events for unusable ids instead of guessing", () => {
    assert.equal(subjectNodeId({ kind: "task", id: "bad\nid" }), undefined);
    assert.equal(subjectNodeId({ kind: "task", id: "x".repeat(300) }), undefined);
  });
});
