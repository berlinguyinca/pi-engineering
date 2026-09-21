/**
 * RequestBudgetManager — payload-byte + token budgeting for model requests
 * (spec: pi-engineering-vision-payload-management, §§15-19).
 *
 * Pure deterministic logic operating on plain structured breakdown inputs.
 */

export interface PayloadBreakdown {
  textBytes: number;
  jsonOverheadBytes: number;
  toolCallBytes: number;
  encodedImageBytes: number;
  messageMetadataBytes: number;
  providerWrapperBytes: number;
  totalEstimatedBytes: number;
}

/** Small fixed JSON serialization overhead added to every estimate. */
export const JSON_SERIALIZATION_OVERHEAD_BYTES = 256;

export function estimatePayloadBytes(b: Partial<PayloadBreakdown>): number {
  const base =
    (b.textBytes ?? 0) +
    (b.jsonOverheadBytes ?? 0) +
    (b.toolCallBytes ?? 0) +
    (b.encodedImageBytes ?? 0) +
    (b.messageMetadataBytes ?? 0) +
    (b.providerWrapperBytes ?? 0);
  return base + JSON_SERIALIZATION_OVERHEAD_BYTES;
}

export function estimateTokensForBytes(bytes: number, bytesPerToken = 4): number {
  if (bytesPerToken <= 0) return 0;
  return Math.ceil(bytes / bytesPerToken);
}

export type BudgetState = "SAFE" | "WARNING" | "MITIGATE" | "CRITICAL";

export interface BudgetThresholds {
  warning: number;
  mitigate: number;
  critical: number;
}

export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = {
  warning: 0.5,
  mitigate: 0.65,
  critical: 0.8,
};

/**
 * Classify utilization into a budget state using configurable thresholds.
 * Defaults: SAFE < 0.5, WARNING 0.5-0.65, MITIGATE 0.65-0.8, CRITICAL >= 0.8.
 */
export function classifyBudget(utilization: number, thresholds: Partial<BudgetThresholds> = {}): BudgetState {
  const t = { ...DEFAULT_BUDGET_THRESHOLDS, ...thresholds };
  if (utilization < t.warning) return "SAFE";
  if (utilization < t.mitigate) return "WARNING";
  if (utilization < t.critical) return "MITIGATE";
  return "CRITICAL";
}

export const PAYLOAD_REDUCTION_ORDER = [
  "drop_raw_visual_assets",
  "use_design_observations",
  "remove_duplicate_image_representations",
  "use_resized_derivatives",
  "remove_unnecessary_tool_outputs",
  "summarize_stale_verbose_outputs",
  "compact_conversational_history",
  "split_into_isolated_workers",
] as const;

export class RequestBudgetManager {
  readonly maxRequestBytes: number;
  readonly maxContextTokens: number;

  constructor(maxRequestBytes: number, maxContextTokens: number) {
    this.maxRequestBytes = maxRequestBytes;
    this.maxContextTokens = maxContextTokens;
  }

  estimate(breakdown: Partial<PayloadBreakdown>): {
    estimatedPayloadBytes: number;
    estimatedTokens: number;
    utilization: number;
    budgetState: BudgetState;
  } {
    const estimatedPayloadBytes = estimatePayloadBytes(breakdown);
    const estimatedTokens = estimateTokensForBytes(estimatedPayloadBytes);
    const payloadUtilization = this.maxRequestBytes > 0 ? estimatedPayloadBytes / this.maxRequestBytes : 0;
    const tokenUtilization = this.maxContextTokens > 0 ? estimatedTokens / this.maxContextTokens : 0;
    const utilization = Math.max(payloadUtilization, tokenUtilization);
    return { estimatedPayloadBytes, estimatedTokens, utilization, budgetState: classifyBudget(utilization) };
  }

  preflight(breakdown: Partial<PayloadBreakdown>): {
    allowed: boolean;
    estimatedBytes: number;
    maximumBytes: number;
    reductionRequired: number;
    recommendedActions: string[];
  } {
    const { estimatedPayloadBytes, utilization } = this.estimate(breakdown);
    const critical = DEFAULT_BUDGET_THRESHOLDS.critical;
    const allowed = utilization < critical && estimatedPayloadBytes <= this.maxRequestBytes;
    const reductionRequired = allowed ? 0 : Math.max(0, estimatedPayloadBytes - this.maxRequestBytes);
    const recommendedActions = allowed ? [] : [...PAYLOAD_REDUCTION_ORDER];
    return {
      allowed,
      estimatedBytes: estimatedPayloadBytes,
      maximumBytes: this.maxRequestBytes,
      reductionRequired,
      recommendedActions,
    };
  }
}
