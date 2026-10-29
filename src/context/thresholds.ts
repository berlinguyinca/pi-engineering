/**
 * The ONE context-pressure threshold triple (spec: continuity protocol, "proposed" defaults).
 *
 *   soft       0.70  a safe point (phase boundary) hands off instead of letting context grow
 *   preferred  0.80  a running agent is asked to checkpoint and hand off at its next safe point
 *   emergency  0.90  checkpoint and hand off immediately, no safe point required
 *
 * Adjustable per runtime and per model from the GLOBAL engineering.yaml (no environment variables):
 *
 *   context_thresholds:
 *     preferred: 0.82                       # any of soft/preferred/emergency; the rest keep the default
 *     runtimes:
 *       llama.cpp: { soft: 0.6, preferred: 0.7, emergency: 0.85 }
 *     models:                               # exact id, or a glob with `*`; exact beats glob, model beats runtime
 *       "glm-*": { emergency: 0.95 }
 *
 * Every layer is merged onto the layer below and the MERGED triple must satisfy 0 < soft < preferred < emergency <= 1,
 * otherwise that layer is ignored with a note (never partly applied).
 *
 * Not a trigger: workers/contextBudget.ts CONTEXT_WINDOW_SHARE is the share of a window a worker may PLAN to use.
 * Context pressure and provider quota are distinct causes; see HandoffCause in runtime/host/handoffKinds.ts.
 *
 * Pure except `loadContextThresholdConfig`, which only reads the YAML.
 */

import { join } from "node:path";
import { readYaml } from "../lifecycle/policy.ts";

export interface ContextThresholds {
  soft: number;
  preferred: number;
  emergency: number;
}

export const DEFAULT_CONTEXT_THRESHOLDS: Readonly<ContextThresholds> = Object.freeze({
  soft: 0.7,
  preferred: 0.8,
  emergency: 0.9,
});

/** Warn-before threshold used by the status bar: the preferred level. */
export const CONTEXT_PRESSURE_RATIO = DEFAULT_CONTEXT_THRESHOLDS.preferred;

export type ContextLevel = "ok" | "soft" | "preferred" | "emergency";
const RANK: Record<ContextLevel, number> = { ok: 0, soft: 1, preferred: 2, emergency: 3 };

export function validateThresholds(
  value: unknown,
): { ok: true; value: ContextThresholds } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "thresholds must be a mapping" };
  const v = value as Record<string, unknown>;
  const { soft, preferred, emergency } = v;
  if (typeof soft !== "number" || typeof preferred !== "number" || typeof emergency !== "number") {
    return { ok: false, error: "soft, preferred and emergency must be numbers" };
  }
  if (![soft, preferred, emergency].every(Number.isFinite)) return { ok: false, error: "thresholds must be finite" };
  if (!(soft > 0 && soft < preferred && preferred < emergency && emergency <= 1)) {
    return { ok: false, error: "need 0 < soft < preferred < emergency <= 1" };
  }
  return { ok: true, value: { soft, preferred, emergency } };
}

/** Level for a utilization ratio. Unknown (null/NaN) is `ok`: no signal, no control effect. */
export function contextLevel(
  utilization: number | null | undefined,
  thresholds: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS,
): ContextLevel {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return "ok";
  if (utilization >= thresholds.emergency) return "emergency";
  if (utilization >= thresholds.preferred) return "preferred";
  if (utilization >= thresholds.soft) return "soft";
  return "ok";
}

type Partial3 = Partial<ContextThresholds>;
export interface ContextThresholdConfig {
  defaults: Partial3;
  runtimes: Record<string, Partial3>;
  models: Array<{ pattern: string; exact: boolean; re: RegExp; thresholds: Partial3 }>;
}

export const EMPTY_CONTEXT_THRESHOLD_CONFIG: ContextThresholdConfig = { defaults: {}, runtimes: {}, models: [] };

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const KEYS = ["soft", "preferred", "emergency"] as const;

function pick(layer: unknown): Partial3 {
  const out: Partial3 = {};
  if (!isPlain(layer)) return out;
  for (const k of KEYS) if (layer[k] !== undefined) (out as Record<string, unknown>)[k] = layer[k];
  return out;
}

