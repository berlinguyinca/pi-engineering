import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** ~12k tokens of diff; a longer diff is replaced by the full `--stat` plus a notice. */
export const REVIEW_DIFF_CHAR_CAP = 48_000;
const SUMMARY_CHAR_CAP = 1_200;
const FAILURE_TAIL_CHAR_CAP = 1_500;

export interface ReviewContextInput {
  /** A checkout of the repository that holds both commits (worktrees share its objects). */
  repoRoot?: string;
  baseSha?: string;
  candidateSha?: string;
  criteria: Array<{ acceptanceId: string; criterion: string }>;
  validation:
    | { state: "pending" }
    | {
        state: "finished";
        passed: boolean;
        stages: Array<{ name: string; passed: boolean }>;
        /** Failure text of the validation run; only its tail is shown. */
        failureOutput?: string;
      };
  workerSummaries: Array<{ taskId: string; summary: string }>;
}

function tail(text: string, cap: number): string {
  const trimmed = text.trim();
  return trimmed.length <= cap ? trimmed : `...${trimmed.slice(trimmed.length - cap)}`;
}

function head(text: string, cap: number): string {
  const trimmed = text.trim();
  return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap)}...`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

async function diffSection(input: ReviewContextInput): Promise<string> {
  const { repoRoot, baseSha, candidateSha } = input;
  if (!repoRoot || !baseSha || !candidateSha)
    return "## Diff\nNo candidate commit is recorded; inspect the working tree.";
  const range = `${baseSha}..${candidateSha}`;
  try {
    const diff = await git(repoRoot, ["diff", "--no-color", range]);
    if (diff.length <= REVIEW_DIFF_CHAR_CAP)
      return `## Diff (git diff ${range})\n\`\`\`diff\n${diff.trimEnd()}\n\`\`\``;
    const stat = await git(repoRoot, ["diff", "--no-color", "--stat=200", range]);
    return `## Diff (git diff ${range}) TRUNCATED\nThe full diff is ${diff.length} characters, over the ${REVIEW_DIFF_CHAR_CAP} character cap. The complete \`git diff --stat\` follows, then the first part of the diff; read the remaining files with your tools.\n\`\`\`\n${stat.trimEnd()}\n\`\`\`\n\`\`\`diff\n${diff.slice(0, REVIEW_DIFF_CHAR_CAP)}\n\`\`\``;
  } catch (error) {
    return `## Diff\nThe diff ${range} could not be produced (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); inspect the working tree.`;
  }
}

function validationSection(validation: ReviewContextInput["validation"]): string {
  if (validation.state === "pending") return "## Validation\nvalidation pending: its result is not available yet.";
  const stages = validation.stages.map((stage) => `- ${stage.name}: ${stage.passed ? "pass" : "FAIL"}`).join("\n");
  const failing = !validation.passed && validation.failureOutput?.trim();
  return `## Validation (${validation.passed ? "passed" : "FAILED"})\n${stages || "- no stages ran"}${
    failing
      ? `\nTail of the failing output:\n\`\`\`\n${tail(validation.failureOutput ?? "", FAILURE_TAIL_CHAR_CAP)}\n\`\`\``
      : ""
  }`;
}

/** The text the reviewer reads before it opens a tool: the change, the evidence, and the exact IDs to report on. */
export async function buildReviewContext(input: ReviewContextInput): Promise<string> {
  const workers = input.workerSummaries.length
    ? input.workerSummaries.map((w) => `- ${w.taskId}: ${head(w.summary, SUMMARY_CHAR_CAP)}`).join("\n")
    : "- none recorded";
  const criteria = input.criteria.length
    ? input.criteria.map((c) => `- ${c.acceptanceId}: ${c.criterion}`).join("\n")
    : "- none";
  const template = JSON.stringify(
    input.criteria.map((c) => ({ acceptanceId: c.acceptanceId, status: "passed | failed", detail: "evidence" })),
    null,
    2,
  );
  return [
    await diffSection(input),
    validationSection(input.validation),
    `## Implementer summaries\n${workers}`,
    `## Acceptance criteria\n${criteria}`,
    `## acceptance_results template\nReport every ID below, exactly as written, in review_result.acceptance_results:\n\`\`\`json\n${template}\n\`\`\``,
  ].join("\n\n");
}
