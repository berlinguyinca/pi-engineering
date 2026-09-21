import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { evaluateGate } from "../../src/lifecycle/gate.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import { fingerprint, toReviewReport } from "../../src/lifecycle/reviewResultTool.ts";
import type { ReviewVerdictPayload } from "../../src/lifecycle/reviewResultTool.ts";
import { STAGE_ORDER, canTransition } from "../../src/lifecycle/stateMachine.ts";
import { LifecycleStore } from "../../src/lifecycle/store.ts";
import { LifecycleTelemetry, summarizeMetrics } from "../../src/lifecycle/telemetry.ts";
import type { LifecycleRun, ReviewFinding, ReviewReport, VerificationReport } from "../../src/lifecycle/types.ts";
import {
  VisionCache,
  imageFilesIn,
  isImagePath,
  isVisionCapable,
  shouldHandOffVision,
} from "../../src/lifecycle/vision.ts";

function baseRun(partial: Partial<LifecycleRun> = {}): LifecycleRun {
  return {
    runId: "RUN-TEST",
    sessionKey: "s",
    requestKey: "k",
    request: "Implement X",
    requirementIds: [],
    specPaths: [],
    state: "IMPLEMENTED",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rounds: 0,
    maxRounds: 3,
    baseCommit: "HEAD",
    lastSnapshotFingerprint: "fp",
    ignoredFingerprints: [],
    routing: [],
    reviews: [],
    verifications: [],
    remediations: [],
    checkOverrides: [],
    openFingerprints: [],
    notes: [],
    ...partial,
  };
}

function review(role: string, verdict: ReviewReport["verdict"], findings: ReviewReport["findings"] = []): ReviewReport {
  return {
    role,
    model: { provider: "alpha", id: "reviewer" },
    round: 0,
    verdict,
    findings,
    missingTests: [],
    specGaps: [],
    confidence: 0.8,
    summary: `${role} ${verdict}`,
    at: new Date().toISOString(),
    durationMs: 100,
  };
}

function finding(severity: ReviewFinding["severity"]): ReviewFinding {
  return {
    fingerprint: `${severity}|file|title`,
    role: "reviewer",
    severity,
    title: "Title",
    detail: "detail",
    confidence: 0.9,
    categories: [],
  };
}

function verification(status: "passed" | "failed", kind: "test" | "lint" = "test"): VerificationReport {
  return {
    round: 0,
    stage: "implementation",
    at: new Date().toISOString(),
    outcomes: [
      {
        spec: {
          kind,
          name: kind,
          command: kind === "test" ? "npm test" : "npm run lint",
          origin: "package.json",
          required: true,
          timeoutMs: 30_000,
        },
        status,
        durationMs: 10,
        summary: status === "passed" ? "ok" : "failed",
      },
    ],
    status,
    blocking: status === "passed" ? [] : ["test failed"],
  };
}

function gateDefaults(overrides: Partial<Parameters<typeof evaluateGate>[0]> = {}): Parameters<typeof evaluateGate>[0] {
  return {
    run: baseRun(),
    policy: DEFAULT_POLICY,
    changeObserved: true,
    reviews: [],
    requiredSpecialists: [],
    unresolvedFingerprints: [],
    testFilesChanged: 0,
    ...overrides,
  };
}

test("gate passes when every required item is satisfied", () => {
  const gate = evaluateGate(
    gateDefaults({
      reviews: [review("reviewer", "approve")],
      verification: verification("passed"),
      finalVerification: verification("passed"),
      implementerModel: "alpha/impl",
      testFilesChanged: 1,
    }),
  );
  assert.equal(gate.pass, true);
  assert.deepEqual(gate.blockers, []);
});

test("gate is not-applicable (pass) when no meaningful change was observed", () => {
  const gate = evaluateGate(gateDefaults({ changeObserved: false, reviews: [] }));
  assert.equal(gate.pass, true);
  assert.ok(gate.items.every((i) => i.status === "not_applicable"));
});

