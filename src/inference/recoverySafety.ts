/**
 * Replay safety (R05): whether recovery may automatically re-execute one tool action. This is neither
 * permission (src/guard/toolCallGuard.ts `checkToolCall`, which only blocks) nor the ledger's
 * `idempotency_key` fence (src/ledger/Ledger.ts, which rejects a reused durable event, not a repeated side
 * effect); `RiskPolicy` in src/lifecycle/policy.ts is named here in prose only. Pure like
 * endpointCircuit.ts and retryBudget.ts: input-only, no clock, RNG, environment, timer or I/O, and no
 * `nowMs` — precedence is invalid_input, mutating, external, unknown_tool, idempotent_key, read_only, and
 * nothing is ever defaulted to replayable.
 */
export type ReplaySafety = "safe" | "unsafe" | "unknown";
/** Why recovery may or may not re-run the action. */
export type ReplayReason = "read_only" | "idempotent_key" | "mutating" | "external" | "unknown_tool" | "invalid_input";
/** The harness's non-mutating tool surface, matched by exact name only: never case-folded, never trimmed.
 * Adding a name here is a policy change requiring evidence, not a convenience. */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
  "read",
  "grep",
  "glob",
  "ls",
  "symbol",
  "repo_search",
  "tests_for",
];
/** The action recovery is holding, with its self-declared hazards; an absent flag is not proof of either. */
export interface ToolAction {
  name: string;
  writes?: boolean;
  external?: boolean;
  idempotencyKey?: string;
}
export interface ReplayVerdict {
  safety: ReplaySafety;
  replayAllowed: boolean;
  reason: ReplayReason;
}

const refused = (safety: ReplaySafety, reason: ReplayReason): ReplayVerdict => ({
  safety,
  replayAllowed: false,
  reason,
});

/** Decide whether recovery may replay this action; anything it cannot prove read-only is refused. */
export function classifyReplaySafety(action: ToolAction): ReplayVerdict {
  if (action === null || typeof action !== "object") return refused("unknown", "invalid_input");
  const name = action.name;
  if (typeof name !== "string" || name === "") return refused("unknown", "invalid_input");
  if (action.writes === true) return refused("unsafe", "mutating");
  if (action.external === true) return refused("unsafe", "external");
  if (!READ_ONLY_TOOL_NAMES.includes(name)) return refused("unknown", "unknown_tool");
  const key = action.idempotencyKey;
  const usable = typeof key === "string" && key.trim() !== "";
  return { safety: "safe", replayAllowed: true, reason: usable ? "idempotent_key" : "read_only" };
}
