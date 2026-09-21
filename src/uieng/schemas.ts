/**
 * Shared versioned, validated schema contracts for autonomous UI engineering
 * (docs/specs/autonomous-ui-engineering/shared/01-contracts.md).
 *
 * Every record carries a `schema_version` so older persisted records can be
 * read and upgraded deterministically, and every score/decision must be
 * reproducible from the persisted evidence and provenance fields these
 * schemas enforce.
 *
 * Schemas use TypeBox (the `typebox` package already used elsewhere in this
 * repo, e.g. src/tools/coreTools.ts) and reuse src/core/ids.ts for id types.
 */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** Current schema version for all uieng records. Bump on breaking changes. */
export const SCHEMA_VERSION = 1;

/** The lowest schema version this module can read/upgrade. */
export const MIN_SCHEMA_VERSION = 1;

/** Union of every top-level record kind. */
export const RECORD_KINDS = [
  "task_request",
  "execution_provenance",
  "evidence_bundle",
  "finding",
  "evaluation_run",
  "design_artifact",
  "candidate",
  "acceptance_decision",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

const schemaVersion = Type.Integer({ minimum: MIN_SCHEMA_VERSION, maximum: SCHEMA_VERSION });
const idString = Type.String({ minLength: 3, maxLength: 200 });

/**
 * TaskRequest — the input contract for an autonomous UI engineering task.
 */
export const TaskRequestSchema = Type.Object({
  schema_version: schemaVersion,
  kind: Type.Literal("task_request"),
  /** id/type from src/core/ids.ts. */
  id: idString,
  type: Type.String({ maxLength: 100 }),
  /** Required capabilities the task needs. */
  required_capabilities: Type.Array(Type.String({ maxLength: 80 })),
  /** Optional capabilities that would improve the result. */
  optional_capabilities: Type.Array(Type.String({ maxLength: 80 })),
  /** Artifact references (artifact:// URIs) consumed by the task. */
  artifacts: Type.Array(Type.String({ maxLength: 1000 })),
  /** Free-form task context. */
  context: Type.String(),
  /** Structured-output schema, if any (JSON-schema-ish object). */
  structured_output_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  latency_class: Type.Union([Type.Literal("interactive"), Type.Literal("batch"), Type.Literal("background")]),
  quality_class: Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("critical"),
  ]),
  reasoning_class: Type.Union([Type.Literal("none"), Type.Literal("light"), Type.Literal("deep")]),
  vision: Type.Boolean(),
  image_generation: Type.Boolean(),
  independence_group: Type.Optional(Type.String({ maxLength: 100 })),
  diversity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  locality: Type.Optional(Type.String({ maxLength: 200 })),
  privacy: Type.Optional(Type.String({ maxLength: 200 })),
  deadline: Type.Optional(Type.String({ format: "date-time" })),
  cancel: Type.Optional(Type.Boolean()),
  trace_id: Type.Optional(Type.String({ maxLength: 200 })),
});
export type TaskRequest = Static<typeof TaskRequestSchema>;

/**
 * ExecutionProvenance — where and how an execution actually ran, so results
 * are reproducible.
 */
