import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  branchIssueRef,
  closingRefs,
  confirmSuggestion,
  discoverGithubLinks,
  dismissSuggestion,
} from "../../src/github/discovery.ts";
import { linkClosingIssues, linkPullRequest, parsePrCreateOutput } from "../../src/github/prLinks.ts";
import { parseGithubRef } from "../../src/github/refs.ts";
import { suggestionIdFor } from "../../src/github/types.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { FakeGithubClient } from "../support/fakeGithubClient.ts";

const cfg = { defaultRepo: "acme/widgets" };
const NOW = () => "2026-10-23T00:00:00.000Z";

function setup() {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    title: "m",
    goal: "g",
    user_request: "g",
    repository: ".",
    base_ref: "base",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  const client = new FakeGithubClient();
  client.put("github.com/acme/widgets#12", { title: "Retry the upload", state: "open" });
  client.put("github.com/acme/widgets#13", { title: "Other thing", state: "open" });
  client.put("github.com/acme/api#4", { title: "API change", state: "closed" });
  client.put("github.com/acme/widgets#30", {
    title: "PR thirty",
    state: "open",
    pr: { state: "open", headSha: "a".repeat(40), body: "Fixes #12" },
  });
  return { backend, store, mission, client };
}
const ref = (t: string) => {
  const r = parseGithubRef(t, cfg);
  if (!r.ok) throw new Error(r.reason);
  return r.ref;
};

describe("branch and closing-keyword parsing", () => {
  it("only strict branch shapes count; digits elsewhere are ignored", () => {
    assert.equal(branchIssueRef("feat/issue-12-retry", cfg)?.strength, "explicit");
    assert.equal(branchIssueRef("gh-12", cfg)?.ref.number, 12);
    assert.equal(branchIssueRef("12-retry-uploads", cfg)?.strength, "weak");
    for (const b of [
      "feature/v2-upgrade",
      "release-2026",
      "fix-bug-12",
      "12",
      "issue-12/x/foo",
      "x".repeat(300),
      "issue-0",
      "2024-10-23-hotfix-x".replace(/^/, "a/"),
    ]) {
      const r = branchIssueRef(b, cfg);
      assert.ok(!r || r.ref.number !== 12 || b.includes("issue-12"), b);
    }
    assert.equal(branchIssueRef("issue-12", {}), undefined, "needs a default repo");
  });

  it("closing refs need a keyword and stay on the keyword's line", () => {
    const body =
      "Mentions #1\nCloses #2, fixes acme/api#4 and #5\nResolves: https://github.com/acme/widgets/issues/6 plus prose #7\n```\nFixes #8\n```";
    const nums = closingRefs(body, cfg)
      .map((r) => r.number)
      .sort();
    assert.ok(nums.includes(2) && nums.includes(4) && nums.includes(5) && nums.includes(6));
    assert.ok(!nums.includes(1) && !nums.includes(7));
  });
});

