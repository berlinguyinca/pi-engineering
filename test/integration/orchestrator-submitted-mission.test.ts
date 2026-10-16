import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends } from "../../src/orchestration/broker.ts";
import { externalMissionId, SUBMISSION_RECEIPT_LEASE_MS } from "../../src/orchestration/externalEntry.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { DEFAULT_GATEWAY_RESILIENCE } from "../../src/resilience/config.ts";

/**
 * Harness: a fully-healthy orchestrator with a runtime controller owner. The
 * planner records every constraints array it receives so tests can assert the
 * idempotency sentinel is stripped before the pipeline runs.
 */
function harness() {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  let agentCalls = 0;
  const plannerConstraints: string[][] = [];
  const ok = { executionId: "e", exitStatus: "succeeded" as const, summary: "ok", artifactRefs: [], usage: {} };
  const backends: BrokerBackends = {
    agent: {
      runAgent: async () => {
        agentCalls++;
        return ok;
      },
    },
    validation: {
      runValidation: async () => ({
        ...ok,
        validationEvidence: {
          command: "npm test",
          profile: "test",
          exitCode: 0,
          testSummary: { passed: 1 },
          noTargets: false,
          accessible: true,
          acceptanceResults: [],
        },
      }),
    },
    review: {
      runReview: async ({ acceptanceCriteria }) => ({
        ...ok,
        findings: [],
        reviewEvidence: {
          reviewerSessionId: "review-no-deadline",
          model: "test",
          provider: "test",
          verdict: "approve",
          independenceMode: "independent",
          findings: [],
          outputValid: true,
          accessible: true,
          acceptanceResults: (acceptanceCriteria ?? []).map((criterion) => ({
            acceptanceId: criterion.acceptanceId,
            status: "passed" as const,
            detail: "checked",
          })),
        },
      }),
    },
  };
  const orchestrator = new Orchestrator({
    store,
    backends,
    ownership: new MissionOwnership(store, { ownerId: "runtime-owner", leaseMs: 60_000 }),
    git: {
      root: process.cwd(),
      headCommit: async () => "candidate-test-sha",
      captureDiff: async () => "diff --git a/src/health.ts b/src/health.ts",
      changedFiles: async () => ["src/health.ts"],
      loadCandidateLifecycleInventory: async () => ({ records: [], diagnostics: [] }),
      loadIntegrationRunInventory: async () => ({ records: [], diagnostics: [] }),
      loadPromotionLifecycleInventory: async () => ({ records: [], diagnostics: [] }),
      loadPendingBranchCleanupInventory: async () => ({ records: [], diagnostics: [] }),
    } as unknown as GitRepo,
    planner: async (mission) => {
      plannerConstraints.push(mission.constraints);
      return [
        {
          kind: "agent" as const,
          role: "implementer",
          objective: "implement",
          mutates_repo: true,
          write_domains: ["src/**"],
          isolation: "none" as const,
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
            criterion.acceptance_id ? [criterion.acceptance_id] : [],
          ),
          max_attempts: 3,
          failure_policy: "retry" as const,
        },
      ];
    },
    resilience: { ...DEFAULT_GATEWAY_RESILIENCE, probe_interval_ms: 100, max_backoff_ms: 100, jitter_ms: 0 },
    probe: { probe: async () => ({ healthy: true, authoritative: true }) },
  });
  return { orchestrator, store, agentCalls: () => agentCalls, plannerConstraints };
}

/** Seed an external mission exactly as externalEntry does. */
function seedExternalMission(
  store: MissionStore,
  key: string,
  constraints: string[] = [],
): string {
  const id = externalMissionId(key);
  store.createMission({
    mission_id: id,
    title: "ext",
    goal: "Add a health endpoint",
    user_request: "Add a health endpoint",
    repository: ".",
    base_ref: "abc",
    constraints,
    risk_profile: "medium",
    workflow_class: "engineering",
  });
  return id;
}

/** Acquire the submission receipt lease for an externally-submitted mission. */
async function acquireReceipt(store: MissionStore, id: string, now: () => number): Promise<void> {
  await new MissionOwnership(store, { ownerId: "autospec-1", leaseMs: SUBMISSION_RECEIPT_LEASE_MS, now }).acquire(id);
}

test("runSubmittedMission starts an external mission whose receipt lease expired", async () => {
  const { orchestrator, store } = harness();
  const id = seedExternalMission(store, "k1");
  await acquireReceipt(store, id, () => Date.now() - 6 * 60_000);

  const result = await orchestrator.runSubmittedMission(id);
  assert.equal(result.started, true);
  if (!result.started) return;
  assert.equal(result.result.completed, true);
  assert.equal(store.getMission(id)!.status, "COMPLETE");
  assert.equal(store.getLatestMissionLease(id)!.ownerId, "runtime-owner");
});

test("runSubmittedMission refuses while the receipt lease is live", async () => {
  const { orchestrator, store } = harness();
  const id = seedExternalMission(store, "k2");
  await acquireReceipt(store, id, () => Date.now());

  const result = await orchestrator.runSubmittedMission(id);
  assert.deepEqual(result, { started: false, reason: `leased_until ${store.getMissionLease(id)!.renewBy}` });
  assert.equal(store.getMission(id)!.status, "NEW");
  assert.equal(store.listTasks(id).length, 0);
});

test("runSubmittedMission refuses a non-external mission", async () => {
  const { orchestrator, store } = harness();
  store.createMission({
    mission_id: "MSN-plain1",
    title: "plain",
    goal: "Add a health endpoint",
    user_request: "Add a health endpoint",
    repository: ".",
    base_ref: "abc",
    constraints: [],
    risk_profile: "medium",
    workflow_class: "engineering",
  });

  const result = await orchestrator.runSubmittedMission("MSN-plain1");
  assert.deepEqual(result, { started: false, reason: "not_external" });
});

test("runSubmittedMission reports not_found", async () => {
  const { orchestrator } = harness();
  const result = await orchestrator.runSubmittedMission("MSN-nope");
  assert.deepEqual(result, { started: false, reason: "not_found" });
});

test("runSubmittedMission strips the idempotency sentinel from the pipeline copy", async () => {
  const { orchestrator, store, plannerConstraints } = harness();
  const id = "MSN-proto1";
  store.createMission({
    mission_id: id,
    title: "proto",
    goal: "Add a health endpoint",
    user_request: "Add a health endpoint",
    repository: ".",
    base_ref: "abc",
    constraints: ["__pi_idempotency_key:abc"],
    risk_profile: "medium",
    workflow_class: "engineering",
  });
  await acquireReceipt(store, id, () => Date.now() - 6 * 60_000);

  const result = await orchestrator.runSubmittedMission(id);
  assert.equal(result.started, true);
  if (!result.started) return;
  assert.equal(store.getMission(id)!.status, "COMPLETE");
  assert.ok(store.getMission(id)!.constraints.includes("__pi_idempotency_key:abc"));
  assert.ok(
    plannerConstraints.every(
      (constraints) => !constraints.some((criterion) => criterion.startsWith("__pi_idempotency_key:")),
    ),
  );
});

test("runSubmittedMission refuses a mission that is not NEW", async () => {
  const { orchestrator, store } = harness();
  const id = seedExternalMission(store, "k6");
  await acquireReceipt(store, id, () => Date.now() - 6 * 60_000);

  const first = await orchestrator.runSubmittedMission(id);
  assert.equal(first.started, true);
  assert.equal(store.getMission(id)!.status, "COMPLETE");

  const second = await orchestrator.runSubmittedMission(id);
  assert.deepEqual(second, { started: false, reason: "status_COMPLETE" });
});
