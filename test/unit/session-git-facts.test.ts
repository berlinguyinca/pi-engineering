/**
 * Session git facts: what a Pi agent reports so the control plane can correlate it with architecture snapshots and CI.
 * The identity must be the SAME worktree id Pi derives for isolation, the commit must be the real HEAD, and a plain
 * directory must report nothing rather than something made up.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";
import { HerdrAgentRuntime } from "../../src/runtime/herdr/HerdrAgentRuntime.ts";
import { resetSessionGitFactsCache, sessionGitFacts } from "../../src/runtime/herdr/sessionGitFacts.ts";
import { resolveWorktreeIdentity } from "../../src/runtime/isolation/WorktreeIdentity.ts";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: "/nonexistent",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();

function repo(withCommit = true, origin?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-gitfacts-")));
  git(dir, "init", "-q", "-b", "main");
  if (origin) git(dir, "remote", "add", "origin", origin);
  if (withCommit) {
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "one");
  }
  return dir;
}

test("a git worktree reports Pi's own worktree id, the real HEAD and the origin", async () => {
  resetSessionGitFactsCache();
  const dir = repo(true, "git@github.com:example/fixture.git");
  try {
    const facts = await sessionGitFacts(dir);
    assert.ok(facts);
    assert.equal(facts.worktreeId, (await resolveWorktreeIdentity(dir)).worktreeId);
    assert.match(facts.worktreeId, /^[0-9a-f]{24}$/);
    assert.equal(facts.commitSha, git(dir, "rev-parse", "HEAD"));
    assert.equal(facts.repoUrl, "git@github.com:example/fixture.git");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two worktrees of one repository get different worktree ids and their own HEAD", async () => {
  resetSessionGitFactsCache();
  const main = repo();
  const other = `${main}-wt`;
  try {
    git(main, "worktree", "add", "-q", "-b", "feature", other);
    writeFileSync(join(other, "b.txt"), "b\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "feature work");
    const a = await sessionGitFacts(main);
    const b = await sessionGitFacts(other);
    assert.ok(a && b);
    assert.notEqual(a.worktreeId, b.worktreeId);
    assert.notEqual(a.commitSha, b.commitSha);
    assert.equal(b.commitSha, git(other, "rev-parse", "HEAD"));
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("no origin and an unborn branch simply omit those fields; a plain directory reports nothing", async () => {
  resetSessionGitFactsCache();
  const unborn = repo(false);
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "pi-plain-")));
  try {
    const facts = await sessionGitFacts(unborn);
    assert.ok(facts);
    assert.equal(facts.commitSha, undefined);
    assert.equal(facts.repoUrl, undefined);
    assert.equal(await sessionGitFacts(plain), null);
    assert.equal(await sessionGitFacts(undefined), null);
    assert.equal(await sessionGitFacts(join(plain, "does", "not", "exist")), null);
  } finally {
    rmSync(unborn, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test("answers are cached for 30s, then re-read so a moved HEAD is reported", async () => {
  resetSessionGitFactsCache();
  const dir = repo();
  try {
    let clock = 1_000_000;
    const first = await sessionGitFacts(dir, () => clock);
    writeFileSync(join(dir, "c.txt"), "c\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "two");
    clock += 10_000;
    assert.equal((await sessionGitFacts(dir, () => clock))?.commitSha, first?.commitSha, "still cached");
    clock += 25_000;
    assert.equal((await sessionGitFacts(dir, () => clock))?.commitSha, git(dir, "rev-parse", "HEAD"), "re-read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fetch that never answers cannot make the lookup throw", async () => {
  resetSessionGitFactsCache();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-broken-")));
  try {
    mkdirSync(join(dir, ".git")); // looks like a repo, is not one
    assert.equal(await sessionGitFacts(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the wire format and the runtime wiring
interface Call {
  body: { entity_type: string; entity_id: string; event_type: string; payload: Record<string, unknown> };
}
const recording = (calls: Call[]): typeof globalThis.fetch =>
  (async (_u: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) as Call["body"] });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;

test("session() puts the facts on the wire under the control plane's field names, and only when present", async () => {
  const calls: Call[] = [];
  const ingest = new ControlPlaneIngest({ url: "http://dev.lan", host: { hostId: "h" }, fetch: recording(calls) });
  const sha = "a".repeat(40);
  await ingest.session("s1", "session.started", {
    status: "READY",
    worktreeId: "0123456789abcdef01234567",
    commitSha: sha,
    repoUrl: "https://github.com/o/r.git",
  });
  await ingest.session("s2", "session.started", { status: "READY" });
  const s1 = calls.find((c) => c.body.entity_id === "s1")!.body.payload;
  assert.equal(s1.worktree_id, "0123456789abcdef01234567");
  assert.equal(s1.commit_sha, sha);
  assert.equal(s1.repo_url, "https://github.com/o/r.git");
  const s2 = calls.find((c) => c.body.entity_id === "s2")!.body.payload;
  assert.ok(!("worktree_id" in s2) && !("commit_sha" in s2) && !("repo_url" in s2));
});

class Cli {
  agents = new Map<string, { agent_status: string }>();
  async status() {
    return { ok: true, serverVersion: "0.9.1", protocol: 22 };
  }
  async listAgents() {
    return [...this.agents.values()];
  }
  async getAgent(t: string) {
    return this.agents.get(t) ?? null;
  }
  async readAgent() {
    return "x";
  }
  async prompt(t: string) {
    this.agents.set(t, { agent_status: "done" });
  }
  async wait(t: string) {
    return this.agents.get(t) ?? { agent_status: "done" };
  }
  async startAgent(pane: string) {
    this.agents.set(pane, { agent_status: "idle" });
  }
  async sendKeys() {
    /* none */
  }
  async closePane(t: string) {
    this.agents.delete(t);
  }
  async createWorkspace(cwd: string) {
    return { workspaceId: "w1", paneId: "fake-pane", path: cwd };
  }
  async createWorktree() {
    return { workspaceId: "wt1", paneId: "fake-pane", path: "/tmp/wt" };
  }
}

test("a runtime worker in a git directory reports its facts, in order, on every lifecycle event", async () => {
  resetSessionGitFactsCache();
  const dir = repo(true, "https://github.com/example/fixture.git");
  try {
    const calls: Call[] = [];
    const ingest = new ControlPlaneIngest({
      url: "http://dev.lan",
      host: { hostId: "bender" },
      fetch: recording(calls),
    });
    const rt = new HerdrAgentRuntime({ cli: new Cli() as never, ingest });
    const rid = await rt.create({ role: "engineer", objective: "x", missionId: "MSN-g", cwd: dir });
    await rt.start(rid);
    await rt.sendTask(rid, "x");
    await rt.terminate(rid);
    await new Promise((r) => setTimeout(r, 1500));
    const events = calls.filter((c) => c.body.entity_type === "session" && c.body.entity_id === rid);
    assert.ok(events.length >= 3, `started, updated, terminated: got ${events.map((e) => e.body.event_type)}`);
    assert.equal(events.at(-1)!.body.event_type, "session.terminated", "terminated is last");
    assert.equal(events[0]!.body.event_type, "session.started", "started is never overtaken by an update");
    for (const e of events) {
      assert.equal(e.body.payload.worktree_id, (await resolveWorktreeIdentity(dir)).worktreeId);
      assert.equal(e.body.payload.commit_sha, git(dir, "rev-parse", "HEAD"));
      assert.equal(e.body.payload.repo_url, "https://github.com/example/fixture.git");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
