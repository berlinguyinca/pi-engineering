/**
 * Reconciling a configured model list with what the gateway actually serves.
 *
 * Model configuration drifts silently and expensively. Measured against a live
 * gateway, a real `models.json` had one model configured at 1,048,576 tokens
 * that the gateway caps at 262,144, another at 131,072 that actually accepts
 * 250,112, and a model missing entirely. An over-stated context window is the
 * damaging direction: Pi fills the context believing it fits, the request
 * fails, and Pi's usage percentage is wrong so compaction fires far too late.
 *
 * The rules here are about not losing information the gateway does not have.
 * `/models` reports an id and a size; it says nothing about output limits,
 * pricing, reasoning support or input modalities, all of which are already
 * configured and must survive a refresh untouched. So this merges, and reports
 * exactly what it changed.
 */

import type { GatewayModelEntry } from "./gatewayCatalog.ts";

/**
 * A model as `models.json` holds it. Unknown keys are preserved on purpose:
 * this tool must not silently drop configuration a newer Pi understands.
 */
export interface ConfiguredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: unknown;
  [key: string]: unknown;
}

export type CatalogChangeKind = "add" | "update" | "unchanged" | "missing";

export interface CatalogChange {
  kind: CatalogChangeKind;
  id: string;
  /** Human-readable specifics, e.g. "contextWindow 1048576 → 262144". */
  details: string[];
  /** Fields this tool guessed rather than read. Always surfaced to the operator. */
  inferred?: string[];
}

export interface CatalogPlan {
  /** The model list to write. */
  next: ConfiguredModel[];
  changes: CatalogChange[];
  /** True when `next` differs from the existing list. */
  dirty: boolean;
}

export interface PlanOptions {
  /**
   * Drop configured models the gateway no longer lists. Off by default: a model
   * absent from one poll may be temporarily unloaded rather than retired, and
   * deleting an operator's configuration on that basis is not recoverable from
   * the tool's own output.
   */
  pruneMissing?: boolean;
  /** Output limit for models being added. Falls back to a sibling's value. */
  defaultMaxTokens?: number;
}

const FALLBACK_MAX_TOKENS = 32_768;

/** Most common `maxTokens` among configured models, so additions match siblings. */
function siblingMaxTokens(existing: readonly ConfiguredModel[]): number | undefined {
  const counts = new Map<number, number>();
  for (const m of existing) {
    if (typeof m.maxTokens === "number" && m.maxTokens > 0) {
      counts.set(m.maxTokens, (counts.get(m.maxTokens) ?? 0) + 1);
    }
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Most common `reasoning` flag among configured models. */
function siblingReasoning(existing: readonly ConfiguredModel[]): boolean {
  const yes = existing.filter((m) => m.reasoning === true).length;
  return yes * 2 >= existing.length && existing.length > 0;
}

/**
 * Guess input modalities from the model id.
 *
 * `/models` does not report modality, and getting this wrong in either
 * direction is costly: claiming image support a model lacks makes every image
 * request fail, and omitting it makes a usable vision model unusable. So the
 * guess is deliberately narrow — an explicit `vision`/`-vl` marker in the id —
 * and is always reported as inferred so the operator can correct it.
 */
function inferInput(id: string): { input: string[]; inferred: boolean } {
  return /(^|[-_.])(vision|vl)([-_.]|$)/i.test(id)
    ? { input: ["text", "image"], inferred: true }
    : { input: ["text"], inferred: false };
}

/**
 * Build the updated model list.
 *
 * Existing entries are spread forward, so every field the gateway does not know
 * about — `maxTokens`, `cost`, `compat`, custom names — survives untouched.
 */
export function planCatalogUpdate(
  existing: readonly ConfiguredModel[],
  gateway: readonly GatewayModelEntry[],
  opts: PlanOptions = {},
): CatalogPlan {
  const byId = new Map(existing.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const changes: CatalogChange[] = [];
  const next: ConfiguredModel[] = [];
  const addMaxTokens = opts.defaultMaxTokens ?? siblingMaxTokens(existing) ?? FALLBACK_MAX_TOKENS;
  const addReasoning = siblingReasoning(existing);

  for (const entry of gateway) {
    seen.add(entry.id);
    const current = byId.get(entry.id);

    if (!current) {
      const { input, inferred } = inferInput(entry.id);
      const inferredFields = ["maxTokens", "reasoning", ...(inferred ? ["input"] : [])];
      next.push({
        id: entry.id,
        name: `${entry.id} (gateway)`,
        reasoning: addReasoning,
        input,
        contextWindow: entry.contextWindow,
        // Never promise more output than the model can hold in total.
        maxTokens: Math.min(addMaxTokens, entry.contextWindow),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      changes.push({
        kind: "add",
        id: entry.id,
        details: [`context ${entry.contextWindow}`, ...(entry.state ? [`state ${entry.state}`] : [])],
        inferred: inferredFields,
      });
      continue;
    }

    const details: string[] = [];
    const merged: ConfiguredModel = { ...current };
    if (current.contextWindow !== entry.contextWindow) {
      details.push(`contextWindow ${current.contextWindow ?? "unset"} → ${entry.contextWindow}`);
      merged.contextWindow = entry.contextWindow;
    }
    // An output limit larger than the whole context is unsatisfiable; clamp it
    // when the window shrinks underneath it.
    if (typeof merged.maxTokens === "number" && merged.maxTokens > entry.contextWindow) {
      details.push(`maxTokens ${merged.maxTokens} → ${entry.contextWindow} (clamped to the window)`);
      merged.maxTokens = entry.contextWindow;
    }
    next.push(merged);
    changes.push({ kind: details.length > 0 ? "update" : "unchanged", id: entry.id, details });
  }

  for (const model of existing) {
    if (seen.has(model.id)) continue;
    changes.push({
      kind: "missing",
      id: model.id,
      details: opts.pruneMissing
        ? ["removed — the gateway no longer lists it"]
        : ["the gateway no longer lists it; kept"],
    });
    if (!opts.pruneMissing) next.push(model);
  }

  const dirty = changes.some(
    (c) => c.kind === "add" || c.kind === "update" || (c.kind === "missing" && opts.pruneMissing),
  );
  return { next, changes, dirty };
}

/** Render a plan as lines for the command output. */
export function describeCatalogPlan(plan: CatalogPlan): string[] {
  const lines: string[] = [];
  const order: CatalogChangeKind[] = ["update", "add", "missing", "unchanged"];
  const label: Record<CatalogChangeKind, string> = {
    update: "changed",
    add: "added",
    missing: "not on the gateway",
    unchanged: "already correct",
  };
  for (const kind of order) {
    const rows = plan.changes.filter((c) => c.kind === kind);
    if (rows.length === 0) continue;
    lines.push(`${label[kind]} (${rows.length}):`);
    for (const row of rows) {
      const detail = row.details.length > 0 ? ` — ${row.details.join(", ")}` : "";
      const guessed = row.inferred?.length ? ` [inferred: ${row.inferred.join(", ")}]` : "";
      lines.push(`  ${row.id}${detail}${guessed}`);
    }
  }
  if (!plan.dirty) lines.push("Configuration already matches the gateway.");
  return lines;
}
