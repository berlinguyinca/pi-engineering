/**
 * Issue #258: EngineeringRuntime.open reconciles the ResourceRegistry, so a
 * record left in `releasing` by a killed process is recovered at the next
 * startup. A real child process is SIGKILLed inside the release window; a fresh
 * runtime then opens the same state directory.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ResourceRegistry } from "../../src/resources/ResourceRegistry.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const runFile = promisify(execFile);
const CHILD = join(import.meta.dirname, "../support/registryCrashChild.ts");

async function crashMidRelease(config: {
  stateDir: string;
  hostId: string;
  id: string;
  locator: string;
  marker: string;
}): Promise<void> {
  const child = spawn(
    process.execPath,
    [CHILD, JSON.stringify({ ...config, missionId: "WI-crash", executionId: `exec-${config.id}` })],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const deadline = Date.now() + 30_000;
  while (!existsSync(config.marker)) {
    if (child.exitCode !== null) throw new Error(`crash child exited early (${child.exitCode})`);
    if (Date.now() > deadline) throw new Error("crash child never reached the release window");
    await new Promise((r) => setTimeout(r, 25));
  }
  child.kill("SIGKILL");
  await exited;
}

async function recordFiles(stateDir: string): Promise<Record<string, string>> {
  const dir = join(stateDir, "resources");
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json")).sort()) {
    out[name] = await readFile(join(dir, name), "utf8");
  }
  return out;
}

async function worktrees(root: string): Promise<string> {
  return (await runFile("git", ["-C", root, "worktree", "list", "--porcelain"])).stdout;
}

const openRuntime = (root: string, stateDir: string) =>
  EngineeringRuntime.open({
    cwd: root,
    workDir: stateDir,
    worker: new FakeWorkerExecutor({}),
    verifier: new CommandVerifier(),
  });

test("restart recovers a SIGKILLed release: present worktree -> active, absent -> released, foreign untouched", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const stateDir = join(fixture.root, ".state-258");
    const kept = join(fixture.root, ".wt-kept");
    const gone = join(fixture.root, ".wt-gone");
    await runFile("git", ["-C", fixture.root, "worktree", "add", "-q", "-b", "kept-branch", kept]);
    await runFile("git", ["-C", fixture.root, "worktree", "add", "-q", "-b", "gone-branch", gone]);

    await crashMidRelease({
      stateDir,
      hostId: hostname(),
      id: "wt-kept",
      locator: kept,
      marker: join(fixture.root, "m-kept"),
    });
    await crashMidRelease({
      stateDir,
      hostId: hostname(),
      id: "wt-gone",
      locator: gone,
      marker: join(fixture.root, "m-gone"),
    });
    await crashMidRelease({
      stateDir,
      hostId: "some-other-host",
      id: "wt-foreign",
      locator: kept,
      marker: join(fixture.root, "m-foreign"),
    });
    // The removal had finished for "gone" before the process died.
    await runFile("git", ["-C", fixture.root, "worktree", "remove", "--force", gone]);

    const before = await recordFiles(stateDir);
    const foreignFile = Object.entries(before).find(([, text]) => text.includes('"some-other-host"'));
    assert.ok(foreignFile, "foreign record exists");
    const states = Object.values(before).map((t) => (JSON.parse(t) as { state: string }).state);
    assert.deepEqual(states, ["releasing", "releasing", "releasing"], "all three crashed inside the window");

    const rt = await openRuntime(fixture.root, stateDir);
    try {
      const registry = new ResourceRegistry(stateDir, hostname());
      const byId = new Map((await registry.listAll()).map((r) => [r.id, r]));
      assert.equal(byId.get("wt-kept")?.state, "active");
      assert.equal(byId.get("wt-gone")?.state, "released");
      assert.equal((await recordFiles(stateDir))[foreignFile[0]], foreignFile[1], "foreign record byte-identical");
      assert.ok((await stat(kept)).isDirectory(), "the live worktree was not removed");

      const entries = rt.ledger
        .listEntities("finding")
        .filter((f) => /^resource wt-(kept|gone) /.test(f.claim))
        .map((f) => f.claim)
        .sort();
      assert.equal(entries.length, 2, entries.join("\n"));
      assert.match(entries[0] as string, /wt-gone completed at startup: resource absent from disk/);
      assert.match(entries[1] as string, /wt-kept rolled_back at startup: resource still present on disk/);
    } finally {
      await rt.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("restart performs 0 worktree removals for a record already released", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const stateDir = join(fixture.root, ".state-258b");
    const wt = join(fixture.root, ".wt-done");
    await runFile("git", ["-C", fixture.root, "worktree", "add", "-q", "-b", "done-branch", wt]);
    const registry = new ResourceRegistry(stateDir, hostname());
    await registry.register({
      id: "wt-done",
      kind: "worktree",
      ownerMissionId: "WI-done",
      ownerExecutionId: "exec-done",
      locator: wt,
      lease: "session:x",
    });
    await registry.beginRelease("wt-done", { missionId: "WI-done", executionId: "exec-done" }, () => false);
    await registry.completeRelease("wt-done");
    const before = await recordFiles(stateDir);
    const listBefore = await worktrees(fixture.root);

    const rt = await openRuntime(fixture.root, stateDir);
    try {
      assert.deepEqual(await recordFiles(stateDir), before, "released record untouched");
      assert.equal(await worktrees(fixture.root), listBefore, "git worktree list unchanged: nothing was removed");
      assert.ok(existsSync(wt));
      assert.equal(rt.ledger.listEntities("finding").filter((f) => /^resource wt-done /.test(f.claim)).length, 0);
    } finally {
      await rt.close();
    }
  } finally {
    await fixture.cleanup();
  }
});
