/**
 * Where the orchestration store lives, and why concurrent sessions no longer
 * contend on it.
 *
 * The store used to be ONE file (`<repoRoot>/.pi-eng/orchestration.jsonl`)
 * behind ONE exclusive writer lock, so every session launched from a shared
 * parent directory serialized on it ("Engineering runtime did not open ... lock
 * held"). Now each worktree gets a namespace under the machine-local state dir,
 * keyed by git worktree identity, and each session appends to its own stream.
 * `PI_ENGINEERING_ORCHESTRATION_DIR` relocates the namespace but keeps
 * per-session writers.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { RuntimeSession } from "../../src/runtime/isolation/RuntimeSession.ts";
import { resolveWorktreeIdentity } from "../../src/runtime/isolation/WorktreeIdentity.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const ENV = "PI_ENGINEERING_ORCHESTRATION_DIR";

/** A worker that satisfies the type but is never invoked (tests only open). */
function noopWorker(): WorkerExecutor {
  return {
    async run(req) {
      return {
        result: {
          status: "completed",
          summary: `worker ${req.role} done`,
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
        usage: null,
        toolCalls: 0,
      };
    },
  };
}

function withEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prior = process.env[ENV];
  const had = prior !== undefined;
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (had) process.env[ENV] = prior;
      else delete process.env[ENV];
    });
}

describe("orchestration store location (per-worktree namespace, per-session writers)", () => {
  const cleanupFns: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of cleanupFns) await fn().catch(() => undefined);
  });

  it("places the namespace under the state dir keyed by worktree identity, with this session's stream", async () => {
    await withEnv(undefined, async () => {
      const fx = await makeFixtureRepo();
      cleanupFns.push(fx.cleanup);
      const rt = await EngineeringRuntime.open({ cwd: fx.root, worker: noopWorker(), verifier: new CommandVerifier() });
      try {
        const identity = await resolveWorktreeIdentity(fx.root);
        const binding = rt.runtimeBinding;
        assert.ok(binding, "runtime exposes its binding");
        assert.equal(binding.kind, "worktree");
        assert.equal(binding.identity.worktreeId, identity.worktreeId);
        assert.ok(binding.runtimeDir?.startsWith(process.env.PI_ENGINEERING_STATE_DIR ?? "<unset>"));
        assert.ok(existsSync(binding.eventsDir ?? ""), "events dir exists");
        // Opening may write nothing yet; the first mission event lands in THIS session's stream.
        await rt.missionStore?.flush();
        const session = RuntimeSession.current();
        const streams = readdirSync(binding.eventsDir ?? "");
        assert.ok(
          streams.every((name) => name === `${session.sessionId}.jsonl`),
          `only this session writes: ${streams}`,
        );
        assert.ok(!existsSync(join(fx.root, ".pi-eng", "orchestration.jsonl.lock")), "no repository writer lock");
      } finally {
        await rt.close();
      }
    });
  });

  it("relocates the namespace to PI_ENGINEERING_ORCHESTRATION_DIR but keeps per-session writers", async () => {
    const overrideDir = join(await mkdtemp(join(tmpdir(), "pi-orch-override-")), "state");
    cleanupFns.push(() => rm(overrideDir, { recursive: true, force: true }));
    await withEnv(overrideDir, async () => {
      const fx = await makeFixtureRepo();
      cleanupFns.push(fx.cleanup);
      const rt = await EngineeringRuntime.open({ cwd: fx.root, worker: noopWorker(), verifier: new CommandVerifier() });
      try {
        assert.equal(rt.runtimeBinding?.kind, "override");
        assert.equal(rt.runtimeBinding?.runtimeDir, overrideDir);
        assert.ok(existsSync(join(overrideDir, "events")), "per-session event streams live in the override");
        assert.ok(!existsSync(join(overrideDir, "orchestration.jsonl.lock")), "no shared single-writer lock");
      } finally {
        await rt.close();
      }
    });
  });

  it("opens even when a stale legacy writer lock with unreadable owner metadata sits in .pi-eng", async () => {
    await withEnv(undefined, async () => {
      const fx = await makeFixtureRepo();
      cleanupFns.push(fx.cleanup);
      await mkdir(join(fx.root, ".pi-eng"), { recursive: true });
      // The exact incident: a lock whose owner metadata is missing/unreadable.
      await writeFile(join(fx.root, ".pi-eng", "orchestration.jsonl.lock"), "");
      const rt = await EngineeringRuntime.open({ cwd: fx.root, worker: noopWorker(), verifier: new CommandVerifier() });
      try {
        assert.ok(rt.orchestrator, "orchestrator is initialized");
        assert.ok(rt.missionStore, "mission store is initialized");
      } finally {
        await rt.close();
      }
    });
  });

  it("imports a legacy orchestration.jsonl without modifying it", async () => {
    await withEnv(undefined, async () => {
      const fx = await makeFixtureRepo();
      cleanupFns.push(fx.cleanup);
      await mkdir(join(fx.root, ".pi-eng"), { recursive: true });
      const legacy = join(fx.root, ".pi-eng", "orchestration.jsonl");
      const event = {
        event_id: "oevt-legacy-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "mission.created",
        project_id: null,
        run_id: "MSN-legacy",
        worker_id: null,
        payload: { mission_id: "MSN-legacy" },
      };
      const original = `${JSON.stringify(event)}\n{"event_id":"torn`;
      await writeFile(legacy, original);
      const rt = await EngineeringRuntime.open({ cwd: fx.root, worker: noopWorker(), verifier: new CommandVerifier() });
      try {
        const eventsDir = rt.runtimeBinding?.eventsDir ?? "";
        const imported = readdirSync(eventsDir).filter((name) => name.startsWith("legacy-"));
        assert.equal(imported.length, 1, "one legacy import stream");
        const lines = (await readFile(join(eventsDir, imported[0]!), "utf8")).trim().split("\n");
        assert.equal(lines.length, 1, "only the valid event is imported");
        assert.equal(await readFile(legacy, "utf8"), original, "the legacy file is preserved byte for byte");
      } finally {
        await rt.close();
      }
    });
  });
});
