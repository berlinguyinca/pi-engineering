/**
 * Verify-before-revoke handoff protocol: ordering, rejection, crash recovery at every stage,
 * duplicate / out-of-order lineage, single writer, 10+ sequential handoffs, cross-host and cross-model.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { CheckpointManager } from "../../src/orchestration/checkpoints.ts";
import {
  type ExecuteHandoffInput,
  type HandoffVerifyDeps,
  composeFences,
  executeHandoff,
  fenceExecutionWriter,
  fenceMissionLease,
  verifyHandoffCheckpoint,
} from "../../src/orchestration/handoffProtocol.ts";
import { HandoffRecordError, MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import type { TaskCheckpoint, WorkspaceManifest } from "../../src/orchestration/types.ts";
import type { EventStoreBackend } from "../../src/platform/eventstore/backend.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { EnvelopeV2 } from "../../src/runtime/herdr/envelope.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { type LineageEmitter, createLineageEmitter } from "../../src/runtime/herdr/lineage.ts";
import type { HandoffRecord } from "../../src/runtime/host/handoffKinds.ts";

const MISSION = "MSN-hp";
const ARTIFACT = "artifact://run/out.json";
const ARTIFACT_HASH = `sha256:${"1".repeat(64)}`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sha(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function manifest(): WorkspaceManifest {
  return {
    manifestId: "WM-hp",
    missionId: MISSION,
    generation: 1,
    authorizedRoots: [{ canonicalPath: "/repo", source: "existing_manifest", access: "write" }],
    repositories: [
      { repoId: "repo-a", canonicalRoot: "/repo", baseRef: "main", baseSha: "base-a", writableDomains: ["src/**"] },
    ],
    dependencyEdges: [],
    hash: "hash-hp",
    createdAt: "2026-09-26T10:00:00.000Z",
  };
}

function rig(backend: EventStoreBackend = JsonlEventStore.inMemory(), emitter?: LineageEmitter) {
  const store = MissionStore.open(backend);
  if (emitter) store.setLineage(emitter);
  store.createMission({
    mission_id: MISSION,
    title: "t",
    goal: "g",
    user_request: "u",
    repository: "/repo",
    base_ref: "base-a",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  store.bindWorkspaceManifest(manifest());
  const task = store.createTask({
    task_id: "task-a",
    mission_id: MISSION,
    kind: "agent",
    role: "implementer",
    objective: "implement",
    repo_id: "repo-a",
    acceptance_ids: ["AC-1"],
    deliverables: ["implementation"],
    execution_budget_ms: 60_000,
    checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
    candidate_generation: 0,
    mission_generation: 0,
    fencing_token: 0,
  });
  const execution = store.createExecution({
    task_id: task.task_id,
    mission_id: MISSION,
    backend: "agent",
    checkpoint_id: "TCP-hp",
    repo_id: "repo-a",
    base_sha: "base-a",
  });
  store.setExecutionStatus(execution.execution_id, "RUNNING", {});
  return { store, backend, task, execution };
}

function deps(over: Partial<HandoffVerifyDeps> = {}): HandoffVerifyDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hashArtifact: async (ref) => {
      calls.push(`hash:${ref}`);
      return ref === ARTIFACT ? ARTIFACT_HASH : null;
    },
    commitExists: async () => true,
    ...over,
  };
}

async function checkpointFor(
  store: MissionStore,
  taskId: string,
  executionId: string,
  n: number,
  opts: { session?: string; model?: string; handoff?: boolean; artifactHash?: string } = {},
): Promise<TaskCheckpoint> {
  return new CheckpointManager({ store }).persist({
    taskId,
    executionId,
    sessionId: opts.session ?? `sess-${n}`,
    model: opts.model ?? "model-a",
    artifactRefs: [ARTIFACT],
    artifactHashes: [opts.artifactHash ?? ARTIFACT_HASH],
    snapshot: {
      candidateSha: sha(n),
      branch: "feat/x",
      worktree: "/wt/shared",
      committedChanges: [],
      preservedUncommittedChanges: [],
    },
    ...(opts.handoff === false ? {} : { handoff: { memoryRefs: [`viking://m/${n}`] } }),
  });
}

function record(n: number, over: Partial<HandoffRecord> = {}): Record<string, unknown> {
  return {
    id: `hf-${n}`,
    kind: "context",
    state: "prepared",
    missionId: MISSION,
    predecessor: { sessionId: `sess-${n}`, generation: n - 1 },
    checkpointSha: sha(n),
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function spy() {
  const log: string[] = [];
  return { log, fence: async () => void log.push("fence") };
}

function input(
  store: MissionStore,
  n: number,
  checkpoint: TaskCheckpoint,
  d: HandoffVerifyDeps,
  fenceSource: () => Promise<void>,
): ExecuteHandoffInput {
  return {
    handoffId: `hf-${n}`,
    checkpoint,
    successor: { sessionId: `sess-${n + 1}`, generation: n },
    deps: d,
    fenceSource,
  };
}

const handoffEvents = (backend: EventStoreBackend) =>
  backend.all().filter((e) => e.type === "handoff.created" || e.type === "handoff.transitioned");

describe("verifyHandoffCheckpoint", () => {
  it("accepts a complete checkpoint and reports skipped checks instead of passing them", async () => {
    const { store, task, execution } = rig();
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
    const rec = store.addHandoffRecord(record(1));
    const strict = await verifyHandoffCheckpoint(rec, cp, deps({ commitExists: async () => null }));
    assert.equal(strict.ok, false, "an unverifiable commit fails by default");
    const ok = await verifyHandoffCheckpoint(
      rec,
      cp,
      deps({ commitExists: async () => null, allowUnverifiable: true }),
    );
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.ok && ok.skipped, ["commit existence: repository not resolvable"]);
  });

  it("reports every problem, not just the first", async () => {
    const { store, task, execution } = rig();
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1, { handoff: false });
    const rec = store.addHandoffRecord(record(1, { predecessor: { sessionId: "other", generation: 0 } }));
    const res = await verifyHandoffCheckpoint(
      rec,
      cp,
      deps({ commitExists: async () => false, hashArtifact: async () => null }),
    );
    assert.equal(res.ok, false);
    const text = !res.ok ? res.errors.join("|") : "";
    for (const part of ["predecessor", "handoff context", "cannot be read", "does not exist"]) {
      assert.match(text, new RegExp(part));
    }
  });

  it("checks untracked file hashes when a hasher is supplied", async () => {
    const { store, task, execution } = rig();
    const cp = await new CheckpointManager({ store }).persist({
      taskId: task.task_id,
      executionId: execution.execution_id,
      sessionId: "sess-1",
      snapshot: {
        candidateSha: sha(1),
        branch: "b",
        worktree: "/wt/shared",
        committedChanges: [],
        preservedUncommittedChanges: [],
        untracked: [{ path: "scratch.txt", sha256: "a".repeat(64) }],
      },
    });
    const rec = store.addHandoffRecord(record(1));
    const bad = await verifyHandoffCheckpoint(rec, cp, deps({ hashFile: async () => "b".repeat(64) }));
    assert.equal(bad.ok, false);
    const good = await verifyHandoffCheckpoint(rec, cp, deps({ hashFile: async () => "a".repeat(64) }));
    assert.equal(good.ok, true);
  });
});

describe("ordering cannot be bypassed through the store API", () => {
  it("pre-stamped records, and the public transition stay gated; a record without a checkpoint sha keeps the legacy path", async () => {
    const { store } = rig();
    const stamped = store.addHandoffRecord(
      record(1, { verifiedAt: new Date().toISOString(), sourceFencedAt: new Date().toISOString() }),
    );
    assert.equal(stamped.verifiedAt, undefined, "stamps supplied by a caller are dropped");
    const succ = { sessionId: "sess-2", generation: 1 };
    store.transitionHandoffRecord("hf-1", "validated");
    assert.throws(() => store.transitionHandoffRecord("hf-1", "acknowledged", succ), /verified and its source fenced/);
    // Documented limit: a record naming no checkpoint has nothing to verify, so the legacy direct path stays open
    // for it (phase-boundary handoffs without a checkpoint). executeHandoff never accepts such a record.
    store.addHandoffRecord(record(2, { checkpointSha: undefined }));
    store.transitionHandoffRecord("hf-2", "validated");
    assert.equal(store.acknowledgeHandoff("hf-2", succ).state, "acknowledged");
  });

  it("a fenced source is never left unacknowledged because evidence changed after the fence", async () => {
    const { store, task, execution } = rig();
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
    store.addHandoffRecord(record(1));
    await store.verifyHandoff("hf-1", cp, deps());
    await store.fenceHandoffSource("hf-1", async () => {});
    const out = await executeHandoff(
      store,
      input(store, 1, cp, deps({ hashArtifact: async () => null }), async () => {}),
    );
    assert.equal(out.status, "acknowledged");
  });
});

describe("verify before revoke", () => {
  const failures: Array<
    [
      string,
      (d: ReturnType<typeof deps>) => void,
      { artifactHash?: string; handoff?: boolean; session?: string },
      RegExp,
    ]
  > = [
    ["artifact hash mismatch", () => {}, { artifactHash: `sha256:${"2".repeat(64)}` }, /hash mismatch/],
    [
      "artifact unreadable",
      (d) => {
        d.hashArtifact = async () => null;
      },
      {},
      /cannot be read/,
    ],
    [
      "candidate commit missing from the worktree repo",
      (d) => {
        d.commitExists = async () => false;
      },
      {},
      /does not exist/,
    ],
    ["no handoff context", () => {}, { handoff: false }, /no handoff context/],
    ["checkpoint from a different session", () => {}, { session: "intruder" }, /not written by the predecessor/],
  ];
  for (const [name, mutate, cpOpts, pattern] of failures) {
    it(`a checkpoint failing verification (${name}) leaves the lease intact and the record un-advanced`, async () => {
      const { store, task, execution } = rig();
      const ownership = new MissionOwnership(store, { ownerId: "pi-a", leaseMs: 60_000 });
      const lease = await ownership.acquire(MISSION);
      const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1, { session: "sess-1", ...cpOpts });
      store.addHandoffRecord(record(1));
      const d = deps();
      mutate(d);
      const f = spy();
      const out = await executeHandoff(
        store,
        input(store, 1, cp, d, composeFences(fenceMissionLease(store, ownership, lease), f.fence)),
      );
      assert.equal(out.status, "rejected");
      assert.ok(out.status === "rejected" && out.errors.some((e) => pattern.test(e)), JSON.stringify(out));
      assert.ok(out.status === "rejected" && out.fallback.fallback === "fresh_restart");
      const after = store.getHandoffRecord("hf-1");
      assert.equal(after?.state, "prepared");
      assert.equal(after?.verifiedAt, undefined);
      assert.equal(after?.sourceFencedAt, undefined);
      assert.deepEqual(f.log, [], "the fence never ran");
      assert.equal(store.getMissionLease(MISSION)?.fencingToken, lease.fencingToken, "source lease untouched");
      assert.equal(store.getExecution(execution.execution_id)?.status, "RUNNING");
    });
  }

  it("runs verify, then fence, then acknowledge, each stamped in that order", async () => {
    const { store, task, execution } = rig();
    const ownership = new MissionOwnership(store, { ownerId: "pi-a", leaseMs: 60_000 });
    const lease = await ownership.acquire(MISSION);
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
    store.addHandoffRecord(record(1));
    const d = deps();
    const order: string[] = [];
    const hash = d.hashArtifact;
    d.hashArtifact = async (ref) => {
      order.push("verify");
      return hash(ref);
    };
    const out = await executeHandoff(
      store,
      input(store, 1, cp, d, async () => {
        order.push("fence");
        assert.equal(store.getHandoffRecord("hf-1")?.state, "validated", "fence runs on a verified record");
        await fenceMissionLease(store, ownership, lease)();
      }),
    );
    assert.equal(out.status, "acknowledged");
    assert.deepEqual(order, ["verify", "fence"]);
    const rec = store.getHandoffRecord("hf-1") as HandoffRecord;
    assert.equal(rec.state, "acknowledged");
    assert.ok(rec.verifiedAt && rec.sourceFencedAt && rec.ackAt);
    assert.ok(Date.parse(rec.verifiedAt) <= Date.parse(rec.sourceFencedAt));
    assert.ok(Date.parse(rec.sourceFencedAt) <= Date.parse(rec.ackAt));
    assert.equal(store.getMissionLease(MISSION), undefined, "source lease fenced");
  });

  it("the state machine itself refuses out-of-order steps", async () => {
    const { store, task, execution } = rig();
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
    store.addHandoffRecord(record(1));
    const succ = { sessionId: "sess-2", generation: 1 };
    await assert.rejects(
      store.fenceHandoffSource("hf-1", async () => {}),
      /must be verified/,
    );
    assert.throws(() => store.acknowledgeHandoff("hf-1", succ), HandoffRecordError);
    assert.equal(store.transitionHandoffRecord("hf-1", "validated").state, "validated", "legacy step stays legal");
    // verified but not fenced: still cannot acknowledge
    store.addHandoffRecord(record(2));
    const cp2 = await checkpointFor(store, task.task_id, execution.execution_id, 2);
    assert.equal((await store.verifyHandoff("hf-2", cp2, deps())).ok, true);
    assert.throws(
      () => store.acknowledgeHandoff("hf-2", { sessionId: "sess-3", generation: 2 }),
      /verified and its source fenced/,
    );
    assert.throws(
      () => store.transitionHandoffRecord("hf-2", "acknowledged", { sessionId: "sess-3", generation: 2 }),
      /verified and its source fenced/,
    );
    assert.equal(store.getHandoffRecord("hf-2")?.state, "validated");
    void cp;
  });

  it("a failing fence leaves the record validated and unacknowledged, and a retry completes it", async () => {
    const { store, task, execution } = rig();
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
    store.addHandoffRecord(record(1));
    let fail = true;
    const fence = async () => {
      if (fail) throw new Error("kill -9 refused");
    };
    const first = await executeHandoff(store, input(store, 1, cp, deps(), fence));
    assert.equal(first.status, "fence_failed");
    assert.equal(store.getHandoffRecord("hf-1")?.state, "validated");
    assert.equal(store.getHandoffRecord("hf-1")?.sourceFencedAt, undefined);
    fail = false;
    assert.equal((await executeHandoff(store, input(store, 1, cp, deps(), fence))).status, "acknowledged");
  });

  it("a record without a checkpoint sha can never be verified", async () => {
    const { store, task, execution } = rig();
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
    store.addHandoffRecord(record(1, { checkpointSha: undefined }));
    const out = await executeHandoff(
      store,
      input(store, 1, cp, deps(), async () => {}),
    );
    assert.equal(out.status, "rejected");
  });
});

describe("crash at each handoff stage, then restart by replay", () => {
  type Stage = "prepared" | "validated" | "fenced" | "acknowledged" | "committed";
  const stages: Stage[] = ["prepared", "validated", "fenced", "acknowledged", "committed"];

  for (const stage of stages) {
    it(`crash after ${stage}: the reopened store recovers idempotently with exactly one acknowledgement`, async () => {
      const first = rig();
      const { backend, task, execution } = first;
      let store = first.store;
      const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
      store.addHandoffRecord(record(1));
      const d = deps();
      const fenced: string[] = [];
      const fence = async () => void fenced.push("fence");
      const succ = { sessionId: "sess-2", generation: 1 };
      if (stage !== "prepared") await store.verifyHandoff("hf-1", cp, d);
      if (stage === "fenced" || stage === "acknowledged" || stage === "committed") {
        await store.fenceHandoffSource("hf-1", fence);
        fenced.length = 0; // fences before the crash do not count toward recovery
      }
      if (stage === "acknowledged" || stage === "committed") store.acknowledgeHandoff("hf-1", succ);
      if (stage === "committed") store.transitionHandoffRecord("hf-1", "committed");
      await store.flush();

      // crash: the process is gone, only the durable event history remains
      store = MissionStore.open(backend);
      const restored = store.getHandoffRecord("hf-1") as HandoffRecord;
      assert.equal(restored.state, stage === "fenced" ? "validated" : stage, "state survives replay");
      assert.equal(Boolean(restored.verifiedAt), stage !== "prepared");
      assert.equal(Boolean(restored.sourceFencedAt), ["fenced", "acknowledged", "committed"].includes(stage));

      const cpAgain = store.getTaskCheckpoint("TCP-hp") as TaskCheckpoint;
      const out = await executeHandoff(store, input(store, 1, cpAgain, d, fence));
      assert.equal(
        out.status,
        stage === "acknowledged" || stage === "committed" ? "already_acknowledged" : "acknowledged",
      );
      assert.equal(
        fenced.length,
        ["prepared", "validated"].includes(stage) ? 1 : 0,
        "source fenced exactly once overall",
      );

      // a second recovery pass changes nothing: no duplicate acknowledgement
      await store.flush();
      const events = handoffEvents(backend).length;
      const again = await executeHandoff(store, input(store, 1, cpAgain, d, fence));
      assert.equal(again.status, "already_acknowledged");
      await store.flush();
      assert.equal(handoffEvents(backend).length, events, "idempotent: no further handoff events");
      const acks = handoffEvents(backend).filter(
        (e) => (e.payload as { handoff?: HandoffRecord }).handoff?.state === "acknowledged",
      );
      assert.equal(acks.length, 1, "exactly one acknowledgement event in the durable history");
      assert.equal(MissionStore.open(backend).getHandoffRecord("hf-1")?.successor?.sessionId, "sess-2");
    });
  }

  it("a different successor cannot re-acknowledge a settled handoff", async () => {
    const { store, task, execution } = rig();
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
    store.addHandoffRecord(record(1));
    await executeHandoff(
      store,
      input(store, 1, cp, deps(), async () => {}),
    );
    await assert.rejects(
      executeHandoff(store, {
        ...input(store, 1, cp, deps(), async () => {}),
        successor: { sessionId: "evil", generation: 1 },
      }),
      /different successor/,
    );
  });

  it("a crash during the fence itself retries the fence; the replayed record shows it was never stamped", async () => {
    const { store, backend, task, execution } = rig();
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
    store.addHandoffRecord(record(1));
    let side = 0;
    await assert.rejects(
      store.verifyHandoff("hf-1", cp, deps()).then(() =>
        store.fenceHandoffSource("hf-1", async () => {
          side++; // the side effect happened, then the process died before the stamp
          throw new Error("crash");
        }),
      ),
      /crash/,
    );
    await store.flush();
    const reopened = MissionStore.open(backend);
    assert.equal(reopened.getHandoffRecord("hf-1")?.sourceFencedAt, undefined);
    const out = await executeHandoff(
      reopened,
      input(reopened, 1, reopened.getTaskCheckpoint("TCP-hp") as TaskCheckpoint, deps(), async () => void side++),
    );
    assert.equal(out.status, "acknowledged");
    assert.equal(side, 2, "the fence is retried, so fences must be idempotent (lease fence and writer fence are)");
  });
});

describe("single writer during a handoff", () => {
  it("the predecessor loses write authority at the fence, before the successor is acknowledged", async () => {
    const { store, task, execution } = rig();
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
    store.addHandoffRecord(record(1));
    const writers = (): number => {
      let n = 0;
      for (const ex of store.listExecutions(MISSION)) {
        try {
          store.assertExecutionAuthoritative(ex.execution_id);
          n++;
        } catch {
          // not authoritative
        }
      }
      return n;
    };
    const seen: number[] = [writers()];
    const fence = composeFences(
      fenceExecutionWriter(store, execution.execution_id),
      async () => void seen.push(writers()),
    );
    const out = await executeHandoff(store, input(store, 1, cp, deps(), fence));
    assert.equal(out.status, "acknowledged");
    // successor attempt starts only after the acknowledgement
    const successor = store.createExecution({
      task_id: task.task_id,
      mission_id: MISSION,
      backend: "agent",
      checkpoint_id: "TCP-hp2",
      repo_id: "repo-a",
      base_sha: "base-a",
    });
    store.setExecutionStatus(successor.execution_id, "RUNNING", {});
    store.assignTaskExecution(task.task_id, successor.execution_id);
    seen.push(writers());
    assert.deepEqual(seen, [1, 0, 1], "never two writers: one, none at the fence, one again");
    await assert.rejects(
      new CheckpointManager({ store }).persist({ taskId: task.task_id, executionId: execution.execution_id }),
      /authoritative|origin mismatch|stale/,
    );
  });

  it("the successor cannot be acknowledged while the predecessor still writes", async () => {
    const { store, task, execution } = rig();
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
    store.addHandoffRecord(record(1));
    await store.verifyHandoff("hf-1", cp, deps());
    assert.throws(() => store.acknowledgeHandoff("hf-1", { sessionId: "sess-2", generation: 1 }), HandoffRecordError);
    store.assertExecutionAuthoritative(execution.execution_id); // predecessor is still the one writer
  });

  it("a fence that targets a lease held at another epoch refuses to touch it", async () => {
    const { store } = rig();
    const ownership = new MissionOwnership(store, { ownerId: "pi-a", leaseMs: 60_000 });
    const lease = await ownership.acquire(MISSION);
    await assert.rejects(
      fenceMissionLease(store, ownership, { ...lease, fencingToken: lease.fencingToken + 7 })(),
      /different epoch/,
    );
    assert.ok(store.getMissionLease(MISSION));
  });
});

// ── lineage-level properties ───────────────────────────────────────────────────

function lineageRig(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "pi-hp-"));
  dirs.push(dir);
  const envelopes = new EnvelopeStore({ dir, source });
  const emitter = createLineageEmitter({ store: envelopes }, { host: source }) as LineageEmitter;
  return { envelopes, emitter };
}

async function events(r: ReturnType<typeof lineageRig>): Promise<EnvelopeV2[]> {
  await r.emitter.idle();
  return (await r.envelopes.outbox.pending()).filter((e) => e.entity_type === "lineage");
}

const handoffEdges = (evs: EnvelopeV2[]) =>
  evs
    .filter((e) => e.event_type === "edge.add" && e.payload.edge_type === "handoff")
    .map((e) => `${e.payload.from_id}>${e.payload.to_id}`);

describe("duplicate and out-of-order lineage events", () => {
  it("replaying acknowledgement, committed-before-acknowledged and prepared-after-committed adds no second edge", async () => {
    const lr = lineageRig("pi-hosta-00000001");
    const base = {
      id: "hf-x",
      kind: "context" as const,
      missionId: MISSION,
      fromSession: "s1",
      toSession: "s2",
      checkpointSha: sha(1),
    };
    const at = "2026-10-29T10:00:00.000Z";
    lr.emitter.handoff({ ...base, state: "committed", at });
    lr.emitter.handoff({ ...base, state: "acknowledged", at });
    lr.emitter.handoff({ ...base, state: "acknowledged", at });
    lr.emitter.handoff({ ...base, state: "prepared", at });
    lr.emitter.handoff({ ...base, state: "committed", at });
    const evs = await events(lr);
    assert.deepEqual(handoffEdges(evs), ["session:s1>session:s2"], "one edge key however the states arrive");
    const ids = evs.map((e) => e.event_id);
    assert.equal(new Set(ids).size, ids.length, "no duplicate event ids");
  });

  it("the same transition sequence on another host yields identical node and edge identities", async () => {
    const a = lineageRig("pi-hosta-00000001");
    const b = lineageRig("pi-hostb-00000002");
    for (const lr of [a, b]) {
      const { store, task, execution } = rig(JsonlEventStore.inMemory(), lr.emitter);
      const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
      store.addHandoffRecord(record(1));
      await executeHandoff(
        store,
        input(store, 1, cp, deps(), async () => {}),
      );
      await store.flush();
    }
    const keys = (evs: EnvelopeV2[]) =>
      evs
        .filter((e) => e.event_type === "node.upsert" || e.event_type === "edge.add")
        .map((e) =>
          `${e.event_type}:${e.payload.node_id ?? `${e.payload.from_id}>${e.payload.to_id}`}`.replace(
            /EXC-\w+/g,
            "EXC",
          ),
        )
        .sort();
    const ea = await events(a);
    const eb = await events(b);
    assert.deepEqual(keys(eb), keys(ea));
    assert.ok(!ea.some((e) => eb.some((o) => o.event_id === e.event_id)), "event ids stay source-bound");
  });

  it("the store ignores a replayed acknowledgement: lineage sees each transition once", async () => {
    const lr = lineageRig("pi-hosta-00000001");
    const { store, task, execution } = rig(JsonlEventStore.inMemory(), lr.emitter);
    const cp = await checkpointFor(store, task.task_id, execution.execution_id, 1);
    store.addHandoffRecord(record(1));
    await executeHandoff(
      store,
      input(store, 1, cp, deps(), async () => {}),
    );
    const once = (await events(lr)).length;
    for (let i = 0; i < 3; i++)
      await executeHandoff(
        store,
        input(store, 1, cp, deps(), async () => {}),
      );
    assert.equal((await events(lr)).length, once);
  });
});

describe("ten and more sequential handoffs through the real state machine", () => {
  it("12 verified handoffs form one chain, leases fence and re-acquire, and replay reproduces every record", async () => {
    const lr = lineageRig("pi-hosta-00000001");
    const first = rig(JsonlEventStore.inMemory(), lr.emitter);
    const { store, backend, task, execution } = first;
    const ownership = new MissionOwnership(store, { ownerId: "pi-a", leaseMs: 60_000 });
    const N = 12;
    let generation = 0;
    for (let n = 1; n <= N; n++) {
      const lease = await ownership.acquire(MISSION);
      assert.equal(
        lease.generation,
        ++generation,
        "each handoff leaves a fenced lease; the next holder gets a new epoch",
      );
      const cp = await checkpointFor(store, task.task_id, execution.execution_id, n);
      store.addHandoffRecord(record(n));
      const out = await executeHandoff(store, input(store, n, cp, deps(), fenceMissionLease(store, ownership, lease)));
      assert.equal(out.status, "acknowledged", `handoff ${n}`);
      assert.equal(store.getMissionLease(MISSION), undefined);
    }
    const records = store.listHandoffRecords(MISSION);
    assert.equal(records.length, N);
    for (const [i, r] of records.entries()) {
      assert.equal(r.state, "acknowledged");
      assert.equal(r.predecessor.sessionId, `sess-${i + 1}`);
      assert.equal(r.successor?.sessionId, `sess-${i + 2}`);
      if (i > 0) assert.equal(r.predecessor.sessionId, records[i - 1]?.successor?.sessionId, "chain is contiguous");
    }
    await store.flush();
    const replayed = MissionStore.open(backend).listHandoffRecords(MISSION);
    assert.deepEqual(
      replayed.map((r) => [r.id, r.state, r.successor?.sessionId, Boolean(r.verifiedAt && r.sourceFencedAt)]),
      records.map((r) => [r.id, r.state, r.successor?.sessionId, true]),
    );
    const evs = await events(lr);
    // each hop is observed twice (the explicit record and the session-id change) but under one edge key
    assert.deepEqual(
      [...new Set(handoffEdges(evs))],
      Array.from({ length: N }, (_, i) => `session:sess-${i + 1}>session:sess-${i + 2}`),
    );
    const logical = new Set(evs.map((e) => String(e.payload.node_id)).filter((id) => /^(agent|attempt):/.test(id)));
    assert.equal(logical.size, 2, "one logical agent and one attempt across all 12 handoffs");
  });
});

describe("cross-host and cross-model handoff", () => {
  it("a handoff verified on host A and completed on host B keeps the agent id and moves the edge to B's source", async () => {
    const a = lineageRig("pi-hosta-00000001");
    const b = lineageRig("pi-hostb-00000002");
    const first = rig(JsonlEventStore.inMemory(), a.emitter);
    const cp = await checkpointFor(first.store, first.task.task_id, first.execution.execution_id, 1);
    first.store.addHandoffRecord(record(1));
    assert.equal((await first.store.verifyHandoff("hf-1", cp, deps())).ok, true);
    await first.store.flush();

    // host B takes over the durable history; the source execution died with host A
    const store = MissionStore.open(first.backend);
    store.setLineage(b.emitter);
    const oldAttempt = first.execution.execution_id;
    const out = await executeHandoff(
      store,
      input(
        store,
        1,
        store.getTaskCheckpoint("TCP-hp") as TaskCheckpoint,
        deps(),
        fenceExecutionWriter(store, oldAttempt),
      ),
    );
    assert.equal(out.status, "acknowledged");
    const eb = await events(b);
    assert.ok(eb.every((e) => e.source === "pi-hostb-00000002"));
    assert.deepEqual(handoffEdges(eb), ["session:sess-1>session:sess-2"]);
    const handoffNode = eb.find((e) => e.event_type === "node.upsert" && e.payload.node_id === "handoff:hf-1");
    assert.equal((handoffNode?.payload.attrs as Record<string, unknown>).host, "pi-hostb-00000002");
    const ea = await events(a);
    const agents = (evs: EnvelopeV2[]) =>
      new Set(evs.map((e) => String(e.payload.node_id)).filter((id) => id.startsWith("agent:")));
    for (const id of agents(eb))
      assert.ok(agents(ea).has(id) || id === "agent:task-a", "same logical agent on both hosts");
    const sessionHostA = ea.find((e) => e.payload.node_id === "session:sess-1" && e.event_type === "node.upsert");
    assert.equal(
      (sessionHostA?.payload.attrs as Record<string, unknown> | undefined)?.host ?? "pi-hosta-00000001",
      "pi-hosta-00000001",
    );
  });

  it("a model change across the handoff keeps the logical agent and attempt (rollover) and starts a new attempt only on reassignment", async () => {
    const lr = lineageRig("pi-hosta-00000001");
    const { store, task, execution } = rig(JsonlEventStore.inMemory(), lr.emitter);
    const cp1 = await checkpointFor(store, task.task_id, execution.execution_id, 1, { model: "claude-sonnet" });
    store.addHandoffRecord(record(1));
    assert.equal(
      (await executeHandoff(store, input(store, 1, cp1, deps(), fenceExecutionWriter(store, execution.execution_id))))
        .status,
      "acknowledged",
    );
    // the writer was fenced by the handoff, so the successor model works in a fresh attempt of the same task
    const next = store.createExecution({
      task_id: task.task_id,
      mission_id: MISSION,
      backend: "agent",
      checkpoint_id: "TCP-hp-b",
      repo_id: "repo-a",
      base_sha: "base-a",
    });
    store.setExecutionStatus(next.execution_id, "RUNNING", {});
    store.assignTaskExecution(task.task_id, next.execution_id);
    const cp2 = await new CheckpointManager({ store }).persist({
      taskId: task.task_id,
      executionId: next.execution_id,
      sessionId: "sess-2",
      model: "pi-local-27b",
    });
    assert.equal(cp1.model, "claude-sonnet");
    assert.equal(cp2.model, "pi-local-27b");
    const evs = await events(lr);
    const nodes = (prefix: string) =>
      new Set(
        evs
          .filter((e) => e.event_type === "node.upsert")
          .map((e) => String(e.payload.node_id))
          .filter((id) => id.startsWith(prefix)),
      );
    assert.deepEqual([...nodes("agent:")], ["agent:task-a"], "one logical agent across the model change");
    assert.ok(nodes("attempt:").has(`attempt:${execution.execution_id}`));
    assert.ok(nodes("attempt:").has(`attempt:${next.execution_id}`), "reassignment is a new attempt");
    assert.deepEqual(handoffEdges(evs), ["session:sess-1>session:sess-2"]);
  });

  it("a model change inside one attempt is a rollover: same agent, same attempt, new session", async () => {
    const lr = lineageRig("pi-hosta-00000001");
    const { store, task, execution } = rig(JsonlEventStore.inMemory(), lr.emitter);
    await checkpointFor(store, task.task_id, execution.execution_id, 1, { model: "claude-sonnet" });
    await checkpointFor(store, task.task_id, execution.execution_id, 2, { model: "pi-local-27b" });
    const evs = await events(lr);
    const ids = new Set(evs.filter((e) => e.event_type === "node.upsert").map((e) => String(e.payload.node_id)));
    assert.ok(ids.has("agent:task-a") && ids.has(`attempt:${execution.execution_id}`));
    assert.ok(ids.has("session:sess-1") && ids.has("session:sess-2"));
    assert.equal([...ids].filter((id) => id.startsWith("attempt:")).length, 1);
  });
});
