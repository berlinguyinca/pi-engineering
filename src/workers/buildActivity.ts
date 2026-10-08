/**
 * Build activity of a worker, as evidence for a budget-exhausted execution.
 *
 * Worker activity never carries tool arguments. The one exception made here: a
 * bash command is classified into a fixed build-tool label (cargo, npm, ...),
 * and the time each such command took is measured, so that a worker whose
 * execution budget ran out can say how much of it went to building. No part of
 * the command is ever copied.
 */

/** Build tools recognised in a worker's shell command (a fixed, non-sensitive label set). */
export const BUILD_TOOLS = ["cargo", "npm", "pnpm", "yarn", "gradle", "mvn", "go", "make"] as const;
export type BuildTool = (typeof BUILD_TOOLS)[number];

const BUILD_TOOL_SET: ReadonlySet<string> = new Set(BUILD_TOOLS);

/** Subcommands that compile (not e.g. `cargo --version`, `npm view`, `go env`). */
const BUILD_VERBS: Record<BuildTool, RegExp> = {
  cargo: /^(build|b|test|t|check|c|run|r|clippy|bench|nextest|doc|install)\b/,
  npm: /^(run|test|t|ci|install|i|exec)\b/,
  pnpm: /^(run|test|t|install|i|build|exec)\b/,
  yarn: /^/,
  gradle: /^/,
  mvn: /^/,
  go: /^(build|test|run|install|vet)\b/,
  make: /^/,
};

/**
 * Label the build tool a shell command invokes, if any. Looks at each simple
 * command (split on `&&`, `||`, `;`, `|`), skipping leading `VAR=value`
 * assignments, `cd dir &&`, `timeout N` and `env`. Returns only a label from
 * BUILD_TOOLS: no part of the command is ever copied.
 */
export function buildToolOf(command: unknown): BuildTool | undefined {
  if (typeof command !== "string") return undefined;
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      const word = words[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === "env" || word === "time" || word === "nice") i++;
      else if (word === "timeout") i += 2;
      else break;
    }
    const exe = words[i]?.split("/").at(-1);
    if (!exe) continue;
    const tool = exe === "gradlew" ? "gradle" : exe === "mvnw" ? "mvn" : exe;
    if (!BUILD_TOOL_SET.has(tool)) continue;
    const rest = words
      .slice(i + 1)
      .filter((w) => !w.startsWith("-") && !w.startsWith("+"))
      .join(" ");
    if (BUILD_VERBS[tool as BuildTool].test(rest)) return tool as BuildTool;
  }
  return undefined;
}

/** True for a label from BUILD_TOOLS (the activity trust boundary). */
export function isBuildTool(value: unknown): value is BuildTool {
  return typeof value === "string" && BUILD_TOOL_SET.has(value);
}

/**
 * Pairs a bash build command's start and end events (by tool call id) so the
 * end activity carries the build-tool label and the command's wall-clock time.
 */
export class BuildCommandTimer {
  private readonly inFlight = new Map<string, { buildTool: BuildTool; startedAt: number }>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  observe<A extends { kind: string; phase?: string; buildTool?: BuildTool; elapsedMs?: number }>(
    event: object,
    activity: A | null,
  ): A | null {
    const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
    if (activity?.kind !== "tool" || toolCallId === undefined) return activity;
    const key = String(toolCallId);
    if (activity.phase === "started") {
      if (activity.buildTool) this.inFlight.set(key, { buildTool: activity.buildTool, startedAt: this.now() });
      return activity;
    }
    const build = this.inFlight.get(key);
    if (!build) return activity;
    this.inFlight.delete(key);
    return { ...activity, buildTool: build.buildTool, elapsedMs: Math.max(0, this.now() - build.startedAt) };
  }
}

export interface BudgetExhaustedEvidence {
  /** Build commands the worker started, per tool label. */
  buildCommands: ReadonlyMap<string, number> | Record<string, number> | undefined;
  /** Wall-clock time of the build commands that finished. */
  buildMs: number;
  /** Build commands started but not finished when the execution ended. */
  buildsRunning: number;
  /** Elapsed time of the execution (start to end). */
  elapsedMs: number | undefined;
  /** Paths the checkpoint recorded as committed (empty: the worker committed nothing). */
  committedChanges: readonly string[];
  /** True when the execution ran in an isolated worktree. */
  isolatedWorktree: boolean;
}

function minutes(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Operator-facing explanation for a budget-exhausted worker that ran builds and
 * committed nothing, or undefined when its logged activity shows no builds.
 * Claims only what was observed: which build tools ran and for how long, whether
 * one was still running at the end, and the share of the execution they took.
 * "probable cold build" is said only when builds took most of the time (a fresh
 * worktree starts without build output, so its first build is cold); otherwise
 * the hint says the time went elsewhere.
 */
export function budgetExhaustedBuildHint(evidence: BudgetExhaustedEvidence): string | undefined {
  if (!evidence.isolatedWorktree || evidence.committedChanges.length > 0) return undefined;
  const entries = (
    evidence.buildCommands instanceof Map
      ? [...evidence.buildCommands.entries()]
      : Object.entries(evidence.buildCommands ?? {})
  ).filter(([tool, n]) => isBuildTool(tool) && n > 0);
  if (entries.length === 0) return undefined;
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const ran = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, n]) => `${tool} x${n}`)
    .join(", ");
  const running = evidence.buildsRunning > 0 ? `, ${evidence.buildsRunning} still running at the deadline` : "";
  const elapsed = evidence.elapsedMs && evidence.elapsedMs > 0 ? evidence.elapsedMs : undefined;
  const share = elapsed ? ` of the ${minutes(elapsed)} run` : "";
  const observed = `the worker spent ${minutes(evidence.buildMs)}${share} in ${total} build command(s) (${ran})${running}, and made no commit`;
  // A build still running at the deadline is not in buildMs: it counts as
  // build-dominated only by what was measured.
  if (elapsed && evidence.buildMs >= elapsed / 2) return `probable cold build in an isolated worktree: ${observed}`;
  if (evidence.buildsRunning > 0 && !elapsed) return `the budget ran out during a build: ${observed}`;
  return `${observed}; builds took the smaller part of the budget, so most of it went to other work (model turns, other commands)`;
}
