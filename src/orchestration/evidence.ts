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

/** Lowercase and strip non-alphanumerics: "AC-1", "ac_1" and " ac 1 " name the same criterion. */
function normalizeAcceptanceId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface AcceptanceResultOptions {
  /**
   * Model-authored results (the reviewer): match IDs by normalised form, keep the
   * first of duplicates, drop unknown IDs and malformed entries with a warning,
   * and report every omitted ID as failed. Recorded evidence replay stays strict.
   */
  tolerant?: boolean;
  /** Receives one line per tolerated defect (tolerant mode only). */
  warnings?: string[];
}

function tolerantAcceptanceResults(
  raw: unknown,
  allowedIds: string[],
  warnings: string[] | undefined,
): AcceptanceEvidenceResult[] {
  const byNormalized = new Map(allowedIds.map((id) => [normalizeAcceptanceId(id), id]));
  const reported = new Map<string, AcceptanceEvidenceResult>();
  const warn = (message: string): void => {
    warnings?.push(message);
  };
  const entries = Array.isArray(raw) ? raw : [];
  if (!Array.isArray(raw)) warn("acceptance_results was not a list; every criterion counts as not reported");
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      warn("dropped a malformed acceptance result");
      continue;
    }
    const value = entry as Partial<AcceptanceEvidenceResult>;
    const given = typeof value.acceptanceId === "string" ? value.acceptanceId : "";
    const canonical = byNormalized.get(normalizeAcceptanceId(given));
    if (!canonical) {
      warn(`dropped acceptance result for unknown ID "${given}"`);
      continue;
    }
    if (value.status !== "passed" && value.status !== "failed") {
      warn(`dropped acceptance result for ${canonical}: invalid status`);
      continue;
    }
    if (reported.has(canonical)) {
      warn(`ignored duplicate acceptance result for ${canonical}`);
      continue;
    }
    const detail = typeof value.detail === "string" && value.detail.trim() ? value.detail.trim() : "no detail given";
    reported.set(canonical, { acceptanceId: canonical, status: value.status, detail });
  }
  return allowedIds.map(
    (id) => reported.get(id) ?? { acceptanceId: id, status: "failed", detail: "not reported by reviewer" },
  );
}

export function validateAcceptanceResults(
  raw: unknown,
  allowedIds: string[],
  options: AcceptanceResultOptions = {},
): AcceptanceEvidenceResult[] {
  if (options.tolerant) return tolerantAcceptanceResults(raw, allowedIds, options.warnings);
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

/** Categories whose "high" findings are recorded but never block completion. */
const NON_BLOCKING_HIGH_CATEGORIES = new Set(["missing_tests", "spec_gaps"]);

export function normalizeReviewSeverity(severity: unknown, category?: unknown): ReviewFinding["severity"] {
  if (typeof severity !== "string") throw new Error("unsupported review severity: non-string value");
  switch (severity.trim().toLowerCase()) {
    case "blocker":
    case "critical":
    case "blocking":
      return "blocking";
    case "high":
      // A high missing test or spec gap stays visible on the mission but does
      // not block; any other high finding is a defect and blocks.
      return typeof category === "string" && NON_BLOCKING_HIGH_CATEGORIES.has(category) ? "major" : "blocking";
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
