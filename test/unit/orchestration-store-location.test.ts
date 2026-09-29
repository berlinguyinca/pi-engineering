/**
 * The durable orchestration store — and, with it, the store's single-writer
 * file lock — is what serializes concurrent pi sessions. By default it lives in
 * a FIXED location (`<repoRoot>/.pi-eng/orchestration.jsonl`, the git toplevel
 * of the session's launch directory). When several sessions are launched from a
 * shared parent directory (one per project / branch / worktree) they all resolve
 * to the same store and serialize on one lock, even though they never touch the
 * same files.
 *
 * `PI_ENGINEERING_ORCHESTRATION_DIR` relocates the store (and its lock) to a
 * per-worktree / per-session directory so those sessions run in parallel. These
 * tests pin the location semantics and reproduce + resolve the contention.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ExclusiveFileLock } from "../../src/platform/eventstore/fileLock.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
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

describe("orchestration store location (per-worktree lock)", () => {
  const cleanupFns: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of cleanupFns) await fn().catch(() => undefined);
  });

  it("defaults to <workDir>/orchestration.jsonl when the override is unset", async () => {
    await withEnv(undefined, async () => {
      const fx = await makeFixtureRepo();
      cleanupFns.push(fx.cleanup);
      const rt = await EngineeringRuntime.open({ cwd: fx.root, worker: noopWorker(), verifier: new CommandVerifier() });
      try {
        const lockAtDefault = join(fx.root, ".pi-eng", "orchestration.jsonl.lock");
        assert.ok(existsSync(join(fx.root, ".pi-eng")), "workDir .pi-eng is created");
        assert.ok(existsSync(lockAtDefault), "writer lock lives at the default <workDir> location");
      } finally {
        await rt.close();
      }
    });
  });

  it("relocates the store + lock to PI_ENGINEERING_ORCHESTRATION_DIR when set", async () => {
    const overrideDir = join(await mkdtemp(join(tmpdir(), "pi-orch-override-")), "state");
    cleanupFns.push(() => rm(overrideDir, { recursive: true, force: true }));
    await withEnv(overrideDir, async () => {
      const fx = await makeFixtureRepo();
      cleanupFns.push(fx.cleanup);
      const rt = await EngineeringRuntime.open({ cwd: fx.root, worker: noopWorker(), verifier: new CommandVerifier() });
      try {
        assert.ok(
          existsSync(join(overrideDir, "orchestration.jsonl.lock")),
          "writer lock is relocated to the override dir",
        );
        assert.ok(
          !existsSync(join(fx.root, ".pi-eng", "orchestration.jsonl.lock")),
          "no writer lock remains at the fixed default location",
        );
      } finally {
        await rt.close();
      }
    });
  });

  it("does not contend when sessions use different orchestration dirs, but does on a shared fixed dir", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "pi-orch-shared-"));
    const dirB = await mkdtemp(join(tmpdir(), "pi-orch-isolated-"));
    cleanupFns.push(() => rm(dirA, { recursive: true, force: true }));
    cleanupFns.push(() => rm(dirB, { recursive: true, force: true }));

    // Session A holds the single-writer lock on the shared fixed store.
    const heldByA = await ExclusiveFileLock.acquire(join(dirA, "orchestration.jsonl"));
    try {
      // Session B (its own dir, as the override provides) opens without contention.
      const storeB = await JsonlEventStore.open(join(dirB, "orchestration.jsonl"));
      storeB.close();

      // A session that would share A's fixed dir is blocked — the incident.
      await assert.rejects(
        JsonlEventStore.open(join(dirA, "orchestration.jsonl")),
        /writer lock .* held/i,
        "sharing the fixed orchestration store must contend",
      );
    } finally {
      heldByA.release();
    }
  });
});
