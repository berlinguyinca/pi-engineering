/**
 * Golden fixture for the mission-snapshot contract, version 3 (autospec R-PROTO-0).
 *
 * `test/fixtures/mission-snapshot-v3.golden.json` is rebuilt here from the real
 * `buildMissionSnapshotFile` over fixed input and compared byte for byte. The
 * same file is meant to be asserted by berlinguyinca/pi-engineering-web (its
 * issue #2, not started when this landed), so a drift on either side fails a
 * test. `UPDATE_GOLDEN=1` rewrites the fixture; commit the diff on purpose.
 *
 * Nullable fields: the first mission leaves every nullable field null, the
 * second fills them, so both forms of the contract are pinned. Note for
 * consumers: `currentActivity` is null here because the builder passes the
 * projection's value through; the live projection omits the key when there is
 * no current activity, so a reader must accept null, absent, or an object.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MISSION_SNAPSHOT_CONTRACT_VERSION,
  type MissionSnapshotFile,
  buildMissionSnapshotFile,
} from "../../src/orchestration/missionSnapshot.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { MissionProjection } from "../../src/orchestration/observability/types.ts";
import type { MissionStop } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mission-snapshot-v3.golden.json");
const CLOCK = "2026-10-14T12:00:00.000Z";

function projection(over: {
  missionId: string;
  title: string;
  finding: { id: string; severity: "blocking" | "minor" };
  lastMeaningfulProgressAt: string | null;
  currentActivity: { type: string; summary: string; workerId?: string } | null;
  nextActionAt: string | null;
  owner: string | null;
  repository: string | null;
  task: string | null;
}): MissionProjection {
  return {
    summary: {
      missionId: over.missionId,
      title: over.title,
      state: "EXECUTING",
      phase: "executing",
      progress: { approximatePercent: 40, verifiedComplete: false, basis: "weighted_dag" },
      acceptanceCoverage: { completed: 1, total: 2, approximatePercent: 50 },
      workflowProgress: { completed: 1, total: 3, approximatePercent: 33, basis: "weighted_dag" },
      health: "active",
      workers: { active: 1, waiting: 0, failed: 0 },
      workersDetail: [],
      lastMeaningfulProgressAt: over.lastMeaningfulProgressAt,
      // The live projection types this as optional; the contract allows null.
      currentActivity: over.currentActivity as MissionProjection["summary"]["currentActivity"],
      completionStatus: "validating",
      action: "run_task",
      reason: "task ready",
      recovery: { attempt: 0, maxAttempts: 3 },
      nextAction: "verify",
      nextActionAt: over.nextActionAt,
      owner: over.owner,
      repository: over.repository,
      task: over.task,
      preservedWork: [],
    },
    tasks: [],
    workers: [],
    activity: [],
    progressHistory: [{ at: CLOCK, approximatePercent: 40, label: "executing", meaningfulProgress: true }],
    tests: {
      running: false,
      completed: 10,
      total: 10,
      passed: 9,
      failed: 1,
      skipped: 0,
      failures: ["suite > case"],
      retries: 0,
    },
    review: {
      started: true,
      completed: false,
      status: "running",
      findings: [
        {
          findingId: over.finding.id,
          severity: over.finding.severity,
          summary: over.finding.severity === "blocking" ? "crashes on empty body" : "mission-level note without a task",
          file: over.finding.severity === "blocking" ? "src/handler.ts" : null,
          status: "open",
          repaired: false,
        },
      ],
      blockingOpen: over.finding.severity === "blocking" ? 1 : 0,
      reReviewPending: false,
    },
    changes: { changedFiles: ["src/handler.ts"], commits: [], integrationState: "pending" },
    errors: [],
    recovery: [],
    artifacts: [],
  };
}

/** Fixed missions, tasks, findings and clock; nothing here reads the real time or randomness. */
function goldenInput(): Parameters<typeof buildMissionSnapshotFile>[0] {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const base = {
    user_request: "golden",
    base_ref: "main",
    risk_profile: "medium" as const,
    workflow_class: "engineering_review" as const,
  };
  const nulls = store.createMission({
    ...base,
    mission_id: "MSN-golden-nulls",
    title: "Nullable fields are null",
    goal: "Pin the null form of every nullable field",
    repository: "repo-nulls",
  });
  store.createTask({
    task_id: "TSK-golden-nulls",
    mission_id: nulls.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "Add /health",
    mutates_repo: true,
    isolation: "worktree",
    write_domains: ["src/**"],
  });
  const orphan = store.addFinding({
    mission_id: nulls.mission_id,
    task_id: null,
    severity: "minor",
    category: "style",
    file: null,
    line: null,
    summary: "mission-level note without a task",
    evidence: "review-0",
    recommended_action: "none",
  });
  const full = store.createMission({
    ...base,
    mission_id: "MSN-golden-full",
    title: "Nullable fields are filled",
    goal: "Pin the populated form of every nullable field",
    repository: "repo-full",
  });
  const task = store.createTask({
    task_id: "TSK-golden-full",
    mission_id: full.mission_id,
    kind: "agent",
    role: "reviewer",
    objective: "Review /health",
    depends_on: ["TSK-golden-nulls"],
    repo_id: "repo-full",
    acceptance_ids: ["AC-1"],
  });
  const finding = store.addFinding({
    mission_id: full.mission_id,
    task_id: task.task_id,
    severity: "blocking",
    category: "correctness",
    file: "src/handler.ts",
    line: 3,
    summary: "crashes on empty body",
    evidence: "review-1",
    recommended_action: "guard body",
  });
  const stop: MissionStop = {
    missionId: full.mission_id,
    reason: "waiting for approval",
    preservedWork: ["branch feat/health"],
    attemptedRecoveries: [],
    resumeCondition: "approval granted",
    stoppedAt: CLOCK,
    generation: 1,
    resumptionGeneration: 0,
    blockedEpisodeId: null,
    recoveryDeadline: null,
  };
  const spec = (filled: boolean) => ({
    phase: filled ? "approved" : "drafting",
    revisionNumber: filled ? 2 : 1,
    semanticSpecHash: filled ? "sha256:spec" : null,
    planHash: filled ? "sha256:plan" : null,
    semanticRoundsUsed: filled ? 2 : 0,
    semanticRoundsLimit: 5,
    activeStage: filled ? "approval" : null,
    activeStageDeadlineAt: filled ? "2026-10-14T13:00:00.000Z" : null,
    overallDeadlineAt: filled ? "2026-10-15T12:00:00.000Z" : null,
    approvalId: filled ? "APR-golden-1" : null,
    invalidatedApprovalId: filled ? "APR-golden-0" : null,
    warning: filled ? "approval is close to its deadline" : null,
    stopReason: filled ? "needs_operator" : null,
    resumeCondition: filled ? "approval granted" : null,
  });
  return [
    {
      mission: store.getMission(nulls.mission_id) ?? nulls,
      tasks: store.listTasks(nulls.mission_id),
      findings: [{ ...orphan, finding_id: "F-golden-0" }],
      observability: projection({
        missionId: nulls.mission_id,
        title: nulls.title,
        finding: { id: "F-golden-0", severity: "minor" },
        lastMeaningfulProgressAt: null,
        currentActivity: null,
        nextActionAt: null,
        owner: null,
        repository: null,
        task: null,
      }),
      spec: spec(false),
    },
    {
      mission: store.getMission(full.mission_id) ?? full,
      tasks: store.listTasks(full.mission_id),
      findings: [{ ...finding, finding_id: "F-golden-1" }],
      stop,
      observability: projection({
        missionId: full.mission_id,
        title: full.title,
        finding: { id: "F-golden-1", severity: "blocking" },
        lastMeaningfulProgressAt: "2026-10-14T11:59:00.000Z",
        currentActivity: { type: "running_test", summary: "running the suite", workerId: "W-golden" },
        nextActionAt: "2026-10-14T12:05:00.000Z",
        owner: "host-a:1234",
        repository: "repo-full",
        task: "TSK-golden-full",
      }),
      spec: spec(true),
      executions: [],
      classifications: [],
      verifierStages: [{ name: "typecheck", durationMs: 1200, reused: false }],
    },
  ];
}