describe("discovery: explicit links vs suggestions", () => {
  it("links only explicit references, verified against GitHub", async () => {
    const { store, mission, client } = setup();
    const result = await discoverGithubLinks(
      client,
      store,
      cfg,
      {
        missionId: mission.mission_id,
        goal: "Implement the thing described in #12 and acme/api#4",
        tasks: [
          { id: "t1", title: "Do #13" },
          { id: "t2", description: "mentions #999 which does not exist" },
        ],
      },
      NOW,
    );
    assert.equal(result.status, "ok");
    assert.deepEqual(result.linked.map((l) => `${l.subject.kind}:${l.subject.id}->${l.target}`).sort(), [
      `mission:${mission.mission_id}->issue:github.com/acme/api#4`,
      `mission:${mission.mission_id}->issue:github.com/acme/widgets#12`,
      "task:t1->issue:github.com/acme/widgets#13",
    ]);
    assert.equal(result.unresolved.length, 1);
    assert.match(result.unresolved[0]?.reason ?? "", /no such/);
    assert.ok(result.linked.every((l) => l.provenance === "explicit_ref" && l.status === "active"));
    assert.equal(store.listGithubLinks(mission.mission_id).length, 3);
  });

  it("search hits are SUGGESTIONS with a reason, never links", async () => {
    const { store, mission, client } = setup();
    client.searchResults.push({ ref: { ...ref("#13"), kind: "issue" }, title: "Other thing", state: "open" });
    const result = await discoverGithubLinks(
      client,
      store,
      cfg,
      { missionId: mission.mission_id, goal: "improve upload retry handling" },
      NOW,
    );
    assert.equal(result.linked.length, 0);
    assert.equal(result.suggested.length, 1);
    assert.match(result.suggested[0]?.reason ?? "", /needs confirmation/);
    assert.equal(store.listGithubLinks(mission.mission_id).length, 0, "nothing was linked");
    assert.equal(store.listGithubSuggestions(mission.mission_id).length, 1);

    // Re-running does not duplicate the suggestion.
    const again = await discoverGithubLinks(
      client,
      store,
      cfg,
      { missionId: mission.mission_id, goal: "improve upload retry handling" },
      NOW,
    );
    assert.equal(again.suggested.length, 0);
    assert.equal(store.listGithubSuggestions().length, 1);
  });

  it("a weak branch shape is a suggestion; a prefixed one is explicit", async () => {
    const { store, mission, client } = setup();
    const weak = await discoverGithubLinks(
      client,
      store,
      cfg,
      { missionId: mission.mission_id, goal: "x", branch: "13-other" },
      NOW,
    );
    assert.equal(weak.linked.length, 0);
    assert.equal(weak.suggested.length, 1);
    const strong = await discoverGithubLinks(
      client,
      store,
      cfg,
      { missionId: mission.mission_id, goal: "x", branch: "feat/issue-12-retry" },
      NOW,
    );
    assert.deepEqual(
      strong.linked.map((l) => l.source),
      ["branch"],
    );
  });

  it("operator and AutoSpec mappings link, with their provenance; bad mappings are reported", async () => {
    const { store, mission, client } = setup();
    const result = await discoverGithubLinks(
      client,
      store,
      cfg,
      {
        missionId: mission.mission_id,
        goal: "no refs here",
        mappings: [
          { subject: { kind: "task", id: "t9" }, ref: "https://github.com/acme/widgets/issues/12" },
          { subject: { kind: "task", id: "t8" }, ref: "acme/api#4", provenance: "autospec" },
          { subject: { kind: "task", id: "t7" }, ref: "not a ref; rm -rf /" },
        ],
      },
      NOW,
    );
    assert.deepEqual(result.linked.map((l) => l.provenance).sort(), ["autospec", "operator"]);
    assert.equal(result.unresolved.length, 1);
  });

  it("confirmation turns a suggestion into a link with confirmed provenance; dismissal does not", async () => {
    const { store, mission, client } = setup();
    client.searchResults.push({ ref: { ...ref("#13"), kind: "issue" }, title: "Other thing", state: "open" });
    const { suggested } = await discoverGithubLinks(
      client,
      store,
      cfg,
      { missionId: mission.mission_id, goal: "improve upload retry" },
      NOW,
    );
    const id = suggested[0]?.suggestionId as string;
    const link = await confirmSuggestion(client, store, cfg, id, NOW);
    assert.equal(link?.provenance, "confirmed_suggestion");
    assert.equal(store.getGithubSuggestion(id)?.state, "confirmed");
    assert.equal(await confirmSuggestion(client, store, cfg, id, NOW), undefined, "only once");
    assert.equal(dismissSuggestion(store, id), false);
  });

  it("API errors link nothing and are reported", async () => {
    const { store, mission, client } = setup();
    client.fail("*", "rate_limited");
    const result = await discoverGithubLinks(
      client,
      store,
      cfg,
      { missionId: mission.mission_id, goal: "see #12" },
      NOW,
    );
    assert.equal(result.linked.length, 0);
    assert.equal(result.errors[0]?.kind, "rate_limited");
    assert.equal(store.listGithubLinks().length, 0);
  });

  it("GitHub absent: inert, no calls, no events", async () => {
    const { store, mission, backend } = setup();
    await store.flush();
    const before = backend.count();
    const result = await discoverGithubLinks(null, store, cfg, { missionId: mission.mission_id, goal: "see #12" }, NOW);
    assert.deepEqual([result.status, result.linked, result.suggested], ["disabled", [], []]);
    assert.equal(await confirmSuggestion(null, store, cfg, "x"), undefined);
    assert.deepEqual(
      await linkPullRequest(null, store, {
        missionId: mission.mission_id,
        prRef: ref("#30"),
        subjects: [{ kind: "task", id: "t" }],
      }),
      [],
    );
    await store.flush();
    assert.equal(backend.count(), before);
  });

  it("hostile issue text is stored bounded and redacted", async () => {
    const { store, mission } = setup();
    const token = `ghp_${"y".repeat(36)}`;
    const hostile = new FakeGithubClient();
    hostile.put("github.com/acme/widgets#12", { title: `$(rm -rf /) ${token} ${"T".repeat(5000)}`, state: "open" });
    // The fake returns what a client would after sanitising; assert the store never holds raw hostile text via the real client path elsewhere.
    const { GhCliClient } = await import("../../src/github/client.ts");
    const real = new GhCliClient({ enabled: true, defaultRepo: "acme/widgets" }, async () => ({
      stdout: JSON.stringify({ number: 12, state: "open", title: `$(rm -rf /) ${token} ${"T".repeat(5000)}` }),
      stderr: "",
      code: 0,
    }));
    const result = await discoverGithubLinks(real, store, cfg, { missionId: mission.mission_id, goal: "#12" }, NOW);
    const title = result.linked[0]?.observed.title ?? "";
    assert.ok(!title.includes(token));
    assert.ok(title.length <= 200);
  });
});

