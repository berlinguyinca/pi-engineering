import { createHash } from "node:crypto";
import type { AcceptanceEvidenceResult, CandidateEvidenceIdentity, OrchestrationTask, ReviewFinding } from "./types.ts";

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`candidate evidence identity requires ${field}`);
  return normalized;
}

function canonicalSet(values: string[], field: string): string[] {
  const normalized = values.map((value) => required(value, field));
  return [...new Set(normalized)].sort();
}

export class EvidenceUnavailableError extends Error {
  readonly category = "EVIDENCE_UNAVAILABLE" as const;

  constructor(message: string) {
    super(`EVIDENCE_UNAVAILABLE: ${message}`);
    this.name = "EvidenceUnavailableError";
  }
}

/** Build the only accepted, deterministic representation of candidate evidence identity. */
export function buildCandidateEvidenceIdentity(input: CandidateEvidenceIdentity): CandidateEvidenceIdentity {
  if (!Number.isSafeInteger(input.missionGeneration) || input.missionGeneration < 0) {
    throw new Error("candidate evidence identity requires a non-negative missionGeneration");
  }
  return {
    workspaceManifestHash: required(input.workspaceManifestHash, "workspaceManifestHash"),
    missionGeneration: input.missionGeneration,
    repoId: required(input.repoId, "repoId"),
    baseSha: required(input.baseSha, "baseSha"),
    candidateSha: required(input.candidateSha, "candidateSha"),
    diffHash: required(input.diffHash, "diffHash"),
    acceptanceIds: canonicalSet(input.acceptanceIds, "acceptanceIds"),
    artifactHashes: canonicalSet(input.artifactHashes, "artifactHashes"),
  };
}

export function canonicalCandidateEvidenceJson(input: CandidateEvidenceIdentity): string {
  const identity = buildCandidateEvidenceIdentity(input);
  return JSON.stringify({
    acceptanceIds: identity.acceptanceIds,
    artifactHashes: identity.artifactHashes,
    baseSha: identity.baseSha,
    candidateSha: identity.candidateSha,
    diffHash: identity.diffHash,
    missionGeneration: identity.missionGeneration,
    repoId: identity.repoId,
    workspaceManifestHash: identity.workspaceManifestHash,
  });
}

export function hashCandidateEvidenceIdentity(input: CandidateEvidenceIdentity): string {
  return `sha256:${createHash("sha256").update(canonicalCandidateEvidenceJson(input)).digest("hex")}`;
}

export function evidenceIdentitiesEqual(a: CandidateEvidenceIdentity, b: CandidateEvidenceIdentity): boolean {
  return hashCandidateEvidenceIdentity(a) === hashCandidateEvidenceIdentity(b);
}

export function taskCoverageFingerprint(
  task: Pick<OrchestrationTask, "objective" | "deliverables" | "repo_id">,
): string {
  const objective = required(task.objective, "objective");
  const repoId = required(task.repo_id ?? "", "repoId");
  const deliverables = canonicalSet(task.deliverables ?? [], "deliverables");
  return `sha256:${createHash("sha256").update(JSON.stringify({ deliverables, objective, repoId })).digest("hex")}`;
}

export function validateAcceptanceResults(raw: unknown, allowedIds: string[]): AcceptanceEvidenceResult[] {
  if (!Array.isArray(raw)) throw new Error("evidence requires explicit acceptance results");
  const allowed = new Set(allowedIds);
  const seen = new Set<string>();
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("malformed acceptance result");
    const value = entry as Partial<AcceptanceEvidenceResult>;
    const acceptanceId = required(value.acceptanceId ?? "", "acceptanceId");
    if (!allowed.has(acceptanceId) || seen.has(acceptanceId)) throw new Error("invalid acceptance result ID");
    if (value.status !== "passed" && value.status !== "failed") throw new Error("invalid acceptance result status");
    seen.add(acceptanceId);
    return { acceptanceId, status: value.status, detail: required(value.detail ?? "", "acceptance result detail") };
  });
}

export function normalizeReviewSeverity(severity: unknown): ReviewFinding["severity"] {
  if (typeof severity !== "string") throw new Error("unsupported review severity: non-string value");
  switch (severity.trim().toLowerCase()) {
    case "blocker":
    case "critical":
    case "high":
    case "blocking":
      return "blocking";
    case "medium":
    case "major":
      return "major";
    case "low":
    case "info":
    case "minor":
      return "minor";
    default:
      throw new Error(`unsupported review severity: ${severity}`);
  }
}
