/**
 * Claim discipline (issues #506, #507).
 *
 * A number that describes code — a test count, a commit count, a line count —
 * is the easiest claim to invent, because the number looks like evidence. In one
 * session a hand-patterned `grep -c` produced "13 unit tests" for a file whose
 * runner prints `# tests 12`; the wrong number then "corrected" a review comment
 * that had been right. Nothing in the pipeline could have caught it.
 *
 * So: a claim that states a count must cite the machine output that produced it.
 * Either a recorded evidence entity carrying the number as a metric, or a stored
 * artifact whose text reports that number on a count line (`# tests 12`,
 * `12 tests`, `tests: 12`). A number you patterned out of a grep you wrote is
 * not a count.
 */
import type { Evidence } from "../core/types.ts";

/** A count stated in prose, e.g. "13 unit tests" -> { value: 13, noun: "tests" }. */
export interface CountClaim {
  value: number;
  noun: string;
  raw: string;
}

/** Nouns whose quantity is a property of the repository or a run, not of prose. */
const COUNTABLE =
  "tests?|test|commits?|files?|lines?|pages?|requests?|issues?|pull\\s+requests?|entities?|findings?|hits?|runs?|stages?|cases?|assertions?";

/** `13 tests`, `5,521 unit tests`, `12 failing test cases`. */
const COUNT_CLAIM_RE = new RegExp(
  `\\b(\\d[\\d,]*)\\s+(?:(?:unit|integration|e2e|smoke|acceptance|failing|passing|open|merged|changed|new|total|remaining|remaining)\\s+)*(${COUNTABLE})\\b`,
  "gi",
);

/** Every count a piece of text states, deduplicated by value+noun. */
export function countClaims(text: string): CountClaim[] {
  const seen = new Set<string>();
  const out: CountClaim[] = [];
  for (const match of text.matchAll(COUNT_CLAIM_RE)) {
    const value = Number(match[1]!.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const noun = match[2]!.toLowerCase();
    const key = `${value}|${noun}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value, noun, raw: match[0] });
  }
  return out;
}

/** Evidence summary keys that carry a measured quantity. */
const METRIC_KEYS = /^(?:value|count|total|tests?|suites?|pass(?:ed)?|files?|lines?|commits?|cases?|requests?)$/i;

/**
 * Whether a recorded evidence entity reports `value` as a metric it measured.
 * Failed or unverified runs say nothing about a count, so they never qualify.
 */
export function metricEvidenceReports(evidence: Evidence, value: number): boolean {
  if (!evidence.command) return false;
  if (evidence.status !== "passed" || evidence.exit_code !== 0) return false;
  if (evidence.trust === "unverified") return false;
  return Object.entries(evidence.summary ?? {}).some(
    ([key, raw]) => METRIC_KEYS.test(key) && typeof raw === "number" && raw === value,
  );
}

/** Count lines a command's own output printed: `# tests 12`, `12 tests`, `tests: 12`. */
const OUTPUT_COUNT_PATTERNS: RegExp[] = [
  /#\s*(?:tests?|suites?|pass(?:ed)?|fail(?:ed)?|total|files?|lines?)\s+(\d[\d,]*)/gi,
  /\b(\d[\d,]*)\s+(?:unit\s+|integration\s+)?(?:tests?|files?|lines?|commits?|requests?|cases?|assertions?)\b/gi,
  /\b(?:tests?|files?|lines?|commits?|cases?|assertions?)\s*[:=]\s*(\d[\d,]*)/gi,
];

/** The quantities a command's stored output reports. */
export function countValuesInOutput(output: string): number[] {
  const out = new Set<number>();
  for (const pattern of OUTPUT_COUNT_PATTERNS) {
    for (const match of output.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const value = Number(match[1]!.replace(/,/g, ""));
      if (Number.isFinite(value)) out.add(value);
    }
  }
  return [...out];
}

/**
 * Whether the claim's counts are backed by machine output. `evidence` is the
 * resolved entity behind the cited reference (null when the reference did not
 * resolve); `artifactText` is the stored output behind it, when available.
 */
export function countsAreBacked(
  claims: CountClaim[],
  evidence: Evidence | null,
  artifactText: string | null,
): { ok: boolean; unbacked: CountClaim[] } {
  const reported = artifactText ? new Set(countValuesInOutput(artifactText)) : new Set<number>();
  const unbacked = claims.filter((claim) => {
    if (evidence && metricEvidenceReports(evidence, claim.value)) return false;
    return !reported.has(claim.value);
  });
  return { ok: unbacked.length === 0, unbacked };
}

/** The message the guard returns when a count is not backed. */
export function countGuardMessage(unbacked: CountClaim[], cited: string | undefined): string {
  const stated = unbacked.map((c) => `"${c.raw}"`).join(", ");
  return `Refused: the claim states a count (${stated}) that the cited evidence does not report. Cite the machine output that produced it — an evidence id (EVID-…) whose summary carries the number, or an artifact:// whose stored output prints it (for test counts, the runner's own summary line, e.g. \`# tests 12\`). ${
    cited ? `The reference ${cited} resolves to output that does not report ${stated}. ` : "No evidence was cited. "
  }Run the command that counts, let its output be recorded, and cite that id. A number you patterned out of a grep you wrote yourself is not a count.`;
}
