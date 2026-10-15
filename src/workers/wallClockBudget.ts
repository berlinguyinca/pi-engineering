import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Fraction of an opt-in wall-clock budget (or inactivity window) after which the worker is told to wrap up. */
export const WRAP_UP_FRACTION = 0.75;

/** Default interval, in tool calls, between budget lines in tool results. */
export const DEFAULT_BUDGET_NOTICE_EVERY = 20;

export const WRAP_UP_MESSAGE =
  "You are near the time budget. Commit what is coherent now, then call worker_result with status partial (or completed) listing done/remaining deliverables.";

/** Wrap-up for a standalone run that has gone quiet for most of its inactivity window. */
export const SILENCE_WRAP_UP_MESSAGE =
  "You have been quiet for most of the inactivity limit and this run will be stopped soon. Commit what is coherent now, then call worker_result with status partial (or completed) listing done/remaining deliverables.";

export const REVIEW_NUDGE_MESSAGE = "Call review_result now with your verdict, summary and findings.";

/** Timer seam so wrap-up timing can be driven without real sleeps. */
export interface WorkerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: WorkerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const NUDGE_MESSAGE = "Call worker_result now with your status, summary and committed changes.";

const minutes = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m ${total % 60}s` : `${total}s`;
};

/** One short line: how much of the wall-clock budget is used and left. */
export function budgetLine(clock: { startedAt: number; budgetMs: number }, now: number): string {
  const elapsed = Math.max(0, now - clock.startedAt);
  return `Time budget: ${minutes(elapsed)} elapsed, ${minutes(clock.budgetMs - elapsed)} remaining.`;
}

/**
 * Wrap a tool so its result carries `notice()` as an extra text block whenever
 * the notice is non-empty. The tool keeps its name, so it replaces the built-in.
 */
export function withBudgetNotice(tool: ToolDefinition, notice: () => string | undefined): ToolDefinition {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
      const line = notice();
      if (!line) return result;
      return { ...result, content: [...result.content, { type: "text", text: line }] };
    },
  } as ToolDefinition;
}