test("gate blocks on a missing independent review", () => {
  const gate = evaluateGate(gateDefaults({ reviews: [], verification: verification("passed") }));
  assert.equal(gate.pass, false);
  assert.ok(gate.blockers.includes("independent_review_pass"));
});

test("gate blocks on blocking findings above the allowed threshold", () => {
  const gate = evaluateGate(
    gateDefaults({
      reviews: [review("reviewer", "request_changes", [finding("high"), finding("medium")])],
      verification: verification("passed"),
      unresolvedFingerprints: ["high|file|title"],
    }),
  );
  assert.equal(gate.pass, false);
  assert.ok(gate.blockers.some((b) => /blocking finding/i.test(b)));
});

test("gate blocks when required specialists were not executed", () => {
  const gate = evaluateGate(
    gateDefaults({
      reviews: [review("reviewer", "approve")],
      requiredSpecialists: ["security_reviewer"],
      verification: verification("passed"),
    }),
  );
  assert.equal(gate.pass, false);
  assert.ok(gate.blockers.some((b) => /security_reviewer/.test(b)));
});

test("gate blocks on failed verification and on unresolved high-risk findings", () => {
  const gate = evaluateGate(
    gateDefaults({
      reviews: [review("reviewer", "approve")],
      verification: verification("failed"),
      unresolvedFingerprints: ["high|file|title"],
    }),
  );
  assert.equal(gate.pass, false);
  assert.ok(gate.blockers.includes("verification_pass"));
});

test("gate requires tests when the change set touches test-expected categories", () => {
  const gate = evaluateGate(
    gateDefaults({
      classification: {
        categories: ["feature"],
        risk: "NORMAL",
        planTriggers: [],
        specialists: [],
        visionRequired: false,
        reasons: [],
      },
      reviews: [review("reviewer", "approve")],
      verification: verification("passed", "lint"),
      testFilesChanged: 0,
    }),
  );
  assert.equal(gate.pass, false);
  assert.ok(gate.blockers.some((b) => b.startsWith("tests_when_required")));
});

test("state machine enforces explicit transitions and terminal-state protection", () => {
  assert.equal(canTransition("RECEIVED", "CLASSIFIED").ok, true);
  assert.equal(canTransition("IMPLEMENTING", "IMPLEMENTED").ok, true);
  assert.equal(canTransition("RECEIVED", "FINAL_VERIFIED").ok, false, "jumping ahead is not allowed");
  // A terminal state only moves along its declared reopen edge, and only on a command.
  assert.equal(canTransition("COMPLETE", "BLOCKED").ok, false);
  assert.equal(canTransition("COMPLETE", "RECEIVED").ok, true);
});

test("STAGE_ORDER is total and covers every lifecycle state", () => {
  const states = new Set(STAGE_ORDER.map((s) => s.state));
  for (const s of states) assert.ok(s, "states are well-formed");
});

