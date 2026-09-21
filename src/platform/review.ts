/**
 * Reviewer isolation (spec 06).
 *
 * A fresh reviewer sees ONLY allowed content: requirements, accepted
 * architecture, the code/diff, tests and permitted project memory. It never
 * sees the implementer's private history, self-ratings, other verdicts or
 * hidden chain-of-thought. This helper assembles a reviewer brief from
 * explicitly-allowlisted sources so isolation is structural, not a convention.
 */

export interface ReviewableContent {
  kind: string;
  body: string;
}

export interface ReviewerBriefInputs {
  requirements: string[];
  architecture: string[];
  diff: string;
  tests: string[];
  /** Permitted shared project memory (accepted/validated only). */
  allowedMemory: string[];
  /** Explicitly excluded: private implementer history, self-ratings, other verdicts. */
  excluded?: string[];
}

/** Kinds never eligible for a reviewer brief, whatever the source claims. */
const NEVER_INCLUDE = new Set([
  "implementer_private_history",
  "self_rating",
  "other_verdict",
  "hidden_reasoning",
  "chain_of_thought",
  "speculative_guess",
]);

/** Body markers that mark content as private/unfit for a reviewer. */
const PRIVATE_MARKERS = [
  "self_rating",
  "self-rating",
  "implementer_private_history",
  "other_verdict",
  "hidden_reasoning",
  "chain_of_thought",
  "chain-of-thought",
];

/** True when a content body carries a private/forbidden marker. */
export function isPrivateContent(body: string): boolean {
  const lower = body.toLowerCase();
  return PRIVATE_MARKERS.some((m) => lower.includes(m));
}

export function buildReviewerBrief(inputs: ReviewerBriefInputs): ReviewableContent[] {
  const brief: ReviewableContent[] = [];
  const push = (kind: string, body: string) => {
    if (body.trim()) brief.push({ kind, body });
  };
  for (const r of inputs.requirements) push("requirement", r);
  for (const a of inputs.architecture) push("architecture", a);
  push("diff", inputs.diff);
  for (const t of inputs.tests) push("test", t);
  for (const m of inputs.allowedMemory) push("project_memory", m);
  return brief;
}

/**
 * True when the brief contains none of the excluded/private kinds — the
 * isolation invariant a reviewer must not violate.
 */
export function briefIsIsolated(brief: ReviewableContent[]): boolean {
  return brief.every(
    (c) => !NEVER_INCLUDE.has(c.kind) && !c.kind.startsWith("implementer_") && !isPrivateContent(c.body),
  );
}
