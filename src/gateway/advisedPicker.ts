/**
 * The interactive model picker behind an advised switch.
 *
 * When the gateway advises another model (`IW-ACT-RETRY-ALTERNATE`) and no
 * automatic stand-in fits, the operator chooses instead of the turn ending
 * with "switch with /model". Every model is listed — a model that does not fit
 * the session is MARKED with the reason, not hidden — so the operator can make
 * the call the chooser is not allowed to (e.g. compact first, or accept losing
 * a modality).
 *
 * Pure and session-free: building the options and interpreting the answer touch
 * nothing on the session. The caller owns `ctx.ui.select` and `pi.setModel`.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelHealthProvider } from "../models/health.ts";
import { DEFAULT_HEADROOM_TOKENS, isHealthy, requiredWindow } from "./fallback.ts";
import { toCandidate } from "./fallbackLifecycle.ts";

/**
 * How long the picker waits for an answer. We measure this in seconds: the
 * picker appears at the first refusal, so an unattended session must not sit
 * in a dialog. A timeout is NOT Cancel and NOT an explicit "Keep waiting": the
 * owed wait is taken once on the current model and the turn continues, but the
 * picker stays available, so the next refusal prompts again (bounded by
 * MAX_PICKER_TIMEOUTS in advisedSwitch.ts).
 */
export const PICKER_TIMEOUT_MS = 45_000;
const DEFAULT_WAIT_MS = 20_000;

export type PickerChoice =
  | { kind: "model"; model: Model<any> }
  | { kind: "keep-waiting"; delayMs: number }
  | { kind: "cancel" };

export interface PickerEntry {
  /** The exact string handed to `ui.select`; unique within one picker. */
  label: string;
  choice: PickerChoice;
}

export type PickerOutcome =
  | { kind: "picked"; model: Model<any> }
  | { kind: "keep-waiting"; delayMs: number }
  | { kind: "cancelled"; reason: "cancel" | "dismissed" | "timeout" | "aborted" | "error" };

export interface PickerInput {
  /** The model that refused. Never offered; its input types are the modalities a stand-in should keep. */
  source: Model<any> | undefined;
  available: readonly Model<any>[];
  /**
   * Models this outage episode already left. The coordinator records ids only
   * (`PendingFallback.excludeIds`), so an id matches only models on the
   * SOURCE's provider — the provider a switch-away leaves from; a same-id model
   * on another provider is not hidden. Known limitation until the coordinator
   * records providers.
   */
  excludeIds?: readonly string[] | undefined;
  /** Context tokens in use; unknown (null/undefined) marks nothing, since nothing can be shown to not fit. */
  usedTokens: number | null | undefined;
  health?: Pick<ModelHealthProvider, "get"> | undefined;
  /** The wait offered by "Keep waiting"; a missing or non-positive value is the default. */
  waitMs?: number | undefined;
  /** Offer "Keep waiting" at all (needs a wait seam to be honoured). */
  allowKeepWaiting?: boolean | undefined;
}

function compactTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  // Round first: 999_600 is "1.0M", never "1000k".
  const k = Math.round(n / 1_000);
  return k >= 1_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${k}k`;
}

function warnings(m: Model<any>, input: PickerInput, health: PickerInput["health"]): string[] {
  const out: string[] = [];
  const candidate = toCandidate(m, health as ModelHealthProvider | undefined);
  if (input.usedTokens != null) {
    const need = requiredWindow(input.usedTokens, candidate, DEFAULT_HEADROOM_TOKENS);
    if (candidate.contextWindow < need) {
      out.push(`⚠ context ${compactTokens(candidate.contextWindow)} < ${compactTokens(need)} needed`);
    }
  }
  const missing = (input.source?.input ?? []).filter((kind) => !(m.input ?? ["text"]).includes(kind));
  if (missing.length > 0) out.push(`⚠ no ${missing.join("/")} input`);
  if (!isHealthy(candidate)) {
    out.push(candidate.slots !== undefined && candidate.slots <= 0 ? "⚠ no free slots" : "⚠ cold");
  }
  return out;
}

function healthText(m: Model<any>, health: PickerInput["health"]): string | undefined {
  const reading = health?.get(m.id) ?? {};
  const parts = [reading.state, reading.slots !== undefined ? `${reading.slots} slots` : undefined];
  const text = parts.filter((p): p is string => p !== undefined).join(", ");
  return text || undefined;
}

function describe(m: Model<any>, label: string, input: PickerInput): { text: string; marked: boolean } {
  const warn = warnings(m, input, input.health);
  const parts = [
    label,
    `ctx ${compactTokens(m.contextWindow)}`,
    (m.input ?? ["text"]).join("+"),
    healthText(m, input.health),
    ...warn,
  ].filter((p): p is string => p !== undefined);
  // A model whose health reading is only informational ("warm") is not marked.
  return { text: parts.join(" · "), marked: warn.length > 0 };
}

/**
 * The picker's rows: fitting, healthy models first, then the marked ones (each
 * group by id), then "Keep waiting" and "Cancel". The failed model and the
 * excluded ones are the only models left out.
 */
export function buildPickerEntries(input: PickerInput): PickerEntry[] {
  const excluded = new Set(input.excludeIds ?? []);
  const sourceId = input.source?.id;
  const sourceProvider = input.source?.provider;
  const isSource = (m: Model<any>) => m.id === sourceId && m.provider === sourceProvider;
  const isExcluded = (m: Model<any>) =>
    excluded.has(m.id) && (sourceProvider === undefined || m.provider === sourceProvider);
  const candidates = input.available.filter((m) => !isSource(m) && !isExcluded(m));
  const idCounts = new Map<string, number>();
  for (const m of candidates) idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);
  const rows = candidates.map((model) => {
    const label = (idCounts.get(model.id) ?? 0) > 1 ? `${model.provider}/${model.id}` : model.id;
    const { text, marked } = describe(model, label, input);
    return { model, text, marked };
  });
  rows.sort((a, b) => Number(a.marked) - Number(b.marked) || a.model.id.localeCompare(b.model.id));
  const entries: PickerEntry[] = rows.map((r) => ({ label: r.text, choice: { kind: "model", model: r.model } }));
  const delayMs = input.waitMs !== undefined && input.waitMs > 0 ? input.waitMs : DEFAULT_WAIT_MS;
  if (input.allowKeepWaiting !== false) {
    entries.push({
      label: `Keep waiting on ${sourceId ?? "the current model"} (retry in ${Math.round(delayMs / 1000)}s)`,
      choice: { kind: "keep-waiting", delayMs },
    });
  }
  entries.push({ label: "Cancel (end the turn)", choice: { kind: "cancel" } });
  return entries;
}

export type SelectFn = (
  title: string,
  options: string[],
  opts?: { signal?: AbortSignal; timeout?: number },
) => Promise<string | undefined>;

export interface RunPickerOptions {
  title: string;
  timeoutMs?: number;
  /** Aborts the dialog and counts as no answer. */
  signal?: AbortSignal;
}

/**
 * Show the picker and interpret the answer. Never rejects and never waits
 * past `timeoutMs`: no answer of any kind (timeout, dismissal, abort, a UI
 * that throws, an unknown label) is "cancelled", which the caller treats as
 * the turn ending exactly as it did before the picker existed.
 */
export async function runModelPicker(
  select: SelectFn,
  entries: readonly PickerEntry[],
  opts: RunPickerOptions,
): Promise<PickerOutcome> {
  if (opts.signal?.aborted) return { kind: "cancelled", reason: "aborted" };
  const timeoutMs = opts.timeoutMs ?? PICKER_TIMEOUT_MS;
  const dialog = new AbortController();
  const labels = uniqueLabels(entries);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const gone = new Promise<PickerOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "cancelled", reason: "timeout" }), timeoutMs);
    onAbort = () => {
      dialog.abort(); // close the dialog now, not when the race has settled
      resolve({ kind: "cancelled", reason: "aborted" });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  const answer = select(opts.title, labels, { signal: dialog.signal, timeout: timeoutMs }).then(
    (label): PickerOutcome => {
      // By position in the (unique) labels, so no row can shadow another.
      const chosen = label === undefined ? undefined : entries[labels.indexOf(label)]?.choice;
      if (!chosen) return { kind: "cancelled", reason: "dismissed" };
      if (chosen.kind === "model") return { kind: "picked", model: chosen.model };
      if (chosen.kind === "keep-waiting") return { kind: "keep-waiting", delayMs: chosen.delayMs };
      return { kind: "cancelled", reason: "cancel" };
    },
    (): PickerOutcome => ({ kind: "cancelled", reason: "error" }),
  );
  try {
    return await Promise.race([answer, gone]);
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    dialog.abort();
  }
}

/** The rows' labels, with a " (n)" suffix on repeats so every one is distinct. */
function uniqueLabels(entries: readonly PickerEntry[]): string[] {
  const seen = new Set<string>();
  return entries.map((e) => {
    let label = e.label;
    for (let n = 2; seen.has(label); n++) label = `${e.label} (${n})`;
    seen.add(label);
    return label;
  });
}
