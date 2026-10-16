/**
 * Issue #259: mission verification is reached by the build budget. The whole
 * production chain runs: EngineeringRuntime -> orchestrator -> broker ->
 * realBackends -> CommandVerifier -> admitMissionBuild (-> pressureGc), over a
 * mkdtemp Rust fixture whose test script records the CARGO_TARGET_DIR it was
 * given. The disk reader is the only injected seam.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { ResourceRegistry } from "../../src/resources/ResourceRegistry.ts";
import { missionTargetDir } from "../../src/resources/buildBudget.ts";
import type { StatfsReader } from "../../src/resources/buildBudget.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);
const GiB = 1024 ** 3;

const reader =
  (usedPct: number): StatfsReader =>
  async () => ({
    bsize: GiB,
    blocks: 1000,
    bfree: 1000 - usedPct * 10,
    bavail: 1000 - usedPct * 10,
    files: 0,
    ffree: 0,
  });

const testRoleRouter = { route: async () => ({ provider: "fake", id: "fake-reviewer" }) };

function acceptanceResults(task: string) {
  return [...task.matchAll(/Acceptance criterion ([^:]+):/g)].map((match) => ({
    acceptanceId: match[1]!,
    status: "passed" as const,
    detail: "checked",
  }));
}

let counter = 0;
const worker: WorkerExecutor = {
  async run(req) {
    if (req.role === "implementer") {
      // Distinct content per call: an identical tree would reuse a stored verification result.
      await mkdir(`${req.cwd}/src`, { recursive: true });
      await writeFile(`${req.cwd}/src/change-${++counter}.ts`, `export const n = ${counter};\n`, "utf8");
    }
    return {
      result: {
        status: "completed",
        summary: `${req.role} done`,
        claims: [],
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
        details: {},
      },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1, model: "fake" },
      toolCalls: 1,
      structured:
        req.resultTool === "review_result"
          ? {
              verdict: "approve",
              findings: [],
              missingTests: [],
              specGaps: [],
              acceptanceResults: acceptanceResults(req.task),
              summary: "approved",
            }
          : undefined,
    };
  },
};

describe("mission verification is wired to the build budget (issue #259)", () => {
  let fixture: Awaited<ReturnType<typeof makeFixtureRepo>>;
  let scratch: string;
  let stageLog: string;
  let savedTarget: string | undefined;

  before(async () => {
    savedTarget = process.env.CARGO_TARGET_DIR;
    // biome-ignore lint/performance/noDelete: unsetting an env var requires delete
    delete process.env.CARGO_TARGET_DIR;
    scratch = await mkdtemp(join(tmpdir(), "pi-eng-budget-wiring-"));
    stageLog = join(scratch, "stage.log");
    fixture = await makeFixtureRepo();
    const script = `node -e "require('fs').appendFileSync('${stageLog}', (process.env.CARGO_TARGET_DIR || 'UNSET') + String.fromCharCode(10))"`;
    await writeFile(
      join(fixture.root, "package.json"),
      JSON.stringify({
        name: "rust-fixture",
        version: "0.0.1",
        private: true,
        type: "module",
        scripts: { test: script },
      }),
    );
    await writeFile(join(fixture.root, "Cargo.toml"), '[package]\nname = "fx"\nversion = "0.0.1"\nedition = "2021"\n');
    await exec("git", ["-C", fixture.root, "add", "-A"]);
    await exec("git", ["-C", fixture.root, "commit", "-q", "-m", "rust fixture"]);
  });

  after(async () => {
    if (savedTarget === undefined) {
      // biome-ignore lint/performance/noDelete: unsetting an env var requires delete
      delete process.env.CARGO_TARGET_DIR;
    } else process.env.CARGO_TARGET_DIR = savedTarget;
    await fixture.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  const stageLines = async (): Promise<string[]> =>
    existsSync(stageLog) ? (await readFile(stageLog, "utf8")).split("\n").filter(Boolean) : [];

  /** Text of every artifact the runtime stored under the state dir. */
  async function artifactTexts(stateDir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else out.push(await readFile(path, "utf8").catch(() => ""));
      }
    };
    await walk(join(stateDir, "artifacts"));
    return out;
  }

  async function runMission(rt: EngineeringRuntime) {
    return rt.orchestrator!.orchestrate("Add a change", {
      repository: rt.cwd,
      baseRef: await rt.git!.headCommit(),
      mutationRequested: true,
    });
  }

  it("two missions' Rust stages see distinct CARGO_TARGET_DIR values under the state dir; at 95 percent the stage is refused before the command runs; GC frees a finished mission's cache", async () => {
    const stateDir = join(fixture.root, ".state-259");
    let used = 10;
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      workDir: stateDir,
      worker,
      verifier: new CommandVerifier(),
      roleRouter: testRoleRouter,
      buildStatfs: (p) => reader(used)(p),
    });
    try {
      // 1) Two missions, healthy disk: each Rust stage got its own dir under the state dir.
      const first = await runMission(rt);
      const second = await runMission(rt);
      assert.equal(first.completed, true, first.failureReason ?? undefined);
      assert.equal(second.completed, true, second.failureReason ?? undefined);
      const dir1 = missionTargetDir(stateDir, first.mission.mission_id);
      const dir2 = missionTargetDir(stateDir, second.mission.mission_id);
      assert.notEqual(dir1, dir2);
      const lines = await stageLines();
      assert.ok(lines.includes(dir1), `mission 1 stage saw ${dir1}; got ${lines.join(", ")}`);
      assert.ok(lines.includes(dir2), `mission 2 stage saw ${dir2}; got ${lines.join(", ")}`);
      assert.ok(
        lines.every((line) => line === dir1 || line === dir2),
        lines.join(", "),
      );
      assert.ok(existsSync(dir1) && existsSync(dir2), "target dirs were created");

      // 2) 95 percent use, nothing collectable (both caches are fresh): the stage is refused before it runs.
      used = 95;
      const before = (await stageLines()).length;
      const refused = await runMission(rt);
      assert.equal(refused.completed, false);
      assert.equal((await stageLines()).length, before, "the stage command did not run");
      assert.ok(
        (await artifactTexts(stateDir)).some((text) =>
          text.includes(`build refused for mission ${refused.mission.mission_id}`),
        ),
        "the refusal reason is recorded in the stage artifact",
      );

      // 3) The pressure GC: finished, idle missions' caches are released and pressure falls back below warn.
      const old = new Date(Date.now() - 3 * 3600_000);
      for (const dir of [dir1, dir2]) await utimes(dir, old, old);
      const gcRt = rt;
      used = 95;
      const pressured = reader(95);
      const calm = reader(10);
      // Pressure stays high until the first finished mission's cache is gone.
      const pressureOf: StatfsReader = (p) => (existsSync(dir1) ? pressured(p) : calm(p));
      await gcRt.close();
      const rt2 = await EngineeringRuntime.open({
        cwd: fixture.root,
        workDir: stateDir,
        worker,
        verifier: new CommandVerifier(),
        roleRouter: testRoleRouter,
        buildStatfs: pressureOf,
      });
      try {
        const recovered = await runMission(rt2);
        assert.equal(recovered.completed, true, recovered.failureReason ?? undefined);
        assert.ok(!existsSync(dir1), "the finished mission's idle cache was collected by the pressure GC");
        const records = await rt2.resourceRegistry.listAll();
        assert.equal(records.find((r) => r.locator === dir1)?.state, "released");
        const dir3 = missionTargetDir(stateDir, recovered.mission.mission_id);
        assert.ok((await stageLines()).includes(dir3), "the new mission's stage ran in its own dir");
      } finally {
        await rt2.close();
      }
    } finally {
      await rt.close().catch(() => {});
    }
  });

  it("the validation and process backends hand their mission's id and build options to the verifier", async () => {
    const stateDir = join(fixture.root, ".state-259-direct");
    const registry = new ResourceRegistry(stateDir, "test-host");
    let used = 10;
    const backends = realBackends({
      worker,
      verifier: new CommandVerifier(),
      artifacts: await ArtifactStore.create(join(stateDir, "artifacts")),
      git: null,
      cwd: fixture.root,
      build: { stateDir, registry, statfs: (p) => reader(used)(p) },
    });
    const signal = new AbortController().signal;
    const before = (await stageLines()).length;

    await backends.validation.runValidation({
      missionId: "MSN-direct-validation",
      worktree: fixture.root,
      objective: "v",
      signal,
    });
    await backends.process.runProcess({
      missionId: "MSN-direct-process",
      worktree: fixture.root,
      objective: "p",
      signal,
    });
    const lines = (await stageLines()).slice(before);
    assert.deepEqual(lines, [
      missionTargetDir(stateDir, "MSN-direct-validation"),
      missionTargetDir(stateDir, "MSN-direct-process"),
    ]);

    used = 95;
    const validation = await backends.validation.runValidation({
      missionId: "MSN-direct-validation-2",
      worktree: fixture.root,
      objective: "v",
      signal,
    });
    const proc = await backends.process.runProcess({
      missionId: "MSN-direct-process-2",
      worktree: fixture.root,
      objective: "p",
      signal,
    });
    assert.equal(validation.exitStatus, "failed");
    assert.equal(proc.exitStatus, "failed");
    assert.equal((await stageLines()).length, before + 2, "neither refused stage ran its command");
  });

  it("the broker hands the owning mission's id to the validation and process runners", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = store.createMission({
      title: "broker wiring",
      goal: "broker wiring",
      user_request: "broker wiring",
      base_ref: "HEAD",
      repository: fixture.root,
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const seen: Array<[string, string | undefined]> = [];
    const outcome = { exitStatus: "succeeded" as const, summary: "ok", artifactRefs: [], usage: {} };
    const broker = new ExecutionBroker({
      store,
      backends: {
        validation: {
          runValidation: async (input) => {
            seen.push(["validation", input.missionId]);
            return { executionId: "validation", ...outcome };
          },
        },
        process: {
          runProcess: async (input) => {
            seen.push(["process", input.missionId]);
            return { executionId: "process", ...outcome };
          },
        },
      },
    });
    for (const kind of ["validation", "process"] as const) {
      const task = store.createTask({
        mission_id: mission.mission_id,
        kind,
        role: kind === "validation" ? "validator" : "implementer",
        objective: `run ${kind}`,
      });
      store.transitionTask(task.task_id, "READY");
      await (
        await broker.execute({ taskId: task.task_id, missionId: mission.mission_id, kind, objective: task.objective })
      ).result();
    }
    assert.deepEqual(seen, [
      ["validation", mission.mission_id],
      ["process", mission.mission_id],
    ]);
  });
});
