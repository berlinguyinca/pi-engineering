import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type AutoSpecAdapter,
  type AutoSpecObservation,
  type AutoSpecOwner,
  type AutoSpecSubmission,
  StaleFencingTokenError,
} from "../../src/adapters/Adapters.ts";
import {
  AutoSpecVerificationProvider,
  AutoSpecWorkerExecutor,
  createAutospecBackends,
} from "../../src/adapters/autospecBackends.ts";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import type { WorkerRequest } from "../../src/workers/WorkerExecutor.ts";

const owner: AutoSpecOwner = { ownerId: "pi", fencingToken: 7 };

/** A programmable in-process AutoSpec: observations are served in order, the last one repeating. */
function fake(observations: Array<AutoSpecObservation | "hang" | Error>) {
  const calls = { submit: [] as AutoSpecSubmission[], observe: 0, cancel: [] as Array<{ id: string; reason: string }> };
  const adapter: AutoSpecAdapter = {
    name: "autospec",
    async submit(sub) {
      calls.submit.push(sub);
      return { externalId: "run-1", accepted: true };
    },
    async observe() {
      const next = observations[Math.min(calls.observe++, observations.length - 1)]!;
      if (next === "hang") return new Promise<AutoSpecObservation>(() => {});
      if (next instanceof Error) throw next;
      return next;
    },
    async cancel(id, _o, reason) {
      calls.cancel.push({ id, reason });
      return { cancelled: true, stale: false };
    },
  };
  return { adapter, calls };
}

const req = (over: Partial<WorkerRequest> = {}): WorkerRequest => ({
  role: "implementer",
  task: "implement isEven",
  tools: [],
  cwd: "/tmp",
  missionId: "MSN-1",
  workItemId: "WI-1",
  baseRef: "abc123",
  ...over,
});
const fast = { pollMs: 1, deadlineMs: 2_000 };

test("createAutospecBackends: null unless PI_AUTOSPEC_MANAGED_ENABLED is on", () => {
  const { adapter } = fake([{ state: "running", sequence: 1 }]);
  assert.equal(createAutospecBackends({}, adapter, owner), null);
  assert.equal(createAutospecBackends({ PI_AUTOSPEC_MANAGED_ENABLED: "0" }, adapter, owner), null);
  // the managed backend sits on top of PI_AUTOSPEC_ENABLED (missionMode.ts)
  assert.equal(createAutospecBackends({ PI_AUTOSPEC_MANAGED_ENABLED: "1" }, adapter, owner), null);
  assert.equal(
    createAutospecBackends({ PI_AUTOSPEC_ENABLED: "1", PI_AUTOSPEC_MANAGED_ENABLED: "1" }, null, owner),
    null,
  );
  const on = createAutospecBackends({ PI_AUTOSPEC_ENABLED: "1", PI_AUTOSPEC_MANAGED_ENABLED: "true" }, adapter, owner);
  assert.ok(on?.executor instanceof AutoSpecWorkerExecutor);
  assert.ok(on?.verifier instanceof AutoSpecVerificationProvider);
});

test("worker: submits with owner and fencing token, polls until succeeded", async () => {
  const { adapter, calls } = fake([
    { state: "queued", sequence: 1 },
    { state: "running", sequence: 2 },
    { state: "succeeded", sequence: 3, summary: "added isEven" },
  ]);
  const run = await new AutoSpecWorkerExecutor(adapter, owner, fast).run(req());
  assert.equal(run.result.status, "completed");
  assert.equal(run.result.summary, "added isEven");
  assert.equal(calls.observe, 3);
  assert.equal(calls.cancel.length, 0);
  const sub = calls.submit[0]!;
  assert.deepEqual(sub.owner, owner);
  assert.equal(sub.missionId, "MSN-1");
  assert.equal(sub.taskId, "WI-1");
  assert.equal(sub.baseSha, "abc123");
  assert.match(sub.request, /implement isEven/);
  assert.ok(sub.idempotencyKey.length > 0);
});

test("worker: a failed or cancelled remote run is a failed worker result", async () => {
  const failed = await new AutoSpecWorkerExecutor(fake([{ state: "failed", sequence: 2 }]).adapter, owner, fast).run(
    req(),
  );
  assert.equal(failed.result.status, "failed");
  assert.equal(failed.error, "autospec:failed");
  const cancelled = await new AutoSpecWorkerExecutor(
    fake([{ state: "cancelled", sequence: 2 }]).adapter,
    owner,
    fast,
  ).run(req());
  assert.equal(cancelled.result.status, "failed");
  assert.equal(cancelled.error, "autospec:cancelled");
});

test("worker: an AbortSignal during observe triggers exactly one cancel", async () => {
  const { adapter, calls } = fake(["hang"]);
  const controller = new AbortController();
  const pending = new AutoSpecWorkerExecutor(adapter, owner, fast).run(req({ signal: controller.signal }));
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  const run = await pending;
  assert.equal(run.result.status, "failed");
  assert.equal(run.error, "canceled");
  assert.equal(calls.cancel.length, 1);
  assert.equal(calls.cancel[0]!.id, "run-1");
});

test("worker: an abort between polls cancels once and stops polling", async () => {
  const { adapter, calls } = fake([{ state: "running", sequence: 1 }]);
  const controller = new AbortController();
  const pending = new AutoSpecWorkerExecutor(adapter, owner, { pollMs: 50, deadlineMs: 5_000 }).run(
    req({ signal: controller.signal }),
  );
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await pending;
  const seen = calls.observe;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls.observe, seen, "no more polling after the abort");
  assert.equal(calls.cancel.length, 1);
});

