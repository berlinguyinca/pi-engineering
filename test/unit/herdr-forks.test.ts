import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { CliForkGit, type ForkGit } from "../../src/git/forkGit.ts";
import { GhCliClient, type GhRunner } from "../../src/github/client.ts";
import type { GithubLinkStore } from "../../src/github/discovery.ts";
import { parseGithubRef } from "../../src/github/refs.ts";
import { parseForkParams } from "../../src/orchestration/forkParams.ts";
import {
  type ForkLineage,
  ForkManager,
  type ForkOrigin,
  ForkRegistry,
  type PromoteDeps,
  forkIdFor,
} from "../../src/orchestration/forks.ts";
import {
  MemorySteeringLedger,
  type SteeringItem,
  type SteeringPorts,
  applySteering,
  parseSteeringItem,
} from "../../src/orchestration/steering.ts";
import { loadForkSettings } from "../../src/runtime/herdr/forkSettings.ts";
import { type ForkRuntimeSources, createForkRuntime } from "../../src/runtime/herdr/forkWiring.ts";
import { FakeGithubClient } from "../support/fakeGithubClient.ts";

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
const tmp = (): string => mkdtempSync(join(tmpdir(), "pi-fork-"));

/** A real repository with a bare `origin`, so push, ls-remote and worktrees are exercised for real. */
function mkRepo(): { root: string; origin: string; base: string } {
  const parent = tmp();
  const origin = join(parent, "origin.git");
  const root = join(parent, "repo");
  mkdirSync(root);
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  sh(root, "init", "-b", "main");
  sh(root, "config", "user.email", "t@example.invalid");
  sh(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "one\n");
  sh(root, "add", ".");
  sh(root, "commit", "-m", "base");
  sh(root, "remote", "add", "origin", origin);
  sh(root, "push", "origin", "main");
  return { root, origin, base: sh(root, "rev-parse", "HEAD") };
}

class Lineage implements ForkLineage {
  readonly ev: Array<[string, ...unknown[]]> = [];
  nodeUpsert(...a: Parameters<ForkLineage["nodeUpsert"]>): void {
    this.ev.push(["nodeUpsert", ...a]);
  }
  nodeState(...a: Parameters<ForkLineage["nodeState"]>): void {
    this.ev.push(["nodeState", ...a]);
  }
  edgeAdd(...a: Parameters<ForkLineage["edgeAdd"]>): void {
    this.ev.push(["edgeAdd", ...a]);
  }
  edgeRemove(...a: Parameters<ForkLineage["edgeRemove"]>): void {
    this.ev.push(["edgeRemove", ...a]);
  }
  edges(type: string): Array<unknown[]> {
    return this.ev.filter((e) => e[0] === "edgeAdd" && e[1] === type);
  }
}

class Store implements GithubLinkStore {
  readonly links: unknown[] = [];
  recordGithubLink(r: Parameters<GithubLinkStore["recordGithubLink"]>[0]) {
    const rec = { ...r, epoch: 0 };
    this.links.push(rec);
    return rec;
  }
  suggestGithubLink() {
    return undefined;
  }
  resolveGithubSuggestion() {
    return false;
  }
  getGithubSuggestion() {
    return undefined;
  }
  listGithubLinks() {
    return [];
  }
}

/** The fake GitHub plus the two methods promotion needs. It never has a merge method, so nothing can merge. */
class PrClient extends FakeGithubClient {
  created: Array<{ head: string; base: string; title: string; body: string; draft: boolean }> = [];
  headShaOf: (branch: string) => string;
  existing: string | null = null;
  constructor(headShaOf: (b: string) => string) {
    super();
    this.headShaOf = headShaOf;
  }
  async findOpenPullRequestByHead(repo: { host: string; owner: string; repo: string }, branch: string) {
    if (!this.existing) return null;
    return this.getPullRequest({ ...repo, number: 5, kind: "pr" });
  }
  async createPullRequest(input: {
    repo: { host: string; owner: string; repo: string };
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }) {
    this.created.push({ head: input.head, base: input.base, title: input.title, body: input.body, draft: input.draft });
    this.put(`${input.repo.host}/${input.repo.owner}/${input.repo.repo}#7`, {
      title: input.title,
      state: "open",
      pr: { state: "open", headSha: this.headShaOf(input.head), body: input.body },
    });
    return this.getPullRequest({ ...input.repo, number: 7, kind: "pr" });
  }
}

const SHA = (c: string): string => c.repeat(40);
const item = (over: Partial<SteeringItem> & { action: SteeringItem["action"] }): SteeringItem => ({
  steeringId: "st-1",
  nodeId: "task:t1",
  instruction: null,
  proposedBy: "bob",
  confirmedBy: "alice",
  room: "room-a",
  validUntilEpoch: 9_999_999_999,
  fence: "f",
  expectedDigest: null,
  ...over,
});

