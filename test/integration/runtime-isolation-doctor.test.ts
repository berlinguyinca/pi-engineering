/**
 * Runtime introspection and `doctor [--repair]` (spec §25, §26, §27).
 * Real registry, real streams, real processes; the CLI is exercised as a real
 * child process.
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import extension from "../../extensions/index.ts";
import { RuntimeRegistry } from "../../src/runtime/isolation/RuntimeRegistry.ts";
import { resolveWorktreeIdentity } from "../../src/runtime/isolation/WorktreeIdentity.ts";
import { doctorExitCode, runDoctor } from "../../src/runtime/isolation/doctor.ts";
import { currentProcessIdentity } from "../../src/runtime/isolation/processIdentity.ts";
import { worktreeRuntimeDir } from "../../src/runtime/isolation/stateDir.ts";
import { makeGitRepo, makeStateDir } from "../support/childSessions.ts";

const exec = promisify(execFile);
const CLI = resolve(fileURLToPath(new URL("../../scripts/pi-engineering.ts", import.meta.url)));

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

describe("doctor", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-doctor-"));
    const stateDir = await makeStateDir("doctor-state");
    cleanup.push(root, stateDir);
    const repo = await makeGitRepo(join(root, "repo"));
    const env: NodeJS.ProcessEnv = { ...process.env, PI_ENGINEERING_STATE_DIR: stateDir };
    delete env.PI_ENGINEERING_ORCHESTRATION_DIR;
    return { root, stateDir, repo, env };
  }

  it("finds stale sessions, a dead writer's torn stream, a pending legacy import and a stale legacy lock — and repairs them safely", async () => {
    const { stateDir, repo, env } = await fixture();
    const identity = await resolveWorktreeIdentity(repo);
    const namespace = worktreeRuntimeDir(stateDir, identity.worktreeId);
    // A crashed session with a torn stream.
    const registry = RuntimeRegistry.open(join(stateDir, "registry.db"));
    const ghostPid = deadPid();
    registry.register({
      sessionId: "11111111-1111-4111-8111-111111111111",
      process: { ...currentProcessIdentity(), pid: ghostPid },
      startedAt: new Date().toISOString(),
      binding: { repoId: identity.repoId, worktreeId: identity.worktreeId, worktreePath: repo, runtimePath: namespace },
    });
    registry.close();
    await mkdir(join(namespace, "events"), { recursive: true });
    const stream = join(namespace, "events", "11111111-1111-4111-8111-111111111111.jsonl");
    await writeFile(
      stream,
      `${JSON.stringify({ event_id: "e1", timestamp: "2026-01-01T00:00:00.000Z", type: "probe", project_id: null, run_id: null, worker_id: null, payload: {} })}\n`,
    );
    appendFileSync(stream, '{"event_id":"e2","type":');
    // Legacy store + a lock left by a dead older process.
    await mkdir(join(repo, ".pi-eng"), { recursive: true });
    const legacy = join(repo, ".pi-eng", "orchestration.jsonl");
    await writeFile(legacy, readFileSync(stream, "utf8").split("\n")[0]!.concat("\n"));
    await writeFile(`${legacy}.lock`, `${JSON.stringify({ pid: deadPid(), host: hostname() })}\n`);

    const before = await runDoctor({ cwd: repo, env });
    const byName = new Map(before.checks.map((check) => [check.name, check]));
    assert.equal(byName.get("Stale sessions")?.repairable, 1);
    assert.equal(byName.get("Event streams")?.repairable, 1);
    assert.equal(byName.get("Legacy migration")?.repairable, 1);
    assert.equal(byName.get("Legacy writer lock")?.repairable, 1);
    assert.equal(byName.get("SQLite WAL")?.detail, "WAL");
    assert.equal(doctorExitCode(before), 1, "repairable issues remain");

    const repaired = await runDoctor({ cwd: repo, env, repair: true });
    assert.equal(repaired.repairableIssues, 0, JSON.stringify(repaired.checks, null, 2));
    assert.equal(doctorExitCode(repaired), 0);
    assert.ok(repaired.repaired.some((entry) => entry.includes("orphaned stale session")));
    assert.ok(readFileSync(stream, "utf8").endsWith("\n"), "torn tail truncated");
    assert.ok(readdirSync(join(namespace, "recovery")).some((name) => name.startsWith("torn-tail-")));
    assert.ok(readdirSync(join(namespace, "recovery")).some((name) => name.startsWith("stale-lock-")));
    assert.ok(existsSync(legacy), "the legacy store itself is never removed");
    assert.equal(existsSync(`${legacy}.lock`), false);

    const clean = await runDoctor({ cwd: repo, env });
    assert.equal(clean.repairableIssues, 0, "repair is complete and idempotent");
  });

  it("never touches a legacy lock still held by a live process", async () => {
    const { repo, env } = await fixture();
    await mkdir(join(repo, ".pi-eng"), { recursive: true });
    const lock = join(repo, ".pi-eng", "orchestration.jsonl.lock");
    await writeFile(lock, `${JSON.stringify({ pid: process.pid, host: hostname() })}\n`);
    const report = await runDoctor({ cwd: repo, env, repair: true });
    const check = report.checks.find((entry) => entry.name === "Legacy writer lock");
    assert.equal(check?.repairable, 0);
    assert.match(check?.detail ?? "", /live/);
    assert.ok(existsSync(lock));
  });

  it("reports a corrupt registry as repairable and rebuilds it with --repair", async () => {
    const { stateDir, repo, env } = await fixture();
    await writeFile(join(stateDir, "registry.db"), "garbage, not sqlite\n".repeat(50));
    const broken = await runDoctor({ cwd: repo, env });
    assert.equal(broken.checks.find((check) => check.name === "Runtime registry")?.status, "fail");
    assert.equal(doctorExitCode(broken), 1);
    const fixed = await runDoctor({ cwd: repo, env, repair: true });
    assert.equal(fixed.checks.find((check) => check.name === "Runtime registry")?.status, "ok");
    assert.ok(fixed.repaired.some((entry) => entry.includes("corrupt registry")));
  });

  it("CLI: `pi-engineering doctor --json` reports and exits by health", async () => {
    const { repo, env } = await fixture();
    const { stdout } = await exec(process.execPath, ["--no-warnings", CLI, "doctor", "--json", "--cwd", repo], { env });
    const report = JSON.parse(stdout) as { checks: Array<{ name: string }>; repairableIssues: number };
    assert.ok(report.checks.some((check) => check.name === "Worktree resolution"));
    assert.equal(report.repairableIssues, 0);
  });
});

describe("/pi-engineering status", () => {
  it("shows the bound worktree, a session-local writer and concurrent sessions — with no warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-status-"));
    const repo = await makeGitRepo(join(root, "repo"));
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      on: () => {},
      registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
        commands.set(name, options),
      registerTool: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      registerMessageRenderer: () => {},
      registerMarkdownTransformer: () => {},
      registerEntryRenderer: () => {},
      setModel: async () => false,
      events: { on: () => {}, emit: () => {} },
    };
    (extension as unknown as (api: unknown) => void)(pi);
    const notices: Array<{ text: string; level: string }> = [];
    const ctx = { cwd: repo, ui: { notify: (text: string, level: string) => notices.push({ text, level }) } };
    try {
      await commands.get("pi-engineering")!.handler("status", ctx);
      const text = notices.at(-1)?.text ?? "";
      assert.equal(notices.at(-1)?.level, "info");
      assert.match(text, /Worktree: /);
      assert.match(text, /Runtime: healthy/);
      assert.match(text, /Event writer: session-local/);
      assert.match(text, /Concurrent sessions: [1-9]/);
      assert.doesNotMatch(text, /PI_ENGINEERING_ORCHESTRATION_DIR/);
      await commands.get("pi-engineering")!.handler("events", ctx);
      assert.match(notices.at(-1)?.text ?? "", /Recent runtime events:[\s\S]*session\.registered/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
