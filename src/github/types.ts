/**
 * Durable records of the optional GitHub linkage layer (T05). They live in the mission
 * journal (MissionStore events `github.*`) and are plain data: replay rebuilds them.
 */
import { createHash } from "node:crypto";

export type LinkSubjectKind = "mission" | "task" | "attempt" | "commit";
export type LinkProvenance =
  | "explicit_ref" // a reference written in the goal, task, branch or PR body
  | "operator" // operator-provided mapping
  | "autospec" // AutoSpec-provided mapping
  | "pr_create_output" // URL printed by `gh pr create`, or a PR handed to Pi
  | "confirmed_suggestion";
export type LinkStatus = "active" | "removed" | "not_found";
export type ObservedState = "open" | "closed" | "merged";

export interface LinkSubject {
  kind: LinkSubjectKind;
  id: string;
}

export interface LinkObservation {
  state?: ObservedState;
  /** PR head SHA last observed (lowercase hex). */
  headSha?: string;
  /** Bounded, redacted title. */
  title?: string;
  observedAt?: string;
}

export interface GithubLinkRecord {
  linkId: string;
  missionId: string;
  subject: LinkSubject;
  /** Canonical lineage id: `issue:github.com/o/r#n` or `pr:...`. */
  target: string;
  targetKind: "issue" | "pr";
  provenance: LinkProvenance;
  /** Where the reference was found: "goal", "task:<id>", "branch", "pr_body", "operator"... */
  source: string;
  /** For a reference taken from a PR body: the PR whose body must keep carrying it. */
  viaPr?: string;
  observed: LinkObservation;
  status: LinkStatus;
  /** Consecutive reconcile passes that got a definitive 404 (reset on success). */
  notFoundCount?: number;
  /** Increments on every observed PR head change, so A->B->A->B yields distinct signal/transition ids. */
  epoch?: number;
  recordedAt: string;
}

export interface GithubLinkSuggestion {
  suggestionId: string;
  missionId: string;
  subject: LinkSubject;
  target: string;
  targetKind: "issue" | "pr";
  /** Why this was suggested; never sufficient to link. */
  reason: string;
  title: string;
  state: "pending" | "confirmed" | "dismissed";
  recordedAt: string;
}

export interface GithubStaleSignal {
  signalId: string;
  missionId: string;
  linkId: string;
  /** Canonical PR id. */
  target: string;
  reason: "pr_head_changed";
  previousHeadSha: string;
  headSha: string;
  /** The link epoch this head change produced. */
  epoch: number;
  recordedAt: string;
}

export interface GithubLinkPatch {
  status?: LinkStatus;
  observed?: LinkObservation;
  notFoundCount?: number;
  epoch?: number;
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20);
}

export function linkIdFor(missionId: string, subject: LinkSubject, target: string): string {
  return `ghl_${digest([missionId, subject.kind, subject.id, target])}`;
}
export function suggestionIdFor(missionId: string, subject: LinkSubject, target: string): string {
  return `ghs_${digest([missionId, subject.kind, subject.id, target])}`;
}
export function staleSignalIdFor(linkId: string, previousHeadSha: string, headSha: string, epoch: number): string {
  return `ghx_${digest([linkId, previousHeadSha, headSha, String(epoch)])}`;
}
