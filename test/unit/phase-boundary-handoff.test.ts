/**
 * Unit + in-process tests for the phase-boundary handoff (spec Unit B1,
 * issue #349): the pure decision module, the store lifecycle transition, and
 * the orchestrator hook that emits a `phase_transition` HandoffRecord at a
 * phase boundary under context pressure.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import {
  PHASE_HANDOFF_THRESHOLD,
  type PhaseHandoffExecution,
  buildPhaseTransitionRecord,
  missionContextUtilization,
  phaseHandoffFallback,
  shouldEmitPhaseHandoff,
} from "../../src/orchestration/phaseBoundaryHandoff.ts";
import type { Mission, TaskCheckpoint } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { type HandoffRecord, validateHandoffRecord } from "../../src/runtime/host/handoffKinds.ts";
import { decideHandoffResume } from "../../src/runtime/host/handoffResume.ts";

const NOW = () => new Date("2026-10-19T12:00:00.000Z");

// ── pure: missionContextUtilization ───────────────────────────────────────────

describe("missionContextUtilization", () => {
  const window = (model: string): number | null => (model === "gw/test" ? 128000 : null);

  it("returns null with no executions", () => {
    assert.equal(missionContextUtilization([], window), null);
  });

  it("returns null when the model has no known window", () => {
    const exec: PhaseHandoffExecution = { model: "gw/unknown", usage: { contextTokens: 100 } };
    assert.equal(missionContextUtilization([exec], window), null);
  });

  it("returns null when usage carries no token data", () => {
    const exec: PhaseHandoffExecution = { model: "gw/test", usage: {} };
    assert.equal(missionContextUtilization([exec], window), null);
  });

  it("computes the max ratio across executions using contextTokens", () => {
    const hot: PhaseHandoffExecution = { model: "gw/test", usage: { contextTokens: 96000 } };
    const cool: PhaseHandoffExecution = { model: "gw/test", usage: { contextTokens: 32000 } };
    assert.equal(missionContextUtilization([cool, hot], window), 96000 / 128000);
  });

  it("falls back to cumulative input when contextTokens is absent", () => {
    const exec: PhaseHandoffExecution = { model: "gw/test", usage: { input: 64000 } };
    assert.equal(missionContextUtilization([exec], window), 64000 / 128000);
  });

  it("clamps to 1", () => {
    const exec: PhaseHandoffExecution = { model: "gw/test", usage: { contextTokens: 500000 } };
    assert.equal(missionContextUtilization([exec], window), 1);
  });
});

// ── pure: shouldEmitPhaseHandoff ──────────────────────────────────────────────

describe("shouldEmitPhaseHandoff", () => {
  it("does not emit at mission start (no predecessor phase)", () => {
    const d = shouldEmitPhaseHandoff({ fromPhase: null, toPhase: "classified", contextUtilization: 1 });
    assert.equal(d.emit, false);
    assert.match(d.reason, /no predecessor phase/);
  });

  it("does not emit when the phase did not change", () => {
    const d = shouldEmitPhaseHandoff({ fromPhase: "executing", toPhase: "executing", contextUtilization: 1 });
    assert.equal(d.emit, false);
    assert.match(d.reason, /not a phase boundary/);
  });

  it("does not emit without utilization data", () => {
    const d = shouldEmitPhaseHandoff({
      fromPhase: "classified",
      toPhase: "executing",
      contextUtilization: null,
    });
    assert.equal(d.emit, false);
    assert.match(d.reason, /no context utilization data/);
  });

  it("does not emit below the threshold", () => {
    const d = shouldEmitPhaseHandoff({ fromPhase: "classified", toPhase: "executing", contextUtilization: 0.69 });
    assert.equal(d.emit, false);
    assert.match(d.reason, /below/);
  });

  it("emits at the default threshold", () => {
    const d = shouldEmitPhaseHandoff({ fromPhase: "classified", toPhase: "executing", contextUtilization: 0.7 });
    assert.equal(d.emit, true);
    assert.match(d.reason, />=/);
  });

  it("honours a custom threshold", () => {
    const d = shouldEmitPhaseHandoff({
      fromPhase: "classified",
      toPhase: "executing",
      contextUtilization: 0.6,
      threshold: 0.5,
    });
    assert.equal(d.emit, true);
  });

  it("exposes the standard threshold", () => {
    // One threshold triple: the phase boundary hands off at the `soft` level (0.70), was a separate 0.75.
    assert.equal(PHASE_HANDOFF_THRESHOLD, 0.7);
  });
});

// ── pure: buildPhaseTransitionRecord ─────────────────────────────────────────

describe("buildPhaseTransitionRecord", () => {
  it("produces a record that passes validation", () => {
    const record = buildPhaseTransitionRecord({
      missionId: "m-1",
      fromPhase: "classified",
      toPhase: "executing",
      endpoint: { sessionId: "sess-1", generation: 0 },
      now: NOW,
    });
    const result = validateHandoffRecord(record);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.kind, "phase_transition");
    assert.equal(result.record.state, "prepared");
    assert.equal(result.record.missionId, "m-1");
    assert.deepEqual(result.record.predecessor, { sessionId: "sess-1", generation: 0 });
    assert.match(result.record.id, /^ho-m-1-classified-executing-gen0-/);
  });

  it("encodes mission start as fromPhase 'start'", () => {
    const record = buildPhaseTransitionRecord({
      missionId: "m-1",
      fromPhase: null,
      toPhase: "classified",
      endpoint: { sessionId: "sess-1", generation: 0 },
      now: NOW,
    });
    assert.match(String(record.id), /-start-/);
  });

  it("attaches the checkpoint sha only when provided", () => {
    const withSha = buildPhaseTransitionRecord({
      missionId: "m-1",
      fromPhase: "classified",
      toPhase: "executing",
      endpoint: { sessionId: "sess-1", generation: 0 },
      checkpointSha: "a".repeat(40),
      now: NOW,
    });
    const withoutSha = buildPhaseTransitionRecord({
      missionId: "m-1",
      fromPhase: "classified",
      toPhase: "executing",
      endpoint: { sessionId: "sess-1", generation: 0 },
      now: NOW,
    });
    assert.equal(withSha.checkpointSha, "a".repeat(40));
    assert.equal(withoutSha.checkpointSha, undefined);
    assert.ok(validateHandoffRecord(withSha).ok);
  });

  it("produces unique ids for distinct boundaries", () => {
    const base = {
      missionId: "m-1",
      endpoint: { sessionId: "sess-1", generation: 0 },
    } as const;
    const a = buildPhaseTransitionRecord({ ...base, fromPhase: null, toPhase: "classified", now: NOW });
    const b = buildPhaseTransitionRecord({ ...base, fromPhase: "classified", toPhase: "executing", now: NOW });
    assert.notEqual(a.id, b.id);
  });
});

// ── pure: phaseHandoffFallback ────────────────────────────────────────────────

describe("phaseHandoffFallback", () => {
  it("selects selective_compaction under context pressure", () => {
    const d = phaseHandoffFallback(["invalid handoff record: x"], 0.8);
    assert.equal(d.fallback, "selective_compaction");
    assert.match(d.reason, /context pressure/);
  });

  it("selects fresh_restart below the pressure threshold", () => {
    const d = phaseHandoffFallback(["invalid handoff record: x"], 0.5);
    assert.equal(d.fallback, "fresh_restart");
  });

  it("selects fresh_restart without utilization data", () => {
    const d = phaseHandoffFallback(["no session endpoint available"], null);
    assert.equal(d.fallback, "fresh_restart");
  });
});

// ── store: transitionHandoffRecord ────────────────────────────────────────────

describe("MissionStore.transitionHandoffRecord", () => {
  function makeStore(): MissionStore {
    return MissionStore.open(JsonlEventStore.inMemory());
  }

  function seed(store: MissionStore, id = "hf-b1"): HandoffRecord {
    return store.addHandoffRecord({
      id,
      kind: "phase_transition",
      state: "prepared",
      missionId: "m-1",
      predecessor: { sessionId: "sess-pre", generation: 0 },
      createdAt: NOW().toISOString(),
    });
  }

  it("walks prepared -> validated -> acknowledged (with successor + ackAt) -> committed", () => {
    const store = makeStore();
    seed(store);
    const validated = store.transitionHandoffRecord("hf-b1", "validated");
    assert.equal(validated.state, "validated");

    const acknowledged = store.transitionHandoffRecord("hf-b1", "acknowledged", {
      sessionId: "sess-fresh",
      generation: 1,
    });
    assert.equal(acknowledged.state, "acknowledged");
    assert.deepEqual(acknowledged.successor, { sessionId: "sess-fresh", generation: 1 });
    assert.ok(acknowledged.ackAt);

    const committed = store.transitionHandoffRecord("hf-b1", "committed");
    assert.equal(committed.state, "committed");
    assert.equal(store.getHandoffRecord("hf-b1")?.state, "committed");
  });

  it("rejects skipping a state", () => {
    const store = makeStore();
    seed(store);
    assert.throws(
      () => store.transitionHandoffRecord("hf-b1", "acknowledged", { sessionId: "s", generation: 1 }),
      /illegal handoff transition prepared -> acknowledged/,
    );
  });

  it("rejects an acknowledged transition without a successor", () => {
    const store = makeStore();
    seed(store);
    store.transitionHandoffRecord("hf-b1", "validated");
    assert.throws(() => store.transitionHandoffRecord("hf-b1", "acknowledged"), /successor is required/);
  });

  it("rejects leaving committed and an unknown id", () => {
    const store = makeStore();
    seed(store);
    store.transitionHandoffRecord("hf-b1", "validated");
    store.transitionHandoffRecord("hf-b1", "acknowledged", { sessionId: "s", generation: 1 });
    store.transitionHandoffRecord("hf-b1", "committed");
    assert.throws(() => store.transitionHandoffRecord("hf-b1", "aborted"), /illegal handoff transition committed/);
    assert.throws(() => store.transitionHandoffRecord("hf-nope", "validated"), /unknown handoff record/);
  });
});

// ── integration: orchestrator phase boundary (AC) ─────────────────────────────

interface Harness {
  store: MissionStore;
  orchestrator: Orchestrator;
  mission: Mission;
  lines: string[];
  setPhase: (phase: string) => void;
}

function makeHarness(opts: {
  usage?: Record<string, unknown>;
  checkpointSha?: string | null;
  parentSessionId?: string | null;
  endpoint?: ((mission: Mission) => { sessionId: string; generation: number } | null) | undefined;
}): Harness {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    title: "Boundary mission",
    goal: "Cross a phase boundary under context pressure",
    user_request: "Cross a phase boundary under context pressure",
    repository: "repo",
    base_ref: "main",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  const task = store.createTask({
    mission_id: mission.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "do the work",
  });
  const execution = store.createExecution({
    task_id: task.task_id,
    mission_id: mission.mission_id,
    backend: "agent",
    model: "gw/test",
  });
  if (opts.usage) {
    store.setExecutionStatus(execution.execution_id, "SUCCEEDED", {
      exit_status: "succeeded",
      usage: { ...opts.usage },
    });
  }
  if (opts.checkpointSha) {
    store.checkpointTask({
      checkpointId: "cp-b1",
      executionId: execution.execution_id,
      missionId: mission.mission_id,
      taskId: task.task_id,
      repoId: "repo",
      baseSha: "b".repeat(40),
      candidateSha: opts.checkpointSha,
      branch: null,
      worktree: null,
      committedChanges: [],
      preservedUncommittedChanges: [],
      completedDeliverables: [],
      remainingDeliverables: [],
      acceptanceIds: [],
      validationEvidenceRefs: [],
      artifactRefs: [],
      artifactHashes: [],
      workerId: null,
      sessionId: null,
      model: "gw/test",
      sequence: 1,
      missionGeneration: 0,
      candidateGeneration: 0,
      fencingToken: 0,
      createdAt: NOW().toISOString(),
    });
  }

  const lines: string[] = [];
  const orchestrator = new Orchestrator({
    store,
    backends: {},
    planner: async () => [],
    parentSessionId: opts.parentSessionId,
    phaseHandoff: {
      contextWindowForModel: (model) => (model === "gw/test" ? 128000 : null),
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    },
  });
  const progress = (orchestrator as unknown as { progress: Map<string, (line: string) => void> }).progress;
  progress.set(mission.mission_id, (line) => lines.push(line));
  const setPhase = (phase: string): void =>
    (orchestrator as unknown as { phase: (mission: Mission, phase: string) => void }).phase.call(
      orchestrator,
      mission,
      phase,
    );
  return { store, orchestrator, mission, lines, setPhase };
}

describe("orchestrator phase-boundary handoff", () => {
  it("emits exactly one phase_transition handoff at a boundary under pressure (AC)", () => {
    const { store, mission, lines, setPhase } = makeHarness({
      usage: { input: 80000, contextTokens: 96000 }, // 0.75 of 128k
      checkpointSha: "c".repeat(40),
      parentSessionId: "sess-pre",
    });

    setPhase("classified");
    setPhase("executing");

    const records = store.listHandoffRecords(mission.mission_id);
    assert.equal(records.length, 1, "one phase_transition handoff");
    assert.equal(records[0]!.kind, "phase_transition");
    assert.equal(records[0]!.state, "prepared");
    assert.equal(records[0]!.cause, "context_pressure");
    assert.equal(records[0]!.checkpointSha, "c".repeat(40));
    assert.deepEqual(records[0]!.predecessor, { sessionId: "sess-pre", generation: 0 });

    // Re-entering the same phase does not emit again.
    setPhase("executing");
    assert.equal(store.listHandoffRecords(mission.mission_id).length, 1);

    // Zero native-compaction entries: the success path reports the handoff and
    // never a fallback.
    assert.ok(
      lines.some((l) => l.includes("phase_transition handoff")),
      "handoff reported",
    );
    assert.ok(
      lines.every((l) => !l.includes("fallback")),
      "no compaction fallback on success",
    );
  });

  it("emits nothing below the threshold", () => {
    const { store, mission, lines, setPhase } = makeHarness({
      usage: { input: 10000, contextTokens: 16000 }, // 0.125
      parentSessionId: "sess-pre",
    });
    setPhase("classified");
    setPhase("executing");
    assert.equal(store.listHandoffRecords(mission.mission_id).length, 0);
    assert.ok(
      lines.every((l) => !l.includes("phase_transition")),
      "no handoff report",
    );
  });

  it("falls back to selective_compaction when no session endpoint exists", () => {
    const { store, mission, lines, setPhase } = makeHarness({
      usage: { input: 80000, contextTokens: 96000 }, // 0.75
      parentSessionId: null,
      endpoint: () => null,
    });
    setPhase("classified");
    setPhase("executing");
    assert.equal(store.listHandoffRecords(mission.mission_id).length, 0);
    assert.ok(
      lines.some((l) => l.includes("fallback selective_compaction")),
      "selective_compaction fallback reported",
    );
  });

  it("falls back (no crash) when the store rejects the record", () => {
    const harness = makeHarness({
      usage: { input: 80000, contextTokens: 96000 },
      parentSessionId: "sess-pre",
    });
    const { store, mission, lines, setPhase } = harness;
    // Sabotage: a record with an already-taken id is fine (Map overwrite), so
    // force a validation failure by making addHandoffRecord reject everything.
    const original = store.addHandoffRecord.bind(store);
    store.addHandoffRecord = () => {
      throw new Error("boom");
    };
    setPhase("classified");
    setPhase("executing");
    assert.equal(store.listHandoffRecords(mission.mission_id).length, 0);
    assert.ok(
      lines.some((l) => l.includes("handoff failed")),
      "failure reported",
    );
    assert.ok(
      lines.some((l) => l.includes("fallback selective_compaction")),
      "compaction fallback selected",
    );
    store.addHandoffRecord = original;
  });

  it("a fresh session resumes from the HandoffArtifact (AC)", async () => {
    const { store, mission, setPhase } = makeHarness({
      usage: { input: 80000, contextTokens: 96000 },
      checkpointSha: "d".repeat(40),
      parentSessionId: "sess-pre",
    });
    setPhase("classified");
    setPhase("executing");
    const record = store.listHandoffRecords(mission.mission_id)[0]!;

    // The predecessor validates; the fresh session (next generation)
    // acknowledges the handoff from the artifact.
    const checkpoint = {
      missionId: mission.mission_id,
      sessionId: "sess-pre",
      baseSha: "base",
      candidateSha: "d".repeat(40),
      worktree: null,
      artifactRefs: [],
      artifactHashes: [],
      handoff: { nextAction: null, decisions: [], unresolvedIssues: [], tests: [], memoryRefs: [], untracked: [] },
    } as unknown as TaskCheckpoint;
    // verify -> fence -> acknowledge: a record naming a checkpoint cannot skip the first two
    await store.verifyHandoff(record.id, checkpoint, {
      hashArtifact: async () => null,
      commitExists: async () => true,
      allowUnverifiable: true,
    });
    await store.fenceHandoffSource(record.id, async () => {});
    const acknowledged = store.acknowledgeHandoff(record.id, { sessionId: "sess-fresh", generation: 1 });

    // Resume decision for the fresh session at generation 1: the record is
    // acknowledged, the generation matches the lease, and the observed
    // checkpoint matches the artifact's checkpoint.
    const decision = decideHandoffResume({
      record: acknowledged,
      currentLease: { generation: 1 },
      observedCheckpointSha: "d".repeat(40),
      expectedSourceSha: null,
      observedSourceSha: null,
      sideEffects: [],
      nowMs: NOW().getTime() + 1000,
      maxAgeMs: 60_000,
    });
    assert.equal(decision.decision, "resume", `expected resume, got ${decision.reasons.join("; ")}`);

    // A later lease generation (a further rollover superseded this
    // successor) is refused as stale: the handoff's generation 1 is older
    // than the lease's generation 2.
    const stale = decideHandoffResume({
      record: acknowledged,
      currentLease: { generation: 2 },
      observedCheckpointSha: "d".repeat(40),
      expectedSourceSha: null,
      observedSourceSha: null,
      sideEffects: [],
      nowMs: NOW().getTime() + 1000,
      maxAgeMs: 60_000,
    });
    assert.equal(stale.decision, "refuse");
    assert.ok(stale.reasons.some((r) => r === "stale generation 1 < 2"));
  });
});