function setup(
  opts: {
    promote?: boolean;
    limits?: Partial<{ maxTotal: number; maxPerOrigin: number; minFreeMb: number }>;
    git?: (g: ForkGit) => ForkGit;
  } = {},
) {
  const r = mkRepo();
  const state = tmp();
  const lineage = new Lineage();
  const store = new Store();
  const client = new PrClient((b) => {
    try {
      return sh(r.origin, "rev-parse", `refs/heads/${b}`);
    } catch {
      return SHA("0");
    }
  });
  const promote: PromoteDeps | null = opts.promote
    ? {
        client,
        store,
        refCfg: { defaultRepo: "acme/widgets" },
        draft: true,
        defaultRepo: { host: "github.com", owner: "acme", repo: "widgets" },
      }
    : null;
  const registry = new ForkRegistry(join(state, "forks.json"));
  const mgr = new ForkManager({
    registry,
    git: (root) => (opts.git ? opts.git(new CliForkGit(root)) : new CliForkGit(root)),
    lineage,
    limits: { maxTotal: 6, maxPerOrigin: 3, minFreeMb: 0, ...opts.limits },
    promote,
    originUrl: async () => "https://github.com/acme/widgets.git",
  });
  const origin: ForkOrigin = { nodeId: "task:t1", missionId: "m1", taskId: "t1", repoRoot: r.root, baseBranch: "main" };
  return { ...r, bare: r.origin, state, lineage, store, client, registry, mgr, origin };
}

