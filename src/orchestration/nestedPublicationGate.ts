/**
 * Gate acceptance and findings suppression for nested standalone repo
 * publications (defect-4).
 *
 * A mission anchors to the repository it started in, but workers may publish
 * work to standalone git repositories nested inside the anchored working tree
 * (e.g. a private product repo inside a meta-root). GitRepo records a durable
 * `NestedRepoPublication` for each nested repo whose HEAD advanced over the
 * execution window. This module defines how the orchestration layer consumes
 * those records. It is purely additive: the anchored-repo candidate flow is
 * untouched and these rules only apply to recorded nested publications.
 *
 *  - GATE ACCEPTANCE: a recorded publication is candidate evidence when the
 *    nested HEAD advanced (headSha !== baseSha) AND the work is on the nested
 *    remote (publishedSha === headSha) OR the nested repo has no remote
 *    (publishedSha === null). The validation step re-verifies that the nested
 *    HEAD still equals the recorded headSha (GitRepo.verifyNestedRepoPublication);
 *    the review step consumes the recorded diff stat
 *    (NestedRepoPublication.diffStat) so it does not need a worktree.
 *  - FINDINGS SUPPRESSION: when an acceptable publication exists for a
 *    mission, the anchored "unmerged worker work preserved" finding is
 *    downgraded to a non-blocking note that references the publication, so a
 *    mission whose work was published to a nested repo is not reported with
 *    lost-work findings.
 */
import type { NestedRepoPublication } from "../git/GitRepo.ts";
import type { ReviewFinding } from "./types.ts";

/** Finding shape accepted by MissionStore.addFinding. */
export type FindingInput = Omit<ReviewFinding, "finding_id" | "status" | "created_at">;

/**
 * Gate acceptance predicate: a nested repo publication is accepted as candidate
 * evidence when the nested HEAD advanced over the execution window and the
 * work is on the nested remote, or the nested repo has no remote at all.
 * A publication whose remote lacks the new head (publishedSha !== headSha) is
 * NOT acceptable: the deliverable is not durably published.
 */
export function isNestedPublicationAcceptable(record: NestedRepoPublication): boolean {
  return record.headSha !== record.baseSha && (record.publishedSha === null || record.publishedSha === record.headSha);
}

/** All acceptable records, in input order. */
export function acceptableNestedPublications(records: ReadonlyArray<NestedRepoPublication>): NestedRepoPublication[] {
  return records.filter(isNestedPublicationAcceptable);
}

/** True when at least one record is acceptable candidate evidence. */
export function hasAcceptableNestedPublication(records: ReadonlyArray<NestedRepoPublication>): boolean {
  return records.some(isNestedPublicationAcceptable);
}

const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : "none");

/** Compact human-readable reference used in findings and audit trails. */
export function nestedPublicationReference(record: NestedRepoPublication): string {
  return `nested repo ${record.nestedPath} in ${record.anchoredRepoId} (${shortSha(record.baseSha)}..${shortSha(
    record.headSha,
  )}, published ${shortSha(record.publishedSha)})`;
}

/** Machine-readable evidence payload for findings bound to publications. */
export function nestedPublicationEvidenceJson(records: ReadonlyArray<NestedRepoPublication>): string {
  return JSON.stringify(
    records.map((record) => ({
      nestedPath: record.nestedPath,
      remoteUrl: record.remoteUrl,
      baseSha: record.baseSha,
      headSha: record.headSha,
      publishedSha: record.publishedSha,
      capturedAt: record.capturedAt,
    })),
  );
}

const UNMERGED_WORK_PREFIX = "Unmerged worker work preserved";

/**
 * Findings suppression: when the mission's work was published to a nested
 * standalone repo, an anchored "unmerged worker work preserved" finding no
 * longer describes lost work — the deliverable lives in the nested repo. The
 * finding is downgraded to the lowest severity and annotated with the
 * publication reference so it stays auditable but can never block. Findings
 * that do not match, or missions without an acceptable publication, are
 * returned unchanged (same object reference).
 */
export function suppressUnmergedWorkFinding(
  finding: FindingInput,
  records: ReadonlyArray<NestedRepoPublication>,
): FindingInput {
  const acceptable = acceptableNestedPublications(records);
  if (acceptable.length === 0) return finding;
  if (finding.category !== "integration" || !finding.summary.startsWith(UNMERGED_WORK_PREFIX)) return finding;
  return {
    ...finding,
    severity: "minor",
    summary: `${finding.summary} — superseded by ${acceptable.map(nestedPublicationReference).join("; ")}`,
    evidence: nestedPublicationEvidenceJson(acceptable),
    recommended_action:
      "No manual merge required: the work was published to the nested standalone repo; verify the nested remote carries the published head.",
  };
}