describe("PR linkage", () => {
  it("parses the gh pr create output only when it names exactly one PR", () => {
    assert.equal(
      parsePrCreateOutput("Creating pull request...\nhttps://github.com/acme/widgets/pull/30\n", cfg)?.number,
      30,
    );
    assert.equal(
      parsePrCreateOutput("https://github.com/acme/widgets/pull/30\nhttps://github.com/acme/widgets/pull/31", cfg),
      undefined,
    );
    assert.equal(parsePrCreateOutput("no url", cfg), undefined);
    assert.equal(parsePrCreateOutput("https://github.com/acme/widgets/issues/30", cfg), undefined);
  });

  it("links task, attempt and commit to the PR and records the head SHA", async () => {
    const { store, mission, client } = setup();
    const links = await linkPullRequest(
      client,
      store,
      {
        missionId: mission.mission_id,
        prRef: ref("https://github.com/acme/widgets/pull/30"),
        subjects: [
          { kind: "task", id: "t1" },
          { kind: "attempt", id: "a1" },
          { kind: "commit", id: "b".repeat(40) },
        ],
      },
      NOW,
    );
    assert.equal(links.length, 3);
    assert.ok(
      links.every(
        (l) =>
          l.target === "pr:github.com/acme/widgets#30" &&
          l.observed.headSha === "a".repeat(40) &&
          l.observed.state === "open",
      ),
    );
  });

  it("works without a client when the caller supplies the head SHA; refuses an unverifiable one", async () => {
    const { store, mission } = setup();
    const pr = ref("https://github.com/acme/widgets/pull/30");
    assert.equal(
      (
        await linkPullRequest(
          null,
          store,
          { missionId: mission.mission_id, prRef: pr, subjects: [{ kind: "task", id: "t1" }], headSha: "c".repeat(40) },
          NOW,
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await linkPullRequest(
          null,
          store,
          { missionId: mission.mission_id, prRef: pr, subjects: [{ kind: "task", id: "t2" }], headSha: "zz" },
          NOW,
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await linkPullRequest(
          null,
          store,
          {
            missionId: mission.mission_id,
            prRef: ref("#30"),
            subjects: [{ kind: "task", id: "t3" }],
            headSha: "c".repeat(40),
          },
          NOW,
        )
      ).length,
      0,
      "unknown kind is never defaulted to pr",
    );
  });

  it("rejects an unverified short SHA and a PR GitHub says does not exist", async () => {
    const { store, mission, client } = setup();
    const pr = ref("https://github.com/acme/widgets/pull/30");
    assert.equal(
      (
        await linkPullRequest(
          null,
          store,
          { missionId: mission.mission_id, prRef: pr, subjects: [{ kind: "task", id: "t1" }], headSha: "abc1234" },
          NOW,
        )
      ).length,
      0,
      "short SHA without a client",
    );
    const ghost = ref("https://github.com/acme/widgets/pull/404");
    assert.equal(
      (
        await linkPullRequest(
          client,
          store,
          {
            missionId: mission.mission_id,
            prRef: ghost,
            subjects: [{ kind: "task", id: "t1" }],
            headSha: "d".repeat(40),
          },
          NOW,
        )
      ).length,
      0,
      "404 beats a caller-supplied SHA",
    );
    client.fail("github.com/acme/widgets#30", "transient");
    assert.equal(
      (
        await linkPullRequest(
          client,
          store,
          { missionId: mission.mission_id, prRef: pr, subjects: [{ kind: "task", id: "t1" }], headSha: "d".repeat(40) },
          NOW,
        )
      ).length,
      1,
      "transient error keeps explicit caller data for later reconciliation",
    );
  });

  it("a closing keyword for ANOTHER repo becomes a suggestion, never a link", async () => {
    const { store, mission, client } = setup();
    client.put("github.com/victim/secret#5", { title: "Private-ish", state: "open" });
    const links = await linkClosingIssues(
      client,
      store,
      cfg,
      {
        missionId: mission.mission_id,
        prRef: ref("https://github.com/acme/widgets/pull/30"),
        prBody: "Fixes #12 and fixes victim/secret#5",
        subjects: [{ kind: "task", id: "t1" }],
      },
      NOW,
    );
    assert.deepEqual(
      links.map((l) => l.target),
      ["issue:github.com/acme/widgets#12"],
    );
    const s = store.listGithubSuggestions(mission.mission_id);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.target, "issue:github.com/victim/secret#5");
    assert.match(s[0]?.reason ?? "", /another repository/);
  });

  it("closing refs after 8 KiB are found, and a truncated body's last line is never read", () => {
    assert.deepEqual(
      closingRefs(`${"x\n".repeat(9000)}Fixes #12\n`, cfg).map((r) => r.number),
      [12],
    );
    assert.deepEqual(
      closingRefs("Fixes #12\nFixes #1", cfg, { truncated: true }).map((r) => r.number),
      [12],
    );
  });

  it("a suggestion is skipped when the subject is already linked to that target", async () => {
    const { store, mission, client } = setup();
    const link = await linkPullRequest(
      client,
      store,
      {
        missionId: mission.mission_id,
        prRef: ref("https://github.com/acme/widgets/pull/30"),
        subjects: [{ kind: "mission", id: mission.mission_id }],
      },
      NOW,
    );
    assert.equal(link.length, 1);
    const got = store.suggestGithubLink({
      suggestionId: suggestionIdFor(mission.mission_id, { kind: "mission", id: mission.mission_id }, link[0]!.target),
      missionId: mission.mission_id,
      subject: { kind: "mission", id: mission.mission_id },
      target: link[0]!.target,
      targetKind: "pr",
      reason: "r",
      title: "t",
      state: "pending",
      recordedAt: NOW(),
    });
    assert.equal(got, undefined);
    assert.equal(store.listGithubSuggestions().length, 0);
  });

  it("links closing issues of a PR body and remembers the PR", async () => {
    const { store, mission, client } = setup();
    const links = await linkClosingIssues(
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
    assert.equal(links[0]?.viaPr, "pr:github.com/acme/widgets#30");
  });
});

describe("persistence through the mission store", () => {
  it("links, suggestions and corrections survive replay; re-recording is idempotent", async () => {
    const { store, backend, mission, client } = setup();
    client.searchResults.push({ ref: { ...ref("#13"), kind: "issue" }, title: "Other thing", state: "open" });
    await discoverGithubLinks(
      client,
      store,
      cfg,
      { missionId: mission.mission_id, goal: "improve upload retry; see #12" },
      NOW,
    );
    const link = store.listGithubLinks()[0];
    assert.ok(link);
    await store.flush();
    const countBefore = backend.count();
    store.recordGithubLink(link);
    await store.flush();
    assert.equal(backend.count(), countBefore, "identical active link emits nothing");
    assert.equal(store.correctGithubLink(link.linkId, { observed: { state: "closed" } }, "issue closed"), true);
    assert.equal(store.correctGithubLink(link.linkId, { observed: { state: "closed" } }, "issue closed"), false);
    await store.flush();

    const replayed = MissionStore.open(backend);
    assert.deepEqual(replayed.listGithubLinks(), store.listGithubLinks());
    assert.deepEqual(replayed.listGithubSuggestions(), store.listGithubSuggestions());
    assert.equal(replayed.getGithubLink(link.linkId)?.observed.state, "closed");
  });

  it("refuses links for an unknown mission", () => {
    const { store } = setup();
    assert.throws(() =>
      store.recordGithubLink({
        linkId: "x",
        missionId: "nope",
        subject: { kind: "mission", id: "nope" },
        target: "issue:github.com/a/b#1",
        targetKind: "issue",
        provenance: "operator",
        source: "operator",
        observed: {},
        status: "active",
        recordedAt: NOW(),
      }),
    );
  });
});