test("worker: an already-aborted signal never submits", async () => {
  const { adapter, calls } = fake([{ state: "running", sequence: 1 }]);
  const controller = new AbortController();
  controller.abort();
  const run = await new AutoSpecWorkerExecutor(adapter, owner, fast).run(req({ signal: controller.signal }));
  assert.equal(run.error, "canceled");
  assert.equal(calls.submit.length, 0);
  assert.equal(calls.cancel.length, 0);
});

test("worker: the deadline cancels the remote run once and fails with timeout", async () => {
  const { adapter, calls } = fake([{ state: "running", sequence: 1 }]);
  const run = await new AutoSpecWorkerExecutor(adapter, owner, { pollMs: 5, deadlineMs: 40 }).run(req());
  assert.equal(run.result.status, "failed");
  assert.equal(run.error, "timeout");
  assert.equal(calls.cancel.length, 1);
  assert.match(calls.cancel[0]!.reason, /deadline/);
});

test("worker: a stale fencing token fails the run without cancelling", async () => {
  const stale = new StaleFencingTokenError("run-1", owner, { ownerId: "other", fencingToken: 9 });
  const { adapter, calls } = fake([stale]);
  const run = await new AutoSpecWorkerExecutor(adapter, owner, fast).run(req());
  assert.equal(run.error, "autospec:stale-owner");
  assert.equal(calls.cancel.length, 0);
});

test("worker: a refused submission is a failed result carrying the reason", async () => {
  const { adapter } = fake([]);
  adapter.submit = async () => ({ externalId: "", accepted: false, reason: "stale-fencing-token" });
  const run = await new AutoSpecWorkerExecutor(adapter, owner, fast).run(req());
  assert.equal(run.result.status, "failed");
  assert.equal(run.error, "autospec:rejected");
  assert.match(run.result.summary, /stale-fencing-token/);
});

async function withStore<T>(fn: (store: ArtifactStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-autospec-verify-"));
  try {
    return await fn(await ArtifactStore.create(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("verifier: a remote success with stage output yields passed stages and observed evidence", async () => {
  await withStore(async (store) => {
    const { adapter, calls } = fake([
      {
        state: "succeeded",
        sequence: 2,
        stages: [
          { name: "typecheck", command: "npm run typecheck", exitCode: 0, output: "tsc: no errors" },
          { name: "test", command: "npm test", exitCode: 0, output: "# pass 12" },
        ],
      },
    ]);
    const provider = new AutoSpecVerificationProvider(adapter, owner, fast);
    const profile = await provider.detect("/tmp");
    const outcome = await provider.run("/tmp", profile, store, { boundBaseSha: "abc123" });
    assert.equal(outcome.passed, true);
    assert.deepEqual(
      outcome.stages.map((s) => s.stage.name),
      ["typecheck", "test"],
    );
    assert.equal(outcome.evidence.length, 2);
    assert.ok(outcome.evidence.every((e) => e.trust === "observed" && e.artifacts.length === 1));
    assert.equal(calls.submit[0]!.baseSha, "abc123");
  });
});

test("verifier: a remote success with no stage output is a failed outcome", async () => {
  await withStore(async (store) => {
    for (const stages of [undefined, [], [{ name: "test", command: "npm test", exitCode: 0, output: "  " }]]) {
      const { adapter } = fake([{ state: "succeeded", sequence: 2, ...(stages ? { stages } : {}) }]);
      const provider = new AutoSpecVerificationProvider(adapter, owner, fast);
      const outcome = await provider.run("/tmp", await provider.detect("/tmp"), store);
      assert.equal(outcome.passed, false, JSON.stringify(stages));
      assert.equal(outcome.failedStage, "autospec-report");
      assert.equal(outcome.evidence.length, 0);
      assert.match(outcome.warnings?.join(" ") ?? "", /stage output/);
    }
  });
});

test("verifier: a failing remote stage fails the outcome; a failed remote run fails it too", async () => {
  await withStore(async (store) => {
    const bad = fake([
      {
        state: "succeeded",
        sequence: 2,
        stages: [{ name: "test", command: "npm test", exitCode: 1, output: "# fail 1" }],
      },
    ]);
    const p1 = new AutoSpecVerificationProvider(bad.adapter, owner, fast);
    const o1 = await p1.run("/tmp", await p1.detect("/tmp"), store);
    assert.equal(o1.passed, false);
    assert.equal(o1.failedStage, "test");
    const dead = fake([{ state: "failed", sequence: 2 }]);
    const p2 = new AutoSpecVerificationProvider(dead.adapter, owner, fast);
    const o2 = await p2.run("/tmp", await p2.detect("/tmp"), store);
    assert.equal(o2.passed, false);
    assert.equal(o2.failedStage, "autospec-report");
  });
});

test("verifier: an AbortSignal during observe triggers exactly one cancel", async () => {
  await withStore(async (store) => {
    const { adapter, calls } = fake(["hang"]);
    const controller = new AbortController();
    const provider = new AutoSpecVerificationProvider(adapter, owner, fast);
    const pending = provider.run("/tmp", await provider.detect("/tmp"), store, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const outcome = await pending;
    assert.equal(outcome.passed, false);
    assert.equal(calls.cancel.length, 1);
  });
});
