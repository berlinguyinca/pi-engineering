import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Fraction of an opt-in wall-clock budget (or inactivity window) after which the worker is told to wrap up. */
export const WRAP_UP_FRACTION = 0.75;

/** Default interval, in tool calls, between budget lines in tool results. */
export const DEFAULT_BUDGET_NOTICE_EVERY = 20;

export const WRAP_UP_MESSAGE =
  "You are near the time budget. Commit what is coherent now, then call worker_result with status partial (or completed) listing done/remaining deliverables.";

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