function rebuild(): string {
  mock.timers.enable({ apis: ["Date"], now: Date.parse(CLOCK) });
  try {
    const file = buildMissionSnapshotFile(goldenInput());
    return `${JSON.stringify(file, null, 2)}\n`;
  } finally {
    mock.timers.reset();
  }
}

/** Every nullable key of the v3 contract, by owner object path. */
const NULLABLE: Array<{ path: string[]; keys: string[] }> = [
  {
    path: ["observability"],
    keys: ["lastMeaningfulProgressAt", "currentActivity", "nextActionAt", "owner", "repository", "task"],
  },
  {
    path: ["specApproval"],
    keys: [
      "semanticSpecHash",
      "planHash",
      "activeStage",
      "activeStageDeadlineAt",
      "overallDeadlineAt",
      "approvalId",
      "invalidatedApprovalId",
      "warning",
      "stopReason",
      "resumeCondition",
    ],
  },
];

describe("mission snapshot v3 golden fixture", () => {
  if (process.env.UPDATE_GOLDEN === "1") {
    it("rewrites the golden fixture (UPDATE_GOLDEN=1)", () => {
      writeFileSync(FIXTURE, rebuild());
    });
  }

  it("the rebuilt snapshot equals the fixture byte for byte", () => {
    assert.equal(rebuild(), readFileSync(FIXTURE, "utf8"));
  });

  it("is contract version 3", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as MissionSnapshotFile;
    assert.equal(MISSION_SNAPSHOT_CONTRACT_VERSION, 3);
    assert.equal(fixture.contractVersion, MISSION_SNAPSHOT_CONTRACT_VERSION);
    assert.equal(fixture.generatedAt, CLOCK);
  });

  it("serializes every listed nullable field as an explicit null at least once", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { missions: Array<Record<string, unknown>> };
    for (const { path, keys } of NULLABLE) {
      for (const key of keys) {
        const holders = fixture.missions.map((m) =>
          path.reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], m),
        );
        const hasNull = holders.some(
          (h) => h !== undefined && key in (h as object) && (h as Record<string, unknown>)[key] === null,
        );
        assert.ok(hasNull, `${path.join(".")}.${key} must appear with value null`);
      }
    }
    const findingTaskIds = fixture.missions.flatMap((m) =>
      (m.findings as Array<{ taskId: unknown }>).map((f) => f.taskId),
    );
    assert.ok(findingTaskIds.includes(null), "findings[].taskId must appear with value null");
  });

  it("also pins the populated form of the same fields", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { missions: Array<Record<string, unknown>> };
    for (const { path, keys } of NULLABLE) {
      for (const key of keys) {
        const filled = fixture.missions.some((m) => {
          const holder = path.reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], m) as Record<
            string,
            unknown
          >;
          return holder?.[key] !== null && holder?.[key] !== undefined;
        });
        assert.ok(filled, `${path.join(".")}.${key} must appear populated in the other mission`);
      }
    }
  });

  it("fails when one byte of the fixture changes", () => {
    const text = readFileSync(FIXTURE, "utf8");
    const edited = text.replace("MSN-golden-nulls", "MSN-golden-nullz");
    assert.notEqual(edited, text);
    assert.notEqual(rebuild(), edited);
  });
});
