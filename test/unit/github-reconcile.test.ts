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
    pr: { state: "open", headSha: SHA1, body: "Fixes #12", author: "octo-author" },
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

  it("deleted target: deactivates only after 3 consecutive 404s, never as 'closed'", async () => {
    const { store, client } = await world();
    client.items.delete("github.com/acme/widgets#12");
    for (let pass = 1; pass <= 2; pass++) {
      const r = await reconcileGithubLinks(client, store, cfg, { now: NOW });
      assert.ok(r.corrections.every((c) => c.patch.status === undefined && c.patch.notFoundCount === pass));
      assert.ok(
        store
          .listGithubLinks()
          .filter((l) => l.targetKind === "issue")
          .every((l) => l.status === "active"),
      );
    }
    const third = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.ok(third.corrections.every((c) => c.patch.status === "not_found"));
    const missing = store.listGithubLinks().filter((l) => l.status === "not_found");
    assert.ok(missing.length >= 1 && missing.every((l) => l.observed.state === "open"), "state untouched");
    assert.equal(
      (await reconcileGithubLinks(client, store, cfg, { now: NOW })).corrections.length,
      0,
      "still missing: quiet",
    );
  });

  it("a transient 404 heals: the counter resets, and a deactivated link is reactivated", async () => {
    const { store, client } = await world();
    client.failTimes("github.com/acme/widgets#12", "not_found", 2);
    await reconcileGithubLinks(client, store, cfg, { now: NOW });
    await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.ok(store.listGithubLinks().some((l) => l.notFoundCount === 2));
    const healed = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.ok(healed.corrections.length >= 1);
    assert.ok(
      store
        .listGithubLinks()
        .filter((l) => l.targetKind === "issue")
        .every((l) => l.status === "active" && !l.notFoundCount),
    );

    client.failTimes("github.com/acme/widgets#12", "not_found", 3);
    for (let i = 0; i < 3; i++) await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.ok(store.listGithubLinks().some((l) => l.status === "not_found"));
    const sink = new RecordingSink();
    await reconcileGithubLinks(client, store, cfg, { now: NOW, sink });
    assert.ok(
      store
        .listGithubLinks()
        .filter((l) => l.targetKind === "issue")
        .every((l) => l.status === "active"),
      "recovered",
    );
    assert.ok(
      sink.events.some((e) => e[0] === "edgeAdd" && e[1] === "issue_link"),
      "edge re-added on recovery",
    );
  });

  it("head A->B->A->B yields four distinct stale signals and distinct lineage transition ids", async () => {
    const { store, client } = await world();
    const pr = client.items.get("github.com/acme/widgets#30");
    assert.ok(pr?.pr);
    const sink = new RecordingSink();
    const ids = new Set<string>();
    let total = 0;
    for (const sha of [SHA2, SHA1, SHA2, SHA1]) {
      pr.pr.headSha = sha;
      const r = await reconcileGithubLinks(client, store, cfg, { now: NOW, sink });
      total += r.staleSignals.length;
      for (const sig of r.staleSignals) ids.add(sig.signalId);
    }
    assert.equal(total, 8, "two PR links x four moves");
    assert.equal(ids.size, 8);
    const upserts = sink.events.filter(
      (e) => e[0] === "nodeUpsert" && (e[2] as { attrs?: { head_sha?: string } }).attrs?.head_sha,
    );
    assert.equal(new Set(upserts.map((e) => `${e[1]}|${e[3]}`)).size, upserts.length, "no repeated transition id");
  });

  it("an abbreviated recorded SHA is the same commit, not a head change", async () => {
    const { store, client } = await world();
    const link = store.listGithubLinks().find((l) => l.targetKind === "pr");
    assert.ok(link);
    store.correctGithubLink(link.linkId, { observed: { headSha: SHA1.slice(0, 9) } }, "test: short sha");
    const r = await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.equal(r.staleSignals.length, 0);
    assert.equal(store.getGithubLink(link.linkId)?.observed.headSha, SHA1, "upgraded to the full SHA quietly");
    assert.equal((await reconcileGithubLinks(client, store, cfg, { now: NOW })).corrections.length, 0);
  });

  it("a PR body past the 8 KiB storage bound still counts; a truncated one never tombstones", async () => {
    const { store, client } = await world();
    const pr = client.items.get("github.com/acme/widgets#30");
    assert.ok(pr?.pr);
    pr.pr.body = `${"padding\n".repeat(3000)}Fixes #12\n`;
    assert.equal(
      (await reconcileGithubLinks(client, store, cfg, { now: NOW })).corrections.length,
      0,
      "closing line after 8 KiB found",
    );
    pr.pr.body = `${"padding\n".repeat(200_000)}`; // > 1 MiB: complete body unavailable
    await reconcileGithubLinks(client, store, cfg, { now: NOW });
    assert.ok(store.listGithubLinks().every((l) => l.status !== "removed"));
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

  it("the PR node carries the observed author login so Herdr can exclude the author from review quorum", async () => {
    const { store } = await world();
    const sink = new RecordingSink();
    for (const l of store.listGithubLinks()) emitLinkRecorded(sink, l);
    const upserts = sink.events.filter((e) => e[0] === "nodeUpsert");
    const prNode = upserts.find((e) => e[1] === "pr:github.com/acme/widgets#30");
    assert.equal((prNode?.[2] as { attrs?: { author?: string } }).attrs?.author, "octo-author");
    const issueNode = upserts.find((e) => e[1] === "issue:github.com/acme/widgets#12");
    assert.equal((issueNode?.[2] as { attrs?: Record<string, unknown> }).attrs?.author, undefined);
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

  it("validated edges only when the head is green, bound by attrs.commit", () => {
    const sink = new RecordingSink();
    const pr = ref("https://github.com/acme/widgets/pull/30");
    const runs: CheckRun[] = normalizeCheckRuns({
      headSha: SHA1,
      restCheckRuns: [
        { name: "build", head_sha: SHA1, status: "completed", conclusion: "success" },
        { name: "lint", head_sha: SHA1, status: "completed", conclusion: "failure" },
        { name: "stale-run", head_sha: SHA2, status: "completed", conclusion: "success" },
      ],
    });
    emitCiValidation(sink, pr, SHA1, runs);
    assert.equal(
      sink.events.filter((e) => e[0] === "edgeAdd" && e[1] === "validated").length,
      0,
      "a failing check blocks validation",
    );
    assert.ok(
      sink.events.some((e) => e[0] === "nodeUpsert" && (e[2] as { state?: string }).state === "failed"),
      "failure still visible",
    );

    const green = new RecordingSink();
    emitCiValidation(
      green,
      pr,
      SHA1,
      runs.filter((r) => r.name === "build"),
    );
    const validated = green.events.filter((e) => e[0] === "edgeAdd" && e[1] === "validated");
    assert.equal(validated.length, 1);
    assert.deepEqual(validated[0]?.[5], { commit: SHA1 });
    assert.equal(validated[0]?.[3], "pr:github.com/acme/widgets#30");
    assert.match(String(validated[0]?.[2]), /^ci:github\.com\/acme\/widgets#30@1{12}\/build~[0-9a-f]{10}$/);

    const pending = new RecordingSink();
    emitCiValidation(pending, pr, SHA1, [
      { name: "build", sha: SHA1, status: "pass" },
      { name: "slow", sha: SHA1, status: "pending" },
    ]);
    assert.equal(pending.events.filter((e) => e[1] === "validated").length, 0, "pending blocks validation");
  });

  it("required checks decide validation when configured", () => {
    const pr = ref("https://github.com/acme/widgets/pull/30");
    const runs: CheckRun[] = [
      { name: "build", sha: SHA1, status: "pass" },
      { name: "optional-lint", sha: SHA1, status: "fail" },
    ];
    const sink = new RecordingSink();
    emitCiValidation(sink, pr, SHA1, runs, {}, { required: ["build"] });
    assert.equal(sink.events.filter((e) => e[1] === "validated").length, 1);
    const missing = new RecordingSink();
    emitCiValidation(missing, pr, SHA1, runs, {}, { required: ["build", "deploy"] });
    assert.equal(missing.events.filter((e) => e[1] === "validated").length, 0, "a missing required check is not green");
  });

  it("a head is validated only when EVERY run is green: pass+pending, pass+fail and an empty head validate nothing", () => {
    const pr = ref("https://github.com/acme/widgets/pull/30");
    const count = (runs: CheckRun[], opts = {}) => {
      const sink = new RecordingSink();
      emitCiValidation(sink, pr, SHA1, runs, {}, opts);
      return sink.events.filter((e) => e[0] === "edgeAdd" && e[1] === "validated").length;
    };
    const pass: CheckRun = { name: "build", sha: SHA1, status: "pass" };
    assert.equal(count([pass, { name: "slow", sha: SHA1, status: "pending" }]), 0);
    assert.equal(count([pass, { name: "lint", sha: SHA1, status: "fail" }]), 0);
    assert.equal(count([]), 0);
    assert.equal(count([{ name: "slow", sha: SHA1, status: "pending" }]), 0);
    assert.equal(count([pass, { name: "opt", sha: SHA1, status: "skipped" }]), 1, "skipped does not block");
    assert.equal(count([pass, { name: "slow", sha: SHA1, status: "pending" }], { required: ["build"] }), 1);
    assert.equal(count([{ ...pass, sha: SHA2 }]), 0, "a pass on another head validates nothing");
  });

  it("ci node ids stay distinct for colliding sanitised names and within 200 chars", () => {
    const pr = ref("https://github.com/acme/widgets/pull/30");
    const sink = new RecordingSink();
    emitCiValidation(sink, pr, SHA1, [
      { name: "build_x", sha: SHA1, status: "fail" },
      { name: "build/x", sha: SHA1, status: "fail" },
      { name: "y".repeat(500), sha: SHA1, status: "fail" },
    ]);
    const ids = sink.events.filter((e) => e[0] === "nodeUpsert").map((e) => String(e[1]));
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids.every((id) => id.length <= 200));
    const longRepo = { ...pr, repo: "r".repeat(100), owner: "o".repeat(39) };
    const s2 = new RecordingSink();
    emitCiValidation(s2, longRepo, SHA1, [{ name: "z".repeat(500), sha: SHA1, status: "fail" }]);
    assert.ok(String(s2.events[0]?.[1]).length <= 200);
  });

  it("drops events for unusable ids instead of guessing", () => {
    assert.equal(subjectNodeId({ kind: "task", id: "bad\nid" }), undefined);
    assert.equal(subjectNodeId({ kind: "task", id: "x".repeat(300) }), undefined);
  });
});