/** Parse the `context_thresholds:` block. Invalid layers are dropped with a note. */
export function parseContextThresholdConfig(raw: unknown): { config: ContextThresholdConfig; notes: string[] } {
  const notes: string[] = [];
  if (raw === undefined || raw === null) return { config: EMPTY_CONTEXT_THRESHOLD_CONFIG, notes };
  if (!isPlain(raw)) return { config: EMPTY_CONTEXT_THRESHOLD_CONFIG, notes: ["context_thresholds must be a mapping"] };
  const check = (label: string, base: ContextThresholds, layer: Partial3): Partial3 | null => {
    const merged = validateThresholds({ ...base, ...layer });
    if (!merged.ok) {
      notes.push(`context_thresholds ${label} ignored: ${merged.error}`);
      return null;
    }
    return layer;
  };
  const config: ContextThresholdConfig = { defaults: {}, runtimes: {}, models: [] };
  config.defaults = check("defaults", DEFAULT_CONTEXT_THRESHOLDS, pick(raw)) ?? {};
  const baseDefaults = { ...DEFAULT_CONTEXT_THRESHOLDS, ...config.defaults };
  if (isPlain(raw.runtimes)) {
    for (const [name, layer] of Object.entries(raw.runtimes)) {
      const ok = check(`runtime ${name}`, baseDefaults, pick(layer));
      if (ok) config.runtimes[name] = ok;
    }
  }
  if (isPlain(raw.models)) {
    for (const [pattern, layer] of Object.entries(raw.models)) {
      const ok = check(`model ${pattern}`, baseDefaults, pick(layer));
      if (ok) config.models.push({ pattern, exact: !pattern.includes("*"), re: globRegExp(pattern), thresholds: ok });
    }
  }
  return { config, notes };
}

function globRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`);
}

/**
 * Effective triple: defaults < configured defaults < runtime < matching model globs < exact model.
 * The merged result is validated again (a model layer can break the invariant against a runtime layer); when it does,
 * the layer that broke it is skipped.
 */
export function resolveContextThresholds(
  config: ContextThresholdConfig,
  target: { model?: string | null; runtime?: string | null },
): ContextThresholds {
  let current: ContextThresholds = { ...DEFAULT_CONTEXT_THRESHOLDS, ...config.defaults };
  const apply = (layer: Partial3 | undefined): void => {
    if (!layer) return;
    const merged = validateThresholds({ ...current, ...layer });
    if (merged.ok) current = merged.value;
  };
  if (target.runtime) apply(config.runtimes[target.runtime]);
  if (target.model) {
    const model = target.model;
    for (const m of config.models) if (!m.exact && m.re.test(model)) apply(m.thresholds);
    for (const m of config.models) if (m.exact && m.pattern === model) apply(m.thresholds);
  }
  return current;
}

/** Read the block from `<agentDir>/engineering.yaml`. Never throws: unreadable = defaults plus a note. */
export async function loadContextThresholdConfig(
  agentDir: string,
): Promise<{ config: ContextThresholdConfig; notes: string[] }> {
  try {
    const { raw } = await readYaml(join(agentDir, "engineering.yaml"));
    return parseContextThresholdConfig(isPlain(raw) ? raw.context_thresholds : undefined);
  } catch (err) {
    return {
      config: EMPTY_CONTEXT_THRESHOLD_CONFIG,
      notes: [`context_thresholds: engineering.yaml unreadable (${(err as Error).message})`],
    };
  }
}

/** Highest level already actioned for one execution. */
export interface CrossingState {
  fired: ContextLevel;
}

export type CrossingAction = "preferred" | "emergency" | null;

/**
 * Idempotent crossing detector. Feed it every observation; it returns an action only on a real crossing:
 * `emergency` immediately (once), `preferred` only at a safe point (once). Dropping below `soft` (compaction, a
 * successor session) re-arms it; hovering between soft and preferred does not. Repeated polls at the same level never re-fire.
 */
export function evaluateCrossing(
  state: CrossingState,
  level: ContextLevel,
  atSafePoint: boolean,
): { state: CrossingState; action: CrossingAction } {
  // Re-arm only once the session is clearly below the action levels (`ok`); hovering around `preferred` (usage can
  // fluctuate between turns) must not produce a handoff per oscillation.
  if (level === "ok") return { state: { fired: "ok" }, action: null };
  if (RANK[level] < RANK.preferred) return { state, action: null };
  if (level === "emergency" && state.fired !== "emergency")
    return { state: { fired: "emergency" }, action: "emergency" };
  if (level === "preferred" && atSafePoint && RANK[state.fired] < RANK.preferred) {
    return { state: { fired: "preferred" }, action: "preferred" };
  }
  return { state, action: null };
}