async function fork(s: ReturnType<typeof setup>, n: number, label = "alt") {
  const a = await s.mgr.create(
    item({ action: "fork", steeringId: `st-${n}`, params: { baseSha: s.base, label } }),
    s.origin,
  );
  assert.equal(a.outcome, "applied", a.note);
  const id = forkIdFor(`st-${n}`);
  return { id, rec: s.registry.get(id)!, node: `approach:${id}` };
}
const commit = (path: string, file: string, text: string): string => {
  writeFileSync(join(path, file), text);
  sh(path, "add", ".");
  sh(path, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-m", `edit ${file}`);
  return sh(path, "rev-parse", "HEAD");
};

describe("fork parameters are typed and strict", () => {
  it("accepts only the documented fields", () => {
    assert.deepEqual(parseForkParams("fork", { base_sha: SHA("a"), label: "x" }), { baseSha: SHA("a"), label: "x" });
    assert.equal(parseForkParams("fork", { base_sha: "main" }), null);
    assert.equal(parseForkParams("fork", { base_sha: SHA("a"), branch: "x" }), null);
    assert.equal(parseForkParams("fork", { base_sha: SHA("a"), path: "/etc" }), null);
    assert.equal(parseForkParams("fork", { base_sha: SHA("A") }), null);
    assert.equal(parseForkParams("fork", { base_sha: `${SHA("a")}x` }), null);
    assert.equal(parseForkParams("fork", {}), null);
    assert.equal(parseForkParams("promote", { expected_head: SHA("b"), argv: ["x"] }), null);
    assert.equal(parseForkParams("promote", { expected_head: SHA("b"), siblings: ["task:x"] }), null);
    assert.equal(parseForkParams("promote", { expected_head: SHA("b"), siblings: Array(21).fill("approach:a") }), null);
    assert.deepEqual(
      parseForkParams("promote", {
        expected_head: SHA("b"),
        origin: "task:t1",
        head: SHA("b"),
        siblings: ["approach:a", "approach:a"],
      }),
      {
        expectedHead: SHA("b"),
        origin: "task:t1",
        head: SHA("b"),
        siblings: ["approach:a"],
      },
    );
  });
  it("strips spoofing characters from the label", () => {
    assert.equal(parseForkParams("fork", { base_sha: SHA("a"), label: "a‮b\n​c\x00" })?.label, "a b c");
    assert.equal(parseForkParams("fork", { base_sha: SHA("a"), label: "z".repeat(500) })?.label?.length, 80);
  });
  it("the steering parser refuses fork/promote without valid params and other actions with params", () => {
    const wire = (over: Record<string, unknown>) => ({
      steering_id: "s1",
      action: "fork",
      target: { node_id: "task:t1" },
      instruction: null,
      proposed_by: { id: "bob" },
      confirmed_by: { id: "alice" },
      room: { id: "r" },
      trust: "untrusted",
      valid_until_epoch: 5,
      params: { base_sha: SHA("a") },
      ...over,
    });
    assert.equal(parseSteeringItem(wire({}))?.params?.baseSha, SHA("a"));
    assert.equal(parseSteeringItem(wire({ params: undefined })), null);
    assert.equal(parseSteeringItem(wire({ params: { base_sha: "HEAD" } })), null);
    assert.equal(parseSteeringItem(wire({ action: "pause", params: { base_sha: SHA("a") } })), null);
    assert.notEqual(parseSteeringItem(wire({ action: "pause", params: {} })), null);
  });
});

describe("the exact deliveries Herdr's control plane produces (captured from test_forks.py)", () => {
  const common = {
    trust: "untrusted",
    provenance: "herdr-steering/v1 (human-proposed, owner-confirmed, delivered by Herdr)",
    room: { id: "room_01m5md867m00006g0jk2ya9exr", name: "r" },
    instruction: null,
    instruction_trust: "untrusted_text_from_proposed_by",
    proposed_by: { type: "user", id: "bob", at: "2027-01-15T08:00:00+00:00" },
    confirmed_by: { type: "user", id: "alice", at_epoch: 1800000000.0 },
    valid_until_epoch: 1800000300.0,
    delivery: 1,
  };
  it("a fork with a label, a fork with an empty label, and a promote all parse", () => {
    const fork = parseSteeringItem({
      ...common,
      steering_id: "collab_01m5md868a00006ktpjtp2xz7e",
      idempotency_key: "collab_01m5md868a00006ktpjtp2xz7e",
      action: "fork",
      target: { node_id: "attempt:a1", node_type: "attempt", fence: "e446", expected_digest: null },
      params: { base_sha: SHA("a"), label: "alt one", origin: "attempt:a1" },
    });
    assert.deepEqual(fork?.params, { baseSha: SHA("a"), label: "alt one", origin: "attempt:a1" });
    const empty = parseSteeringItem({
      ...common,
      steering_id: "collab_01m5md868j00006nhckdbngpks",
      idempotency_key: "collab_01m5md868j00006nhckdbngpks",
      action: "fork",
      target: { node_id: "attempt:a1", node_type: "attempt", fence: "e446", expected_digest: null },
      params: { base_sha: SHA("a"), label: "", origin: "attempt:a1" },
    });
    assert.equal(empty?.params?.baseSha, SHA("a"));
    const promo = parseSteeringItem({
      ...common,
      steering_id: "collab_01m5md869200006rx0yk9pg3jh",
      idempotency_key: "collab_01m5md869200006rx0yk9pg3jh",
      action: "promote",
      target: { node_id: "approach:f1", node_type: "approach", fence: "c000", expected_digest: null },
      params: { expected_head: SHA("b"), origin: "attempt:a1", head: SHA("b"), siblings: [] },
    });
    assert.equal(promo?.params?.expectedHead, SHA("b"));
    assert.equal(promo?.nodeId, "approach:f1");
  });
});

describe("fork creation", () => {
  it("creates an isolated branch and worktree at the chosen commit and leaves the original untouched", async () => {
    const s = setup();
    const mainBefore = sh(s.root, "rev-parse", "main");
    const f = await fork(s, 1, "try a queue");
    assert.equal(f.rec.status, "active");
    assert.match(f.rec.branch, /^pi-fork\/fk-[0-9a-f]{16}$/);
    assert.ok(existsSync(f.rec.worktreePath));
    assert.equal(sh(f.rec.worktreePath, "rev-parse", "HEAD"), s.base);
    assert.equal(sh(f.rec.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"), f.rec.branch);
    assert.equal(sh(s.root, "rev-parse", "main"), mainBefore);
    assert.equal(sh(s.root, "status", "--porcelain"), "");
    assert.ok(!f.rec.worktreePath.includes(`${s.root}/`), "the worktree is a sibling, not inside the checkout");
    // lineage: approach node with the base, a fork edge from the origin, nothing invented
    const up = s.lineage.ev.find((e) => e[0] === "nodeUpsert" && e[1] === f.node) as unknown[];
    assert.equal((up[2] as { attrs: Record<string, unknown> }).attrs.base_sha, s.base);
    assert.equal((up[2] as { attrs: Record<string, unknown> }).attrs.origin_id, "task:t1");
    const fe = s.lineage.edges("fork")[0] as unknown[];
    assert.deepEqual([fe[2], fe[3]], ["task:t1", f.node]);
  });

  it("derives every name itself: nothing in the request can name a branch or a path", async () => {
    const s = setup();
    const a = await s.mgr.create(
      item({
        action: "fork",
        params: { baseSha: s.base, label: "../../etc/passwd; rm -rf /" },
        nodeId: "task:../../x",
      }),
      { ...s.origin, nodeId: "task:../../x" },
    );
    assert.equal(a.outcome, "applied");
    const rec = s.registry.list()[0]!;
    assert.match(rec.branch, /^pi-fork\/fk-[0-9a-f]{16}$/);
    assert.match(rec.worktreePath, /pi-fork-[0-9a-z]+-fk-[0-9a-f]{16}$/);
    assert.equal(dirname(rec.worktreePath), dirname(s.root));
  });

  it("is idempotent for a redelivery and creates exactly one worktree", async () => {
    const s = setup();
    await fork(s, 1);
    const again = await s.mgr.create(
      item({ action: "fork", steeringId: "st-1", params: { baseSha: s.base } }),
      s.origin,
    );
    assert.equal(again.outcome, "applied");
    assert.equal(s.registry.list().length, 1);
  });

  it("refuses rather than delete: an existing path or branch is never replaced", async () => {
    const s = setup();
    const id = forkIdFor("st-9");
    const path = join(dirname(s.root), `pi-fork-${(await import("../../src/git/GitRepo.ts")).shortHash(s.root)}-${id}`);
    mkdirSync(path);
    writeFileSync(join(path, "precious.txt"), "do not delete");
    const a = await s.mgr.create(item({ action: "fork", steeringId: "st-9", params: { baseSha: s.base } }), s.origin);
    assert.equal(a.outcome, "refused");
    assert.equal(readFileSync(join(path, "precious.txt"), "utf8"), "do not delete");
    // an existing branch of that name
    const s2 = setup();
    sh(s2.root, "branch", `pi-fork/${forkIdFor("st-9")}`);
    const b = await s2.mgr.create(
      item({ action: "fork", steeringId: "st-9", params: { baseSha: s2.base } }),
      s2.origin,
    );
    assert.equal(b.outcome, "refused");
    assert.equal(sh(s2.root, "rev-parse", "--verify", `pi-fork/${forkIdFor("st-9")}`), s2.base);
    assert.equal(s2.registry.get(forkIdFor("st-9"))?.status, "failed");
  });

  it("refuses a commit that is not in the repository, and an unresolvable origin", async () => {
    const s = setup();
    const a = await s.mgr.create(item({ action: "fork", params: { baseSha: SHA("e") } }), s.origin);
    assert.deepEqual([a.outcome, a.note], ["refused", "that commit is not in this repository"]);
    const b = await s.mgr.create(item({ action: "fork", params: { baseSha: s.base } }), {
      unresolvable: "no repo here",
    });
    assert.equal(b.outcome, "refused");
    assert.equal(s.registry.list().length, 0);
  });

  it("flood and disk limits: per origin, in total, and free space", async () => {
    const s = setup({ limits: { maxPerOrigin: 2, maxTotal: 3 } });
    await fork(s, 1);
    await fork(s, 2);
    const third = await s.mgr.create(
      item({ action: "fork", steeringId: "st-3", params: { baseSha: s.base } }),
      s.origin,
    );
    assert.equal(third.outcome, "refused");
    assert.match(third.note, /origin has reached its fork limit/);
    const other: ForkOrigin = { ...s.origin, nodeId: "task:t2", taskId: "t2" };
    assert.equal(
      (
        await s.mgr.create(
          item({ action: "fork", steeringId: "st-4", nodeId: "task:t2", params: { baseSha: s.base } }),
          other,
        )
      ).outcome,
      "applied",
    );
    const fifth = await s.mgr.create(
      item({ action: "fork", steeringId: "st-5", nodeId: "task:t3", params: { baseSha: s.base } }),
      { ...other, nodeId: "task:t3" },
    );
    assert.match(fifth.note, /fork limit/);
    assert.equal(s.registry.list().filter((r) => r.status === "active").length, 3);
    const low = setup({
      limits: { minFreeMb: 1 },
      git: (g) => Object.assign(Object.create(g), { freeDiskMb: () => 0 }),
    });
    const d = await low.mgr.create(item({ action: "fork", params: { baseSha: low.base } }), low.origin);
    assert.match(d.note, /not enough free disk/);
    assert.equal(low.registry.list().length, 0);
  });

  it("reports a new head and diff only from its own git state", async () => {
    const s = setup();
    const f = await fork(s, 1);
    const head = commit(f.rec.worktreePath, "b.txt", "two\nlines\n");
    await s.mgr.refreshAll();
    const last = [...s.lineage.ev].reverse().find((e) => e[0] === "nodeUpsert" && e[1] === f.node) as unknown[];
    const attrs = (last[2] as { attrs: Record<string, unknown> }).attrs;
    assert.equal(attrs.head_sha, head);
    assert.deepEqual([attrs.files_changed, attrs.insertions, attrs.deletions], [1, 2, 0]);
    assert.deepEqual(attrs.touched_paths, ["b.txt"]);
    const n = s.lineage.ev.length;
    await s.mgr.refreshAll();
    assert.equal(s.lineage.ev.length, n, "unchanged head: nothing re-sent");
  });

  it("a registry that cannot be parsed stops everything and is never replaced", async () => {
    const s = setup();
    await fork(s, 1);
    writeFileSync(join(s.state, "forks.json"), "{not json");
    const a = await s.mgr
      .create(item({ action: "fork", steeringId: "st-2", params: { baseSha: s.base } }), s.origin)
      .catch((e: Error) => e);
    assert.ok(a instanceof Error || (a as { outcome: string }).outcome === "refused");
    assert.equal(readFileSync(join(s.state, "forks.json"), "utf8"), "{not json");
  });
});

describe("promotion", () => {
  const prep = async (n = 1) => {
    const s = setup({ promote: true });
    const f = await fork(s, n);
    const head = commit(f.rec.worktreePath, "b.txt", "feature\n");
    return { s, f, head };
  };
  const promote = (s: ReturnType<typeof setup>, f: { node: string }, head: string, extra: Partial<SteeringItem> = {}) =>
    s.mgr.promote(
      item({
        action: "promote",
        steeringId: "pr-1",
        nodeId: f.node,
        params: { expectedHead: head, origin: "task:t1", siblings: [] },
        ...extra,
      }),
    );

  it("pushes exactly the confirmed commit, opens a DRAFT PR, links it and merges nothing", async () => {
    const { s, f, head } = await prep();
    const sib = await fork(s, 2, "other");
    const a = await promote(s, f, head);
    assert.equal(a.outcome, "applied", a.note);
    assert.equal(sh(s.bare, "rev-parse", `refs/heads/${f.rec.branch}`), head);
    assert.equal(sh(s.bare, "rev-parse", "main"), s.base, "main on origin did not move");
    assert.equal(s.client.created.length, 1);
    assert.equal(s.client.created[0]!.draft, true);
    assert.equal(s.client.created[0]!.base, "main");
    assert.equal(s.client.created[0]!.head, f.rec.branch);
    assert.ok(!Object.keys(Object.getPrototypeOf(s.client)).some((k) => /merge|close|delete/i.test(k)));
    assert.equal(s.store.links.length, 1);
    assert.equal(s.registry.get(f.id)?.status, "selected");
    assert.match(s.registry.get(f.id)?.pr ?? "", /^pr:github\.com\/acme\/widgets#7$/);
    // siblings are only MARKED: record, lineage state and a supersession edge. Branch and worktree stay.
    assert.equal(s.registry.get(sib.id)?.status, "superseded");
    assert.ok(existsSync(sib.rec.worktreePath));
    assert.equal(sh(s.root, "rev-parse", "--verify", sib.rec.branch), s.base);
    const sup = s.lineage.edges("supersession").map((e) => [e[2], e[3]]);
    assert.deepEqual(sup, [[f.node, sib.node]]);
    assert.ok(s.lineage.ev.some((e) => e[0] === "nodeState" && e[1] === sib.node && e[2] === "superseded"));
    assert.ok(
      s.lineage.ev.some(
        (e) => e[0] === "nodeUpsert" && e[1] === f.node && (e[2] as { state?: string }).state === "selected",
      ),
    );
    assert.ok(s.lineage.edges("produced").some((e) => e[2] === f.node && String(e[3]).startsWith("pr:")));
    assert.match(a.note, /Nothing was merged/);
  });

  it("refuses a head other than the confirmed one and pushes nothing", async () => {
    const { s, f, head } = await prep();
    const moved = commit(f.rec.worktreePath, "c.txt", "later\n");
    const a = await promote(s, f, head);
    assert.equal(a.outcome, "stale");
    assert.notEqual(moved, head);
    assert.throws(() => sh(s.bare, "rev-parse", "--verify", `refs/heads/${f.rec.branch}`));
    assert.equal(s.registry.get(f.id)?.status, "active", "the claim is released");
    assert.equal(s.client.created.length, 0);
  });

  it("refuses uncommitted work instead of committing or discarding it", async () => {
    const { s, f, head } = await prep();
    writeFileSync(join(f.rec.worktreePath, "wip.txt"), "unsaved");
    const a = await promote(s, f, head);
    assert.equal(a.outcome, "refused");
    assert.equal(readFileSync(join(f.rec.worktreePath, "wip.txt"), "utf8"), "unsaved");
    assert.equal(sh(f.rec.worktreePath, "rev-parse", "HEAD"), head);
  });

  it("never overwrites a remote branch that has other content", async () => {
    const { s, f, head } = await prep();
    // someone put different content on that exact branch name on origin
    sh(s.root, "branch", "decoy", s.base);
    const decoy = sh(s.root, "rev-parse", "decoy");
    sh(s.root, "push", "origin", `decoy:refs/heads/${f.rec.branch}`);
    const a = await promote(s, f, head);
    assert.equal(a.outcome, "refused");
    assert.equal(sh(s.bare, "rev-parse", `refs/heads/${f.rec.branch}`), decoy);
    assert.equal(s.client.created.length, 0);
  });

  it("only one promotion per origin: a second sibling is refused while the first holds the claim or won", async () => {
    const { s, f, head } = await prep();
    const g = await fork(s, 2);
    const head2 = commit(g.rec.worktreePath, "d.txt", "other\n");
    const [one, two] = await Promise.all([promote(s, f, head), promote(s, g, head2, { steeringId: "pr-2" })]);
    assert.deepEqual([one.outcome, two.outcome].sort(), ["applied", "refused"]);
    const winner = one.outcome === "applied" ? f : g;
    const loser = winner === f ? g : f;
    assert.equal(s.registry.get(winner.id)?.status, "selected");
    assert.notEqual(s.registry.get(loser.id)?.status, "selected");
    assert.equal(s.client.created.length, 1);
    // and later, too
    const later = await promote(s, loser, loser === f ? head : head2, { steeringId: "pr-3" });
    assert.equal(later.outcome, "refused");
  });

  it("two processes sharing a state dir cannot both claim the same origin", async () => {
    const { s, f, head } = await prep();
    const g = await fork(s, 2);
    const head2 = commit(g.rec.worktreePath, "d.txt", "other\n");
    const second = new ForkManager({
      registry: new ForkRegistry(join(s.state, "forks.json")),
      git: (root) => new CliForkGit(root),
      lineage: new Lineage(),
      limits: { maxTotal: 6, maxPerOrigin: 3, minFreeMb: 0 },
      promote: {
        client: s.client,
        store: s.store,
        refCfg: { defaultRepo: "acme/widgets" },
        draft: true,
        defaultRepo: { host: "github.com", owner: "acme", repo: "widgets" },
      },
      originUrl: async () => "https://github.com/acme/widgets.git",
    });
    const results = await Promise.all([
      promote(s, f, head),
      second.promote(item({ action: "promote", steeringId: "pr-2", nodeId: g.node, params: { expectedHead: head2 } })),
    ]);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ["applied", "refused"]);
  });

  it("is idempotent once promoted, and never promotes from another room", async () => {
    const { s, f, head } = await prep();
    const wrong = await promote(s, f, head, { room: "room-b" });
    assert.equal(wrong.outcome, "refused");
    assert.match(wrong.note, /different room/);
    assert.equal((await promote(s, f, head)).outcome, "applied");
    const again = await promote(s, f, head);
    assert.equal(again.outcome, "applied");
    assert.equal(s.client.created.length, 1);
  });

  it("without promotion enabled, or a client that cannot open PRs, nothing is pushed", async () => {
    const off = setup();
    const f = await fork(off, 1);
    const head = commit(f.rec.worktreePath, "b.txt", "x\n");
    assert.equal(
      (await off.mgr.promote(item({ action: "promote", nodeId: f.node, params: { expectedHead: head } }))).outcome,
      "unsupported",
    );
    const { s, f: g, head: h } = await prep();
    (s.client as unknown as { createPullRequest?: unknown }).createPullRequest = undefined;
    const a = await promote(s, g, h);
    assert.equal(a.outcome, "unsupported");
    assert.throws(
      () => sh(s.bare, "rev-parse", "--verify", `refs/heads/${g.rec.branch}`),
      "nothing pushed before the capability check",
    );
  });

  it("a PR whose head is not the confirmed commit is not linked", async () => {
    const { s, f, head } = await prep();
    s.client.headShaOf = () => SHA("9");
    const a = await promote(s, f, head);
    assert.equal(a.outcome, "refused");
    assert.equal(s.store.links.length, 0);
    assert.equal(s.registry.get(f.id)?.status, "active");
    assert.match(a.note, /not the confirmed commit/);
  });

  it("an unknown approach is not ours: the request is left for another instance", async () => {
    const { s } = await prep();
    assert.equal(s.mgr.knowsApproach("approach:fk-0000000000000000"), false);
    assert.equal(s.mgr.knowsApproach("task:t1"), false);
  });
});

describe("through the steering ledger", () => {
  const ports = (s: ReturnType<typeof setup>, now = 1_000): SteeringPorts => ({
    now: () => now,
    resolve: () => null,
    steerRunning: () => "no_channel",
    resumeMission: async () => ({ changed: false }),
    forks: {
      knows: (i) => (i.action === "promote" ? s.mgr.knowsApproach(i.nodeId) : i.nodeId === "task:t1"),
      apply: (i) => (i.action === "promote" ? s.mgr.promote(i) : s.mgr.create(i, s.origin)),
    },
  });

  it("applies once, answers a redelivery from the ledger, skips unknown targets and expires", async () => {
    const s = setup();
    const ledger = new MemorySteeringLedger();
    const it1 = item({ action: "fork", params: { baseSha: s.base }, validUntilEpoch: 2_000 });
    const a = await applySteering(it1, ports(s), ledger);
    assert.equal(a?.outcome, "applied");
    const b = await applySteering(it1, ports(s), ledger);
    assert.deepEqual(b, a);
    assert.equal(s.registry.list().length, 1);
    assert.equal(
      await applySteering(
        item({ action: "fork", steeringId: "st-2", nodeId: "task:unknown", params: { baseSha: s.base } }),
        ports(s),
        ledger,
      ),
      null,
    );
    const late = await applySteering(
      item({ action: "fork", steeringId: "st-3", params: { baseSha: s.base }, validUntilEpoch: 500 }),
      ports(s),
      ledger,
    );
    assert.equal(late?.outcome, "stale");
    assert.equal(s.registry.list().length, 1);
  });

  it("answers unsupported when forks are not enabled on this host", async () => {
    const s = setup();
    const noForks: SteeringPorts = { ...ports(s), forks: undefined };
    const a = await applySteering(
      item({ action: "fork", params: { baseSha: s.base } }),
      noForks,
      new MemorySteeringLedger(),
    );
    assert.equal(a?.outcome, "unsupported");
    assert.equal(s.registry.list().length, 0);
  });

  it("an interrupted application is never re-applied", async () => {
    const s = setup();
    const ledger = new MemorySteeringLedger();
    ledger.begin("st-1");
    const a = await applySteering(item({ action: "fork", params: { baseSha: s.base } }), ports(s), ledger);
    assert.equal(a?.outcome, "stale");
    assert.equal(s.registry.list().length, 0);
  });
});

describe("github client: pull requests", () => {
  const cfg = { enabled: true, defaultRepo: "acme/widgets" };
  const repo = { host: "github.com", owner: "acme", repo: "widgets" };
  const pr = (number: number, sha: string) => ({
    number,
    state: "open",
    title: "t",
    body: "b",
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    head: { sha, ref: "pi-fork/fk-0123456789abcdef", repo: { full_name: "acme/widgets" } },
    base: { ref: "main" },
  });
  it("creates a draft with argv only: values are -f strings, never @file reads, and there is no merge call", async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (argv) => {
      calls.push([...argv]);
      const out = argv.includes("POST") ? { number: 7 } : pr(7, SHA("a"));
      return { stdout: JSON.stringify(out), stderr: "", code: 0 };
    };
    const c = new GhCliClient(cfg, run);
    const got = await c.createPullRequest({
      repo,
      head: "pi-fork/fk-0123456789abcdef",
      base: "main",
      title: "T @/etc/passwd",
      body: "@/etc/shadow",
      draft: true,
    });
    assert.equal(got.ref.number, 7);
    const post = calls.find((a) => a.includes("POST"))!;
    assert.ok(post.includes("draft=true") && post[post.indexOf("draft=true") - 1] === "-F");
    for (const f of post.filter((a) => a.startsWith("title=") || a.startsWith("body=")))
      assert.equal(post[post.indexOf(f) - 1], "-f");
    assert.ok(calls.every((a) => !a.some((x) => /merge|close|delete/i.test(x) && x !== "api")));
  });
  it("refuses option-like or malformed branch names", async () => {
    const c = new GhCliClient(cfg, async () => ({ stdout: "{}", stderr: "", code: 0 }));
    for (const bad of ["--upload-pack=x", "a b", "../x", "x\ny", "-x", ""]) {
      await assert.rejects(c.createPullRequest({ repo, head: bad, base: "main", title: "t", body: "b", draft: true }));
      await assert.rejects(c.findOpenPullRequestByHead(repo, bad));
    }
  });
  it("finds only a PR from a branch of THIS repository", async () => {
    const run: GhRunner = async (argv) => {
      if (argv.some((a) => a.includes("/pulls") && !a.includes("/pulls/")))
        return {
          stdout: JSON.stringify([
            { ...pr(3, SHA("b")), head: { ...pr(3, SHA("b")).head, repo: { full_name: "evil/widgets" } } },
          ]),
          stderr: "",
          code: 0,
        };
      return { stdout: JSON.stringify(pr(3, SHA("b"))), stderr: "", code: 0 };
    };
    assert.equal(await new GhCliClient(cfg, run).findOpenPullRequestByHead(repo, "pi-fork/fk-0123456789abcdef"), null);
    assert.ok(parseGithubRef("acme/widgets#3", cfg).ok);
  });
});

describe("forks settings: global YAML only, off unless valid", () => {
  const write = async (yaml: string) => {
    const dir = tmp();
    writeFileSync(join(dir, "engineering.yaml"), yaml);
    return loadForkSettings(dir);
  };
  it("is off by default and parses a valid block", async () => {
    assert.equal((await write("other: 1\n")).enabled, false);
    const s = await write(
      "forks:\n  enabled: true\n  max_total: 4\n  promote:\n    enabled: true\n    github:\n      default_repo: acme/widgets\n",
    );
    assert.equal(s.enabled, true);
    assert.equal(s.limits.maxTotal, 4);
    assert.equal(s.promote?.draft, true);
    assert.equal(s.promote?.github.defaultRepo, "acme/widgets");
    assert.equal((await write("forks:\n  enabled: true\n")).promote, null, "promotion has its own switch");
  });
  it("anything malformed turns the whole feature off with a note", async () => {
    for (const bad of [
      "forks: 3\n",
      "forks:\n  enabled: yes please\n",
      "forks:\n  enabled: true\n  nope: 1\n",
      "forks:\n  enabled: true\n  max_total: 0\n",
      "forks:\n  enabled: true\n  promote:\n    enabled: true\n    github:\n      gh_path: --exec\n",
      "forks:\n  enabled: true\n  promote:\n    enabled: true\n    github:\n      default_repo: not-a-repo\n",
    ]) {
      const s = await write(bad);
      assert.equal(s.enabled, false, bad);
      assert.ok(s.notes[0]?.startsWith("forks off:"), bad);
    }
  });
});

describe("production wiring (createForkRuntime)", () => {
  const sources = (over: Partial<ForkRuntimeSources> = {}): ForkRuntimeSources => ({
    getTask: (id) => (id === "t1" ? { task_id: "t1", mission_id: "m1" } : undefined),
    getExecution: () => undefined,
    getMission: (id) => (id === "m1" ? { mission_id: "m1", repository: "relative/repo", base_ref: "main" } : undefined),
    boundRoot: () => null,
    openRoot: async (p) => p,
    links: new Store(),
    ...over,
  });
  const boot = async (yaml: string, src: ForkRuntimeSources) => {
    const agentDir = tmp();
    writeFileSync(join(agentDir, "engineering.yaml"), yaml);
    return createForkRuntime({ agentDir, stateDir: tmp(), sources: src, lineage: null });
  };
  it("defaults build nothing: no port, so a fork request is acknowledged unsupported (standalone Pi unchanged)", async () => {
    const rt = await boot("other: 1\n", sources());
    assert.equal(rt, null);
    const a = await applySteering(
      item({ action: "fork", params: { baseSha: SHA("a") } }),
      {
        now: () => 1,
        resolve: () => null,
        steerRunning: () => "no_channel",
        resumeMission: async () => ({ changed: false }),
      },
      new MemorySteeringLedger(),
    );
    assert.equal(a?.outcome, "unsupported");
  });
  it("a relative or unregistered repository path is never resolved to a checkout", async () => {
    const rt = await boot("forks:\n  enabled: true\n", sources());
    assert.ok(rt);
    try {
      assert.equal(
        await rt.port.knows(item({ action: "fork", nodeId: "task:t1", params: { baseSha: SHA("a") } })),
        true,
      );
      const a = await rt.port.apply(item({ action: "fork", nodeId: "task:t1", params: { baseSha: SHA("a") } }));
      assert.equal(a.outcome, "refused");
      assert.match(a.note, /repository of that mission is not available/);
      assert.equal(
        await rt.port.knows(item({ action: "fork", nodeId: "task:nope", params: { baseSha: SHA("a") } })),
        false,
      );
      assert.equal(
        await rt.port.knows(item({ action: "fork", nodeId: "weird", params: { baseSha: SHA("a") } })),
        false,
      );
    } finally {
      rt.stop();
    }
  });
  it("a hostile base ref is refused, and a registered absolute checkout works", async () => {
    const r = mkRepo();
    const bad = await boot(
      "forks:\n  enabled: true\n",
      sources({ getMission: () => ({ mission_id: "m1", repository: r.root, base_ref: "--upload-pack=x" }) }),
    );
    try {
      assert.match(
        (await bad!.port.apply(item({ action: "fork", nodeId: "task:t1", params: { baseSha: r.base } }))).note,
        /plain branch name/,
      );
    } finally {
      bad?.stop();
    }
    const ok = await boot(
      "forks:\n  enabled: true\n  min_free_mb: 1\n",
      sources({ getMission: () => ({ mission_id: "m1", repository: r.root, base_ref: "main" }) }),
    );
    try {
      const a = await ok!.port.apply(item({ action: "fork", nodeId: "task:t1", params: { baseSha: r.base } }));
      assert.equal(a.outcome, "applied", a.note);
    } finally {
      ok?.stop();
    }
  });
});
