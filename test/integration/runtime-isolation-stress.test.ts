/**
 * Hostile concurrency (spec §33–§35). Everything here is real: child
 * processes, git repositories and worktrees, SQLite, SIGKILL. No mocks.
 *
 * Each scenario starts its processes against a shared barrier timestamp so
 * initialization overlaps within a few milliseconds.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { RecoveryManager } from "../../src/runtime/isolation/RecoveryManager.ts";
import { RuntimeRegistry } from "../../src/runtime/isolation/RuntimeRegistry.ts";
import { legacyTargetName } from "../../src/runtime/isolation/legacyMigration.ts";
import { currentProcessIdentity, readProcessStartTime } from "../../src/runtime/isolation/processIdentity.ts";
import {
  type ChildReport,
  addWorktree,
  makeGitRepo,
  makeStateDir,
  runChildren,
  runScript,
  startChild,
} from "../support/childSessions.ts";

const SAME_WORKTREE_SESSIONS = 30;

interface RaceReport {
  ok: boolean;
  pid: number;
  sessionId?: string;
  violations?: string[];
  stats?: Record<string, number>;
  error?: string;
}

interface ExtensionReport {
  ok: boolean;
  sessionId?: string;
  bindings?: Array<string | null>;
  health?: string;
  lastTool?: string;
  error?: string;
}

describe("hostile concurrency", { concurrency: false }, () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function scratch(label: string): Promise<{ root: string; stateDir: string }> {
    const root = await mkdtemp(join(tmpdir(), `pi-eng-stress-${label}-`));
    const stateDir = await makeStateDir(`stress-${label}-state`);
    cleanup.push(root, stateDir);
    return { root, stateDir };
  }

  it(`same worktree: ${SAME_WORKTREE_SESSIONS} sessions initialize at once with unique writers and consistent shared state`, async () => {
    const { root, stateDir } = await scratch("same");
    const repo = await makeGitRepo(join(root, "repo"));
    const { reports, children } = await runChildren(SAME_WORKTREE_SESSIONS, () => repo, stateDir);
    await Promise.all(children.map((child) => child.exited));
    const failures = reports.filter((report) => !report.ok);
    assert.deepEqual(failures, [], "no session failed to open");
    assert.equal(new Set(reports.map((report) => report.sessionId)).size, SAME_WORKTREE_SESSIONS);
    assert.ok(reports.every((report) => report.health === "healthy"));
    const eventsDir = reports[0]!.eventsDir!;
    const streams = readdirSync(eventsDir).filter((name) => name.endsWith(".jsonl"));
    assert.equal(streams.length, SAME_WORKTREE_SESSIONS, "one writer stream per session, never shared");
    for (const stream of streams) {
      const lines = readFileSync(join(eventsDir, stream), "utf8").trim().split("\n");
      const sessions = new Set(lines.map((line) => (JSON.parse(line) as { session_id: string }).session_id));
      assert.deepEqual([...sessions], [stream.slice(0, -".jsonl".length)], `${stream} has exactly one writer`);
    }
    const lateChild = startChild("open", repo, stateDir);
    const late = await lateChild.report;
    await lateChild.exited;
    assert.equal(late.ok, true, late.error);
    for (const report of reports) assert.ok(late.visibleMissions?.includes(report.missionId!));
    const registry = RuntimeRegistry.open(join(stateDir, "registry.db"));
    try {
      assert.equal(registry.list().length, 0, "every session unregistered on exit");
      assert.equal(registry.leases.list().length, 0, "no leases leak");
    } finally {
      registry.close();
    }
  });

  it("same repository, different worktrees: many sessions resolve to isolated namespaces", async () => {
    const { root, stateDir } = await scratch("worktrees");
    const main = await makeGitRepo(join(root, "main"));
    const trees = [
      main,
      await addWorktree(main, join(root, "feature-routing"), "feature-routing"),
      await addWorktree(main, join(root, "benchmark"), "benchmark"),
    ];
    const { reports } = await runChildren(24, (index) => trees[index % trees.length]!, stateDir);
    assert.deepEqual(
      reports.filter((report) => !report.ok),
      [],
    );
    const namespaces = new Map<string, Set<string>>();
    reports.forEach((report, index) => {
      const tree = trees[index % trees.length]!;
      namespaces.set(tree, (namespaces.get(tree) ?? new Set()).add(report.eventsDir!));
    });
    for (const [tree, dirs] of namespaces) assert.equal(dirs.size, 1, `${tree} maps to one namespace`);
    const all = new Set([...namespaces.values()].map((dirs) => [...dirs][0]));
    assert.equal(all.size, 3);
    for (const dir of all) assert.equal(readdirSync(dir!).length, 8, "8 sessions per worktree namespace");
  });

  it("parent directory: sessions launched from the parent independently bind to different repositories (case 2)", async () => {
    const { root, stateDir } = await scratch("parent");
    await makeGitRepo(root);
    const inferweave = await makeGitRepo(join(root, "inferweave"));
    const piEngineering = await makeGitRepo(join(root, "pi-engineering"));
    const startAt = Date.now() + 2_000;
    const runs = Array.from({ length: 10 }, (_, index) =>
      runScript<ExtensionReport>(
        "extensionChild.ts",
        [root, String(startAt), index % 2 === 0 ? inferweave : piEngineering],
        { PI_ENGINEERING_STATE_DIR: stateDir },
      ),
    );
    const reports = await Promise.all(runs.map((run) => run.report));
    reports.forEach((report, index) => {
      assert.equal(report.ok, true, report.error);
      assert.deepEqual(report.bindings, [root, index % 2 === 0 ? inferweave : piEngineering]);
      assert.doesNotMatch(report.lastTool ?? "", /not initialized|PI_ENGINEERING_ORCHESTRATION_DIR|lock/i);
    });
    await Promise.all(runs.map((run) => run.exited));
  });

  it("rebinding: sessions switch worktrees repeatedly and always end on the last one", async () => {
    const { root, stateDir } = await scratch("rebind");
    await makeGitRepo(root);
    const repos = [
      await makeGitRepo(join(root, "a")),
      await makeGitRepo(join(root, "b")),
      await makeGitRepo(join(root, "c")),
    ];
    const startAt = Date.now() + 2_000;
    const plans = Array.from({ length: 6 }, (_, index) =>
      Array.from({ length: 7 }, (_, step) => repos[(index + step) % repos.length]!),
    );
    const runs = plans.map((plan) =>
      runScript<ExtensionReport>("extensionChild.ts", [root, String(startAt), ...plan], {
        PI_ENGINEERING_STATE_DIR: stateDir,
      }),
    );
    const reports = await Promise.all(runs.map((run) => run.report));
    reports.forEach((report, index) => {
      assert.equal(report.ok, true, report.error);
      assert.deepEqual(report.bindings, [root, ...plans[index]!]);
      assert.equal(report.health, "rebound");
    });
    await Promise.all(runs.map((run) => run.exited));
  });

  it("crash: SIGKILLed owners are replaced at once; every mission is adopted by exactly one live custodian", async () => {
    const { root, stateDir } = await scratch("crash");
    const repo = await makeGitRepo(join(root, "repo"));
    const startAt = Date.now() + 1_500;
    const holders = Array.from({ length: 6 }, () => startChild("hold", repo, stateDir, { startAt }));
    const held = await Promise.all(holders.map((holder) => holder.report));
    assert.ok(held.every((report) => report.ok));
    for (const holder of holders) holder.child.kill("SIGKILL");
    await Promise.all(holders.map((holder) => holder.exited));

    // Replacements start immediately, all at once, all wanting the same mission.
    const contested = held[0]!.missionId!;
    const replacementsAt = Date.now() + 1_000;
    const replacements = Array.from({ length: 8 }, () =>
      startChild("adopt", repo, stateDir, { startAt: replacementsAt, env: { PI_TEST_ADOPT_MISSION: contested } }),
    );
    const outcomes = await Promise.all(
      replacements.map((replacement) =>
        replacement.report.catch((error: Error) => ({ ok: false, error: error.message }) as ChildReport),
      ),
    );
    const adopted = outcomes.filter((outcome) => outcome.ok);
    assert.ok(adopted.length >= 1, "a replacement adopted the dead session's mission");
    for (const outcome of outcomes.filter((entry) => !entry.ok)) {
      assert.match(String(outcome.error), /custody of another live session/, "losers lose only to a live custodian");
    }
    const generations = adopted.map((outcome) => outcome.adoptedGeneration);
    assert.equal(new Set(generations).size, generations.length, "no two adopters ever held the same lease generation");
    await Promise.all(replacements.map((replacement) => replacement.exited));
    const registry = RuntimeRegistry.open(join(stateDir, "registry.db"));
    try {
      new RecoveryManager(registry).reconcile();
      const killed = new Set(held.map((report) => report.sessionId));
      assert.ok(
        registry.leases.list().every((lease) => !killed.has(lease.sessionId)),
        "no lease remains with a killed session",
      );
      for (const id of killed) assert.notEqual(registry.get(id!)?.state, "healthy");
    } finally {
      registry.close();
    }
  });

  it("truncated JSONL: writers killed mid-record are each repaired exactly once by concurrent replacements", async () => {
    const { root, stateDir } = await scratch("torn");
    const repo = await makeGitRepo(join(root, "repo"));
    const writers = Array.from({ length: 5 }, () => startChild("tear", repo, stateDir));
    const torn = await Promise.all(writers.map((writer) => writer.report));
    for (const writer of writers) writer.child.kill("SIGKILL");
    await Promise.all(writers.map((writer) => writer.exited));
    const { reports } = await runChildren(6, () => repo, stateDir);
    assert.ok(reports.every((report) => report.ok));
    const eventsDir = torn[0]!.eventsDir!;
    for (const report of torn) {
      const content = readFileSync(join(eventsDir, `${report.sessionId}.jsonl`), "utf8");
      assert.ok(content.endsWith("\n"), "stream repaired");
      assert.ok(content.length > 0, "valid prefix preserved");
    }
    const quarantined = readdirSync(join(eventsDir, "..", "recovery")).filter((name) => name.startsWith("torn-tail-"));
    assert.equal(quarantined.length, torn.length, "each broken tail quarantined exactly once");
    const repairedByReplacements = reports.flatMap((report) => report.reconciliation?.repairedStreams ?? []);
    assert.equal(repairedByReplacements.length, torn.length);
  });

  it("corrupted metadata (missing/empty/partial/invalid JSON lock owners, garbage registry) never stops concurrent sessions", async () => {
    const { root, stateDir } = await scratch("corrupt");
    const variants: Array<[string, string | null]> = [
      ["missing", null],
      ["empty", ""],
      ["partial", '{"pid":12'],
      ["invalid", "not json at all"],
    ];
    const repos: string[] = [];
    for (const [name, content] of variants) {
      const repo = await makeGitRepo(join(root, name));
      mkdirSync(join(repo, ".pi-eng"), { recursive: true });
      const lock = join(repo, ".pi-eng", "orchestration.jsonl.lock");
      if (content === null) mkdirSync(lock);
      else writeFileSync(lock, content);
      repos.push(repo);
    }
    await writeFile(join(stateDir, "registry.db"), Buffer.alloc(4096, 0x5a));
    const { reports } = await runChildren(12, (index) => repos[index % repos.length]!, stateDir);
    assert.deepEqual(
      reports.filter((report) => !report.ok),
      [],
    );
    assert.ok(reports.every((report) => report.health === "healthy"));
    const quarantined = readdirSync(join(stateDir, "recovery")).filter((name) => name.includes("corrupt"));
    assert.equal(quarantined.length, 1, "the corrupt registry is quarantined once, not by every session");
  });

  it("PID reuse / reboot simulation: forged incarnations and vanished PIDs never block or fool new sessions", async () => {
    const { root, stateDir } = await scratch("pidreuse");
    const repo = await makeGitRepo(join(root, "repo"));
    const registry = RuntimeRegistry.open(join(stateDir, "registry.db"));
    const live = currentProcessIdentity();
    try {
      for (let index = 0; index < 50; index++) {
        const forged =
          index % 3 === 0
            ? { ...live, processStartTime: String(index + 1) } // PID reused: our live pid, wrong start time
            : index % 3 === 1
              ? { ...live, bootId: "00000000-0000-0000-0000-000000000000" } // previous boot
              : { ...live, pid: 4_000_000 + index, host: hostname() }; // PID gone
        const sessionId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        registry.register({ sessionId, process: forged, startedAt: new Date().toISOString() });
        assert.ok(registry.leases.acquire(`stale#mission:${index}`, { sessionId, process: forged }).ok);
      }
    } finally {
      registry.close();
    }
    const started = Date.now();
    const report = await startChild("open", repo, stateDir).report;
    assert.equal(report.ok, true, report.error);
    assert.equal(
      report.reconciliation?.orphanedSessions.length,
      50,
      "every forged/vanished owner is recognized as dead",
    );
    assert.equal(report.reconciliation?.reclaimedLeases.length, 0, "their leases were released with them");
    assert.ok(Date.now() - started < 20_000, "reconciliation stays fast");
    const after = RuntimeRegistry.open(join(stateDir, "registry.db"));
    try {
      assert.equal(after.leases.list({ prefix: "stale#" }).length, 0);
    } finally {
      after.close();
    }
  });

  it("randomized multi-process race: register/heartbeat/acquire/renew/release/rebind/reconcile/SIGKILL keep every invariant", async () => {
    const { stateDir } = await scratch("race");
    const registryFile = join(stateDir, "registry.db");
    const occupancy = join(stateDir, "occupancy");
    mkdirSync(occupancy, { recursive: true });
    // Pre-seed impostor leases: live PIDs with forged start times must be reclaimed, never honored.
    const seed = RuntimeRegistry.open(registryFile);
    try {
      for (let index = 0; index < 4; index++) {
        const impostor = { ...currentProcessIdentity(), processStartTime: String(index + 1) };
        seed.register({ sessionId: `impostor-${index}`, process: impostor, startedAt: new Date().toISOString() });
        seed.leases.acquire(`res-${index}`, { sessionId: `impostor-${index}`, process: impostor });
      }
    } finally {
      seed.close();
    }
    const startAt = Date.now() + 1_500;
    const contenders = Array.from({ length: 24 }, () =>
      runScript<RaceReport>("leaseRaceChild.ts", [registryFile, occupancy, "250", String(startAt), "4"], {}),
    );
    // Kill a few contenders mid-flight; survivors must recover their resources.
    setTimeout(() => {
      for (const contender of contenders.slice(0, 4)) contender.child.kill("SIGKILL");
    }, 1_500 + 400);
    const settled = await Promise.all(
      contenders.map((contender) =>
        contender.report.catch((error: Error) => ({ ok: false, pid: 0, error: error.message }) as RaceReport),
      ),
    );
    const survivors = settled.slice(4);
    for (const report of survivors) {
      assert.equal(report.ok, true, report.error);
      assert.deepEqual(report.violations, [], `invariant violations in pid ${report.pid}`);
    }
    const totals = survivors.reduce(
      (sum, report) => ({
        acquired: sum.acquired + (report.stats?.acquired ?? 0),
        contended: sum.contended + (report.stats?.contended ?? 0),
      }),
      { acquired: 0, contended: 0 },
    );
    assert.ok(totals.acquired > 100 && totals.contended > 0, `real contention happened: ${JSON.stringify(totals)}`);
    const registry = RuntimeRegistry.open(registryFile);
    try {
      new RecoveryManager(registry).reconcile();
      const live = new Set(registry.list().map((session) => session.sessionId));
      assert.ok(
        registry.leases.list().every((lease) => live.has(lease.sessionId)),
        "after reconciliation no lease is held by a dead or impostor session",
      );
      assert.equal(registry.leases.list().filter((lease) => lease.sessionId.startsWith("impostor-")).length, 0);
    } finally {
      registry.close();
    }
  });

  it("double migration: many sessions importing the same legacy store at once produce one consistent import", async () => {
    const { root, stateDir } = await scratch("migration");
    const repo = await makeGitRepo(join(root, "repo"));
    mkdirSync(join(repo, ".pi-eng"), { recursive: true });
    const legacy = join(repo, ".pi-eng", "orchestration.jsonl");
    const events = Array.from({ length: 500 }, (_, index) =>
      JSON.stringify({
        event_id: `legacy-${index}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        type: "probe",
        project_id: null,
        run_id: null,
        worker_id: null,
        payload: { index },
      }),
    );
    writeFileSync(legacy, `${events.join("\n")}\n`);
    const original = readFileSync(legacy, "utf8");
    const { reports } = await runChildren(12, () => repo, stateDir);
    assert.ok(reports.every((report) => report.ok));
    const eventsDir = reports[0]!.eventsDir!;
    const imported = readFileSync(join(eventsDir, legacyTargetName(legacy)), "utf8")
      .trim()
      .split("\n");
    assert.equal(imported.length, 500, "exactly one complete import");
    assert.equal(new Set(imported).size, 500);
    assert.equal(readFileSync(legacy, "utf8"), original, "legacy store untouched");
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(eventsDir, "..", "migrations.json"), "utf8")));
    assert.equal(readdirSync(eventsDir).filter((name) => name.startsWith("legacy-")).length, 1);
    assert.ok(
      readProcessStartTime(process.pid).state === "present",
      "Linux /proc available (incarnation checks were exercised)",
    );
  });
});
