import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AcceptanceDecision,
  type Candidate,
  type DesignArtifact,
  type EvaluationRun,
  type EvidenceBundle,
  type ExecutionProvenance,
  type Finding,
  SCHEMAS,
  SCHEMA_VERSION,
  type TaskRequest,
  type UiengRecord,
  migrateRecord,
  validateRecord,
} from "../../src/uieng/schemas.ts";

function taskRequest(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    schema_version: 1,
    kind: "task_request",
    id: "WI-ABC123",
    type: "ui",
    required_capabilities: ["vision"],
    optional_capabilities: [],
    artifacts: [],
    context: "build a settings form",
    latency_class: "interactive",
    quality_class: "high",
    reasoning_class: "deep",
    vision: true,
    image_generation: false,
    ...overrides,
  };
}

function provenance(overrides: Partial<ExecutionProvenance> = {}): ExecutionProvenance {
  return {
    schema_version: 1,
    kind: "execution_provenance",
    id: "RUN-1",
    selected_model: "deepseek-v4-flash",
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    schema_version: 1,
    kind: "finding",
    id: "FIND-1",
    score: 0.6,
    confidence: 0.9,
    severity: "high",
    evidence: ["artifact://shots/main.png"],
    ...overrides,
  };
}

function designArtifact(overrides: Partial<DesignArtifact> = {}): DesignArtifact {
  return {
    schema_version: 1,
    kind: "design_artifact",
    id: "ART-1",
    type: "prototype",
    title: "settings form prototype",
    created_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

function evidenceBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    schema_version: 1,
    kind: "evidence_bundle",
    id: "EVID-1",
    screenshots: ["artifact://shots/main.png"],
    ...overrides,
  };
}

describe("uieng shared schema contracts", () => {
  it("exports a current SCHEMA_VERSION and every record kind schema", () => {
    assert.equal(SCHEMA_VERSION, 1);
    assert.deepEqual(Object.keys(SCHEMAS).sort(), [
      "acceptance_decision",
      "candidate",
      "design_artifact",
      "evaluation_run",
      "evidence_bundle",
      "execution_provenance",
      "finding",
      "task_request",
      "ui_profile",
    ]);
  });

  it("validates a well-formed TaskRequest and rejects an invalid one", () => {
    const good = taskRequest();
    assert.equal(validateRecord("task_request", good), true);

    const bad = { ...good, latency_class: "never" };
    assert.equal(validateRecord("task_request", bad), false);
  });

  it("validates every top-level record kind end-to-end", () => {
    const taskReq = taskRequest();
    const prov = provenance();
    const find = finding();
    const art = designArtifact();
    const eb = evidenceBundle();
    const run: EvaluationRun = {
      schema_version: 1,
      kind: "evaluation_run",
      id: "EVAL-1",
      task_request: taskReq,
      provenance: prov,
      findings: [find],
      started_at: "2026-09-20T00:00:00.000Z",
      verdict: "pass",
    };
    const candidate: Candidate = {
      schema_version: 1,
      kind: "candidate",
      id: "CAND-1",
      task_request: taskReq,
      artifacts: [art],
      provenance: prov,
      diversity: 0.5,
      status: "complete",
    };
    const decision: AcceptanceDecision = {
      schema_version: 1,
      kind: "acceptance_decision",
      id: "DEC-1",
      candidate,
      accepted: true,
      rationale: "meets rubric",
      findings: [find],
      evaluation: run,
      provenance: prov,
      decided_at: "2026-09-20T00:01:00.000Z",
    };

    assert.equal(validateRecord("task_request", taskReq), true);
    assert.equal(validateRecord("execution_provenance", prov), true);
    assert.equal(validateRecord("evidence_bundle", eb), true);
    assert.equal(validateRecord("finding", find), true);
    assert.equal(validateRecord("evaluation_run", run), true);
    assert.equal(validateRecord("design_artifact", art), true);
    assert.equal(validateRecord("candidate", candidate), true);
    assert.equal(validateRecord("acceptance_decision", decision), true);
  });

  it("rejects a nested invalid candidate inside an acceptance decision", () => {
    const taskReq = taskRequest();
    const prov = provenance();
    const find = finding();
    const art = designArtifact();
    const run: EvaluationRun = {
      schema_version: 1,
      kind: "evaluation_run",
      id: "EVAL-1",
      task_request: taskReq,
      provenance: prov,
      findings: [find],
      started_at: "2026-09-20T00:00:00.000Z",
    };
    const badCandidate = {
      schema_version: 1,
      kind: "candidate",
      id: "CAND-2",
      task_request: taskReq,
      artifacts: [art],
      provenance: prov,
      status: "warp",
    } as unknown as Candidate;
    const decision: AcceptanceDecision = {
      schema_version: 1,
      kind: "acceptance_decision",
      id: "DEC-2",
      candidate: badCandidate,
      accepted: true,
      rationale: "x",
      findings: [find],
      evaluation: run,
      provenance: prov,
      decided_at: "2026-09-20T00:01:00.000Z",
    };
    assert.equal(validateRecord("acceptance_decision", decision), false);
  });

  it("migrateRecord passes through current-version records and rejects unsupported versions", () => {
    const rec: UiengRecord = taskRequest();
    assert.deepEqual(migrateRecord(rec), rec);

    assert.throws(() => migrateRecord({ ...rec, schema_version: 0 } as UiengRecord), /Unsupported schema_version/);
    assert.throws(() => migrateRecord({ ...rec, schema_version: 999 } as UiengRecord), /Unsupported schema_version/);
  });

  it("every record kind carries a schema_version field", () => {
    assert.equal(SCHEMAS.task_request.properties.schema_version?.type, "integer");
    assert.equal(SCHEMAS.acceptance_decision.properties.schema_version?.type, "integer");
  });
});
