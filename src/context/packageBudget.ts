/**
 * Context package budgeting: fit a set of package files into a token budget.
 *
 * A "context package" is an ordered collection of files that an agent hands to
 * a model as context. When the total would overflow the model's window we must
 * drop the least important files rather than silently truncate or blow past
 * the cap. This module is pure and deterministic so it is testable without a
 * live session.
 */

export interface PackageFile {
  path: string;
  content: string;
  /** Required files are never dropped, even if they blow past the budget. */
  required?: boolean;
}

export interface PackageBudgetResult {
  kept: Array<PackageFile>;
  dropped: string[];
  /** Total token estimate of the kept files (honest even when over budget). */
  tokens: number;
}

/** Default estimator: ~4 chars per token, rounded up. */
export function estimateTokensDefault(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Fit files into `maxTokens` tokens.
 *
 * Required files are always kept, in their original order, and counted toward
 * `tokens` even when that alone exceeds the budget. Optional files are then
 * added in the given order while the running total stays within `maxTokens`;
 * anything left out is reported in `dropped` (in the order it was skipped).
 */
export function capContextPackage(
  files: Array<PackageFile>,
  maxTokens: number,
  estimateTokens: (s: string) => number = estimateTokensDefault,
): PackageBudgetResult {
  const kept: Array<PackageFile> = [];
  const dropped: string[] = [];

  // Keep every required file first, regardless of budget.
  for (const file of files) {
    if (file.required) {
      kept.push(file);
    }
  }

  const requiredTokens = kept.reduce((sum, file) => sum + estimateTokens(file.content), 0);
  let total = requiredTokens;

  // Add optional files in order while the budget allows.
  for (const file of files) {
    if (file.required) {
      continue;
    }
    const cost = estimateTokens(file.content);
    if (total + cost <= maxTokens) {
      kept.push(file);
      total += cost;
    } else {
      dropped.push(file.path);
    }
  }

  return { kept, dropped, tokens: total };
}
