/**
 * Bootstrap package construction: build a bounded, verified context package
 * for a successor generation with explicit lazy-retrieval deferrals.
 *
 * Items are filtered by a fixed rule order (sensitive, invalid tokens,
 * unverified, stale) and the survivors are packed into a budget. Anything that
 * does not fit is deferred (for lazy retrieval) or dropped (for items that must
 * never be carried across generations). This module is pure, deterministic and
 * never throws, so it is testable without a live session.
 */

export type BootstrapKind = "decision" | "file_ref" | "summary" | "sensitive" | "raw_log";

export interface BootstrapItem {
  id: string;
  kind: BootstrapKind;
  tokens: number;
  verified: boolean;
  updatedAtMs: number;
  required?: boolean;
}

export interface BootstrapReasonEntry {
  id: string;
  reason: string;
}

export interface BootstrapPackage {
  included: BootstrapItem[];
  deferred: BootstrapReasonEntry[];
  dropped: BootstrapReasonEntry[];
  totalTokens: number;
  reasons: string[];
}

export interface BootstrapPackageInput {
  items: readonly BootstrapItem[];
  maxTokens: number;
  maxItems: number;
  nowMs: number;
  maxAgeMs: number;
}

/** Kind priority for packing (lower is earlier). */
const KIND_PRIORITY: Record<BootstrapKind, number> = {
  decision: 0,
  file_ref: 1,
  summary: 2,
  raw_log: 3,
  sensitive: 4,
};

/**
 * Build a bootstrap package from the given items.
 *
 * Filter rules (applied in order, walking items in input order; the first
 * matching rule drops the item — a required flag never overrides a drop):
 *   1. kind === 'sensitive'            -> dropped 'sensitive item never carried'
 *   2. !Number.isFinite(tokens) || tokens < 0 -> dropped 'invalid token count'
 *   3. !verified                       -> dropped 'unverified item'
 *   4. nowMs - updatedAtMs > maxAgeMs   -> dropped 'stale item'
 *
 * Survivors are stable-sorted (required first, then kind priority, then
 * updatedAtMs descending, then id ascending) and packed: required items are
 * always included; optional items are included while the running count and
 * token budget allow, otherwise deferred.
 */
export function buildBootstrapPackage(input: BootstrapPackageInput): BootstrapPackage {
  const { items, maxTokens, maxItems, nowMs, maxAgeMs } = input;

  const dropped: BootstrapReasonEntry[] = [];
  const survivors: BootstrapItem[] = [];

  // FILTER: walk in input order; first matching rule drops the item.
  for (const item of items) {
    if (item.kind === "sensitive") {
      dropped.push({ id: item.id, reason: "sensitive item never carried" });
      continue;
    }
    if (!Number.isFinite(item.tokens) || item.tokens < 0) {
      dropped.push({ id: item.id, reason: "invalid token count" });
      continue;
    }
    if (!item.verified) {
      dropped.push({ id: item.id, reason: "unverified item" });
      continue;
    }
    if (nowMs - item.updatedAtMs > maxAgeMs) {
      dropped.push({ id: item.id, reason: "stale item" });
      continue;
    }
    survivors.push(item);
  }

  // PACK: stable sort of survivors.
  const sorted = [...survivors].sort((a, b) => {
    if (a.required !== b.required) {
      return a.required ? -1 : 1;
    }
    const kindDiff = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
    if (kindDiff !== 0) {
      return kindDiff;
    }
    const timeDiff = b.updatedAtMs - a.updatedAtMs;
    if (timeDiff !== 0) {
      return timeDiff;
    }
    if (a.id < b.id) {
      return -1;
    }
    if (a.id > b.id) {
      return 1;
    }
    return 0;
  });

  const included: BootstrapItem[] = [];
  const deferred: BootstrapReasonEntry[] = [];
  let count = 0;
  let total = 0;

  for (const item of sorted) {
    if (item.required) {
      // A required item is always included.
      included.push(item);
      count += 1;
      total += item.tokens;
      if (total > maxTokens || count > maxItems) {
        deferred.push({ id: item.id, reason: `required item exceeds budget: ${item.id}` });
      }
      continue;
    }
    // Non-required item: item-budget check before the token check.
    if (count >= maxItems) {
      deferred.push({ id: item.id, reason: "over item budget" });
      continue;
    }
    if (total + item.tokens > maxTokens) {
      deferred.push({ id: item.id, reason: "over token budget" });
      continue;
    }
    included.push(item);
    count += 1;
    total += item.tokens;
  }

  const reasons: string[] = [];
  if (deferred.length > 0) {
    reasons.push(`deferred ${deferred.length} items for lazy retrieval`);
  }

  return {
    included,
    deferred,
    dropped,
    totalTokens: included.reduce((sum, item) => sum + item.tokens, 0),
    reasons,
  };
}
