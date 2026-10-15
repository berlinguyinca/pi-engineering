/** An acceptance criterion as far as the test requirement is concerned; the id is only for messages. */
export interface CriterionText {
  acceptance_id?: string;
  criterion: string;
}

/** A creation verb within a few words of "test(s)": the criterion demands tests be written. */
const CREATES_TESTS =
  /\b(?:add|adds|write|writes|create|creates|include|includes|introduce|introduces)\b(?:\W+\w+){0,4}?\W+tests?\b/i;
/** Passive or noun-led forms: "Tests are added for X", "New tests cover X". */
const TESTS_ARE_CREATED =
  /\btests?\b\W+(?:\w+\W+){0,2}?(?:added|written|included|created)\b|\bnew\b(?:\W+\w+){0,2}?\W+tests?\b\W+(?:cover|covers|verify|verifies|exercise|exercises)\b/i;

export function criterionRequiresTests(criterion: string): boolean {
  return CREATES_TESTS.test(criterion) || TESTS_ARE_CREATED.test(criterion);
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