export const ExecutionProvenanceSchema = Type.Object({
  schema_version: schemaVersion,
  kind: Type.Literal("execution_provenance"),
  id: idString,
  gateway: Type.Optional(Type.String({ maxLength: 200 })),
  provider: Type.Optional(Type.String({ maxLength: 200 })),
  selected_model: Type.String({ maxLength: 200 }),
  runtime: Type.Optional(Type.String({ maxLength: 200 })),
  quantization: Type.Optional(Type.String({ maxLength: 50 })),
  site: Type.Optional(Type.String({ maxLength: 200 })),
  node: Type.Optional(Type.String({ maxLength: 200 })),
  selection_reason: Type.Optional(Type.String({ maxLength: 2000 })),
  timings_ms: Type.Optional(Type.Record(Type.String(), Type.Number())),
  token_counts: Type.Optional(
    Type.Object({
      input: Type.Optional(Type.Number()),
      output: Type.Optional(Type.Number()),
      total: Type.Optional(Type.Number()),
    }),
  ),
  image_counts: Type.Optional(Type.Record(Type.String(), Type.Number())),
  retries: Type.Optional(Type.Integer({ minimum: 0 })),
  failures: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ExecutionProvenance = Static<typeof ExecutionProvenanceSchema>;

/**
 * EvidenceBundle — the persisted, reproducible evidence a UI evaluation was
 * based on.
 */
export const EvidenceBundleSchema = Type.Object({
  schema_version: schemaVersion,
  kind: Type.Literal("evidence_bundle"),
  id: idString,
  state: Type.Optional(Type.String({ maxLength: 500 })),
  route: Type.Optional(Type.String({ maxLength: 1000 })),
  viewport: Type.Optional(
    Type.Object({
      width: Type.Optional(Type.Integer({ minimum: 0 })),
      height: Type.Optional(Type.Integer({ minimum: 0 })),
      device_scale_factor: Type.Optional(Type.Number({ minimum: 0 })),
    }),
  ),
  screenshots: Type.Array(Type.String({ maxLength: 1000 })),
  video: Type.Optional(Type.String({ maxLength: 1000 })),
  dom: Type.Optional(Type.String()),
  accessibility_tree: Type.Optional(Type.String()),
  bounds: Type.Optional(
    Type.Object({
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      width: Type.Optional(Type.Number()),
      height: Type.Optional(Type.Number()),
    }),
  ),
  computed_styles: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  network: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  console: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  performance: Type.Optional(Type.Record(Type.String(), Type.Number())),
  interaction_traces: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  source_mapping: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  commit: Type.Optional(Type.String({ maxLength: 200 })),
  worktree: Type.Optional(Type.String({ maxLength: 1000 })),
});
export type EvidenceBundle = Static<typeof EvidenceBundleSchema>;

/**
 * Finding — a scored, evidence-backed defect or observation.
 */
export const FindingSchema = Type.Object({
  schema_version: schemaVersion,
  kind: Type.Literal("finding"),
  id: idString,
  rubric: Type.Optional(Type.String({ maxLength: 200 })),
  score: Type.Number({ minimum: 0, maximum: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  severity: Type.Union([
    Type.Literal("info"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("critical"),
  ]),
  evidence: Type.Array(Type.String({ maxLength: 1000 })),
  affected_states: Type.Optional(Type.Array(Type.String({ maxLength: 500 }))),
  affected_code: Type.Optional(Type.Array(Type.String({ maxLength: 500 }))),
  impact: Type.Optional(Type.String({ maxLength: 2000 })),
  root_cause: Type.Optional(Type.String({ maxLength: 2000 })),
  remediation: Type.Optional(Type.String({ maxLength: 2000 })),
  effort: Type.Optional(Type.String({ maxLength: 200 })),
  risk: Type.Optional(Type.String({ maxLength: 200 })),
  verification: Type.Optional(Type.String({ maxLength: 2000 })),
  evaluator_provenance: Type.Optional(ExecutionProvenanceSchema),
});
export type Finding = Static<typeof FindingSchema>;

/**
 * EvaluationRun — a full evaluation pass over candidates with findings.
 */
export const EvaluationRunSchema = Type.Object({
  schema_version: schemaVersion,
  kind: Type.Literal("evaluation_run"),
  id: idString,
  task_request: TaskRequestSchema,
  provenance: ExecutionProvenanceSchema,
  findings: Type.Array(FindingSchema),
  started_at: Type.String({ format: "date-time" }),
  finished_at: Type.Optional(Type.String({ format: "date-time" })),
  verdict: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked")])),
});
export type EvaluationRun = Static<typeof EvaluationRunSchema>;

/**
 * DesignArtifact — a design produced by a candidate (e.g. spec, prototype,
 * implementation plan).
 */
export const DesignArtifactSchema = Type.Object({
  schema_version: schemaVersion,
  kind: Type.Literal("design_artifact"),
  id: idString,
  type: Type.String({ maxLength: 100 }),
  title: Type.String({ maxLength: 300 }),
  description: Type.Optional(Type.String({ maxLength: 3000 })),
  content_ref: Type.Optional(Type.String({ maxLength: 1000 })),
  created_at: Type.String({ format: "date-time" }),
  provenance: Type.Optional(ExecutionProvenanceSchema),
});
export type DesignArtifact = Static<typeof DesignArtifactSchema>;

/**
 * Candidate — one competing solution in an evaluation.
 */
export const CandidateSchema = Type.Object({
  schema_version: schemaVersion,
  kind: Type.Literal("candidate"),
  id: idString,
  task_request: TaskRequestSchema,
  artifacts: Type.Array(DesignArtifactSchema),
  provenance: ExecutionProvenanceSchema,
  diversity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("complete"),
    Type.Literal("failed"),
  ]),
  submitted_at: Type.Optional(Type.String({ format: "date-time" })),
});
export type Candidate = Static<typeof CandidateSchema>;

/**
 * AcceptanceDecision — the final, reproducible accept/reject decision.
 */
export const AcceptanceDecisionSchema = Type.Object({
  schema_version: schemaVersion,
  kind: Type.Literal("acceptance_decision"),
  id: idString,
  candidate: CandidateSchema,
  accepted: Type.Boolean(),
  rationale: Type.String({ maxLength: 4000 }),
  findings: Type.Array(FindingSchema),
  evaluation: EvaluationRunSchema,
  provenance: ExecutionProvenanceSchema,
  decided_at: Type.String({ format: "date-time" }),
});
export type AcceptanceDecision = Static<typeof AcceptanceDecisionSchema>;

/** Registry of all top-level record schemas keyed by kind. */
export const SCHEMAS = {
  task_request: TaskRequestSchema,
  execution_provenance: ExecutionProvenanceSchema,
  evidence_bundle: EvidenceBundleSchema,
  finding: FindingSchema,
  evaluation_run: EvaluationRunSchema,
  design_artifact: DesignArtifactSchema,
  candidate: CandidateSchema,
  acceptance_decision: AcceptanceDecisionSchema,
} as const satisfies Record<RecordKind, ReturnType<typeof Type.Object>>;

export type UiengRecord =
  | TaskRequest
  | ExecutionProvenance
  | EvidenceBundle
  | Finding
  | EvaluationRun
  | DesignArtifact
  | Candidate
  | AcceptanceDecision;

/** Validate an unknown value against the schema for the given record kind. */
export function validateRecord<K extends RecordKind>(kind: K, value: unknown): value is Static<(typeof SCHEMAS)[K]> {
  return Value.Check(SCHEMAS[kind], value);
}

/**
 * Deterministic migration/upgrade: read any record at or above MIN_SCHEMA_VERSION
 * and return its current-version form. v1 is the current version, so this is an
 * identity passthrough today; it is the seam where older versions get upgraded
 * when the schema evolves.
 */
export function migrateRecord<T extends UiengRecord>(record: T): UiengRecord {
  const version = (record as { schema_version?: unknown }).schema_version;
  if (typeof version !== "number" || version < MIN_SCHEMA_VERSION || version > SCHEMA_VERSION) {
    throw new Error(`Unsupported schema_version ${String(version)}; expected ${MIN_SCHEMA_VERSION}..${SCHEMA_VERSION}`);
  }
  if (version === SCHEMA_VERSION) return record;
  // Future versions: apply per-version upgrade steps here.
  return record;
}
