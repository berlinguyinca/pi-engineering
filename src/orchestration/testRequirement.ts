/** An acceptance criterion as far as the test requirement is concerned; the id is only for messages. */
export interface CriterionText {
  acceptance_id?: string;
  criterion: string;
}

/** A creation verb within a few words of "test(s)": the criterion demands tests be written. */
const CREATES_TESTS =
  /\b(?:add|adds|write|writes|create|creates|include|includes|introduce|introduces)\b(?:\W+\w+){0,4}?\W+tests?\b/i;
/** Wording that talks about tests passing/existing rather than being created. */
const ABOUT_EXISTING_TESTS = /\b(?:pass|passes|passing|green|succeed|succeeds|still|existing)\b/i;

export function criterionRequiresTests(criterion: string): boolean {
  return CREATES_TESTS.test(criterion) && !ABOUT_EXISTING_TESTS.test(criterion);
}

/**
 * The failure message when a repository has no verification targets but the
 * acceptance criteria require tests; undefined when no criterion does. Criteria
 * without a stable id are included (named by their text).
 */
export function noTargetsTestRequirement(criteria: readonly CriterionText[] | undefined): string | undefined {
  const required = (criteria ?? []).filter((c) => criterionRequiresTests(c.criterion));
  if (required.length === 0) return undefined;
  const names = required.map((c) => c.acceptance_id ?? `"${c.criterion}"`).join(", ");
  return `acceptance ${names} requires tests but no verification targets were detected (no tests were added)`;
}