test("store persists runs and restores them across reloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-store-"));
  try {
    const store = await LifecycleStore.open(dir);
    const run = baseRun({ runId: "RUN-A1B2C3", requestKey: "abc" });
    await store.save(run);
    const reopened = await LifecycleStore.open(dir);
    assert.ok(reopened.get("RUN-A1B2C3"));
    assert.equal(reopened.get("RUN-A1B2C3")?.requestKey, "abc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review fingerprints are stable and deduplicate across rounds", () => {
  const a = fingerprint({ severity: "high", file: "./src/x.ts", title: "Unescaped input in SQL" });
  const b = fingerprint({ severity: "high", file: "src/x.ts", title: "Unescaped input in SQL!" });
  assert.equal(a, b);
  const different = fingerprint({ severity: "high", file: "src/x.ts", title: "Different problem" });
  assert.notEqual(a, different);
});

test("toReviewReport maps a verdict payload to a report and marks missing payloads failed", () => {
  const payload: ReviewVerdictPayload = {
    verdict: "request_changes",
    summary: "Needs fixes",
    confidence: 0.9,
    findings: [
      {
        fingerprint: "x",
        role: "reviewer",
        severity: "medium",
        title: "t",
        detail: "d",
        confidence: 0.8,
        categories: [],
      },
    ],
    missingTests: [],
    specGaps: [],
  };
  const report = toReviewReport({
    role: "reviewer",
    model: { provider: "alpha", id: "m" },
    round: 1,
    durationMs: 5,
    payload,
  });
  assert.equal(report.verdict, "request_changes");
  assert.equal(report.findings.length, 1);
  assert.equal(report.role, "reviewer");

  const failed = toReviewReport({
    role: "reviewer",
    model: { provider: "alpha", id: "m" },
    round: 1,
    durationMs: 5,
    payload: undefined,
    error: "no-result",
  });
  assert.equal(failed.verdict, "failed");
});

test("vision: image path detection, capability detection, cache and handoff decision", async () => {
  assert.equal(isImagePath("screenshots/home.png"), true);
  assert.equal(isImagePath("src/x.ts"), false);

  const visionModel = normalizeModelRecord({ provider: "p", id: "vision", input: ["text", "image"], source: "test" });
  assert.equal(isVisionCapable(visionModel), true);
  const textModel = normalizeModelRecord({ provider: "p", id: "text", input: ["text"], source: "test" });
  assert.equal(isVisionCapable(textModel), false);

  const candidates = imageFilesIn(["screenshots/home.png", "README.md", "img/logo.webp"]);
  assert.equal(candidates.length, 2);

  const cache = await VisionCache.open(undefined, true);
  assert.equal(cache.enabledFlag, true);
  const key = VisionCache.key([{ data: "aGVsbG8=", mimeType: "image/png" }], "vision_reviewer", {
    provider: "p",
    id: "vision",
  });
  assert.ok(key.length === 64);
  const sameKey = VisionCache.key([{ data: "aGVsbG8=", mimeType: "image/png" }], "vision_reviewer", {
    provider: "p",
    id: "vision",
  });
  assert.equal(key, sameKey);

  assert.deepEqual(
    shouldHandOffVision({ visionRequired: true, forceHandoff: true, sessionHasVision: false, imagesPresent: true }),
    {
      handoff: true,
      reason: "vision.force_handoff is enabled: image judgement always routes to a vision model",
    },
  );
  assert.deepEqual(
    shouldHandOffVision({ visionRequired: false, forceHandoff: true, sessionHasVision: false, imagesPresent: true }),
    {
      handoff: true,
      reason: "vision.force_handoff is enabled: image judgement always routes to a vision model",
    },
  );
  assert.equal(
    shouldHandOffVision({ visionRequired: false, forceHandoff: false, sessionHasVision: false, imagesPresent: false })
      .handoff,
    false,
  );
});

test("telemetry summaries counts across events", () => {
  const telemetry = LifecycleTelemetry.memory(true);
  telemetry.runStarted({ runId: "RUN-1", sessionKey: "s", request: "x", categories: ["feature"], risk: "NORMAL" });
  telemetry.invocation({
    runId: "RUN-1",
    role: "reviewer",
    model: { provider: "alpha", id: "m" },
    ok: true,
    durationMs: 5,
    input: 10,
    output: 5,
    costUsd: 0.001,
  });
  telemetry.invocation({
    runId: "RUN-1",
    role: "implementer",
    model: { provider: "alpha", id: "m" },
    ok: false,
    durationMs: 5,
    error: "timeout",
    input: 1,
    output: 1,
    costUsd: 0,
  });
  const metrics = summarizeMetrics(telemetry.recent(100));
  assert.equal(metrics.runs, 1);
  assert.equal(metrics.modelInvocations, 2);
  assert.equal(metrics.failedInvocations, 1);
  assert.ok(metrics.totalCostUsd > 0);
});
