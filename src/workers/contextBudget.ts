/**
 * Per-run context budget for mission workers (issue #180).
 *
 * The budget is the smaller of the role's table budget and a fraction of the
 * routed model's real context window, so a role never plans for more context
 * than the model it was placed on can hold. Compaction then starts at a
 * fraction of that budget, well before the window is full.
 */

import { ROLE_BUDGETS, type WorkerRole } from "../core/types.ts";

/** Share of the routed model's context window a worker may plan to use. */
export const CONTEXT_WINDOW_SHARE = 0.7;
/** Default share of the budget at which compaction starts (PI_WORKER_COMPACT_AT). */
export const DEFAULT_COMPACT_AT = 0.6;

export interface ContextBudget {
  /** Effective hard budget, tokens. */
  tokens: number;
  /** The role's table budget before the window clamp. */
  roleTokens: number;
  /** The routed model's context window, when known. */
  contextWindow?: number;
  /** Which bound decided: the role table, or the model's window. */
  limitedBy: "role" | "model";
  /** Set when the window is unknown and only the role budget applies. */
  warning?: string;
}

/** Role budget (`requested` if the caller set one) clamped to the routed model's window. */
export function resolveContextBudget(
  role: WorkerRole,
  requested: number | undefined,
  contextWindow: unknown,
): ContextBudget {
  const roleTokens = requested ?? ROLE_BUDGETS[role]?.hardMaxTokens ?? 32_768;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return {
      tokens: roleTokens,
      roleTokens,
      limitedBy: "role",
      warning: `context window of the routed model is unknown; ${role} budget is the role budget (${roleTokens} tokens) only`,
    };
  }
  const windowTokens = Math.floor(CONTEXT_WINDOW_SHARE * contextWindow);
  return windowTokens < roleTokens
    ? { tokens: windowTokens, roleTokens, contextWindow, limitedBy: "model" }
    : { tokens: roleTokens, roleTokens, contextWindow, limitedBy: "role" };
}

/** PI_WORKER_COMPACT_AT: fraction (0.1..0.95) of the budget at which a worker session compacts. */
export function resolveCompactAt(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_WORKER_COMPACT_AT;
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0.1 && n <= 0.95 ? n : DEFAULT_COMPACT_AT;
}

/**
 * Pi compaction settings that fire at `compactAt` of the budget. Pi compacts
 * past `window - reserveTokens`, so the reserve is what is left above the
 * trigger. `keepRecentTokens` is the autotuned recent window, bounded to half
 * the trigger so a small window still compacts something away.
 */
export function workerCompactionSettings(
  budget: ContextBudget,
  compactAt: number,
  tunedKeepRecent: number | undefined,
): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } | undefined {
  if (budget.contextWindow === undefined) return undefined;
  const trigger = Math.max(1, Math.floor(budget.tokens * compactAt));
  const keep = Math.min(tunedKeepRecent ?? 20_000, Math.max(1, Math.floor(trigger / 2)));
  return { enabled: true, reserveTokens: Math.max(0, budget.contextWindow - trigger), keepRecentTokens: keep };
}
