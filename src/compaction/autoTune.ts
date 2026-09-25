/**
 * Per-model compaction tuning, without touching the user's settings files.
 *
 * Pi's compaction defaults — reserveTokens 16384, keepRecentTokens 20000 —
 * are sized for ~128k windows. Pi compacts when the context exceeds
 * `window − reserveTokens`, caps the summary at 0.8 × reserveTokens (a turn
 * prefix at 0.5 ×) and keeps `keepRecentTokens` of recent history verbatim.
 * On the gateway's 262k-window models, which think by default, that meant
 * compaction started at 245k tokens with a 13k summary budget, and near-full
 * turns had no output room left.
 *
 * Pi (0.87) resolves these per model (`compaction.modelOverrides`), but only
 * from its settings files, and gives extensions no settings API. So this
 * module applies a tuned value through the two seams extensions DO have:
 *
 * - B, the trigger: on the `turn_end` boundary — after each turn's assistant
 *   message and tool results are persisted, before the next provider call, so
 *   also between turns of a long tool run — if the context is past
 *   `window − tunedReserve`, build the tuned compaction (as in A) and return it
 *   as a `compaction` entry draft. Pi commits it inside its own turn pipeline
 *   (`appendCompaction` + context refresh): no `ctx.compact()` (which would
 *   abort the run and race follow-ups other `agent_settled` handlers queue),
 *   no separate "manual" compaction. It is recorded as an extension-supplied
 *   compaction; while the summary is generated the status line says so, and
 *   Esc aborts it through the turn's abort signal like any provider call.
 *   Debounced: after triggering it re-arms once the context is seen back below
 *   the threshold, after any successful compaction, or — if ours failed —
 *   after a few more turns, so a compaction that fails or does not shrink the
 *   context cannot loop, and one failure does not disable it for the session.
 * - A, the content: on `session_before_compact` (every compaction — ours, Pi's
 *   threshold/overflow ones, and a manual /compact), re-run Pi's own
 *   `prepareCompaction` with the tuned keepRecent/reserve and return Pi's own
 *   `compact()` result, summarized through the session's model registry — the
 *   composed provider, so the gateway wrapper and the thinking-off policy
 *   apply. Any failure falls back to Pi's default compaction (never cancels).
 *
 *   `prepareCompaction` is not exported from the package entry (0.87.1) and
 *   depends on unexported projection helpers, so it is loaded from Pi's own
 *   compaction module rather than reimplemented. Where that module cannot be
 *   resolved (e.g. a bundled Pi), A degrades to the public API only: Pi's own
 *   `event.preparation` (Pi's cut point) with the tuned summary budget.
 *
 * A value the user set — globally, per project, or per model — always wins for
 * that field; it is detected read-only through Pi's own SettingsManager.
 */

import { pathToFileURL } from "node:url";
import { type CompactionResult, SettingsManager, VERSION, compact, getAgentDir } from "@earendil-works/pi-coding-agent";
import { emitTelemetry } from "../telemetry/sink.ts";

export const PI_DEFAULT_RESERVE_TOKENS = 16_384;
export const PI_DEFAULT_KEEP_RECENT_TOKENS = 20_000;
/** Pi version whose `agent_settled` event and per-model compaction resolution this relies on. */
export const MIN_PI_VERSION = "0.87.1";

export interface CompactionModel {
  provider?: string;
  id?: string;
  contextWindow?: number;
  maxTokens?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The tuned values for a model, or undefined without a context window.
 *
 * reserveTokens = clamp(max(min(maxTokens, 32768), round(window × 0.125)), 16384, 65536)
 * - The output-allowance term keeps a full answer's worth of room (up to 32k)
 *   free when compaction triggers, and makes the summary cap 0.8 × reserve
 *   (~26k at 32k) — enough for a structured summary even if a model thinks.
 * - The window term (12.5%) triggers at 87.5% full on big windows rather than
 *   at a fixed 16k from the end.
 * - Floor 16384 (Pi's default, never less headroom than stock Pi); cap 65536
 *   so a 1M window does not compact ~130k early.
 *
 * keepRecentTokens = clamp(round(window × 0.15), 20000, 80000)
 * - ~15% of the window kept verbatim after compaction; never less than Pi's
 *   default, and bounded so the post-compaction context stays small.
 */
export function tunedCompactionTokens(
  model: CompactionModel,
): { reserveTokens: number; keepRecentTokens: number } | undefined {
  const window = model.contextWindow;
  if (!window || window <= 0) return undefined;
  const windowTerm = Math.round(window * 0.125);
  const allowanceTerm = model.maxTokens && model.maxTokens > 0 ? Math.min(model.maxTokens, 32_768) : 0;
  return {
    reserveTokens: clamp(Math.max(allowanceTerm, windowTerm), 16_384, 65_536),
    keepRecentTokens: clamp(Math.round(window * 0.15), 20_000, 80_000),
  };
}

/** Compaction values the user set explicitly (absent = not set). */
export interface UserCompactionValues {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

type RawCompaction = {
  enabled?: unknown;
  reserveTokens?: unknown;
  keepRecentTokens?: unknown;
  modelOverrides?: Record<string, { reserveTokens?: unknown; keepRecentTokens?: unknown } | undefined>;
};

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The user's own compaction values for `model`, read-only, with Pi's
 * precedence: a per-model override (project over global), then the ordinary
 * value (project over global). Pi's SettingsManager does the loading, so an
 * untrusted project's settings are ignored exactly as Pi ignores them. Nothing
 * is ever written.
 */
export function readUserCompactionValues(opts: {
  cwd: string;
  agentDir?: string;
  projectTrusted: boolean;
  model: CompactionModel;
}): UserCompactionValues {
  let global: RawCompaction = {};
  let project: RawCompaction = {};
  try {
    const manager = SettingsManager.create(opts.cwd, opts.agentDir ?? getAgentDir(), {
      projectTrusted: opts.projectTrusted,
    });
    global = (manager.getGlobalSettings() as { compaction?: RawCompaction }).compaction ?? {};
    project = opts.projectTrusted
      ? ((manager.getProjectSettings() as { compaction?: RawCompaction }).compaction ?? {})
      : {};
  } catch {
    return {};
  }
  const key = opts.model.provider && opts.model.id ? `${opts.model.provider}/${opts.model.id}` : undefined;
  const field = (name: "reserveTokens" | "keepRecentTokens"): number | undefined =>
    (key
      ? (nonNegativeInt(project.modelOverrides?.[key]?.[name]) ?? nonNegativeInt(global.modelOverrides?.[key]?.[name]))
      : undefined) ??
    nonNegativeInt(project[name]) ??
    nonNegativeInt(global[name]);
  const enabled =
    typeof project.enabled === "boolean"
      ? project.enabled
      : typeof global.enabled === "boolean"
        ? global.enabled
        : undefined;
  const reserveTokens = field("reserveTokens");
  const keepRecentTokens = field("keepRecentTokens");
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(reserveTokens !== undefined ? { reserveTokens } : {}),
    ...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}),
  };
}

export type ValueSource = "user" | "tuned" | "default";

export interface EffectiveCompaction {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  reserveSource: ValueSource;
  keepSource: ValueSource;
  /** One line, for the status notice. */
  reason: string;
}

export function effectiveCompaction(model: CompactionModel, user: UserCompactionValues): EffectiveCompaction {
  const tuned = tunedCompactionTokens(model);
  const pick = (
    userValue: number | undefined,
    tunedValue: number | undefined,
    fallback: number,
  ): [number, ValueSource] =>
    userValue !== undefined
      ? [userValue, "user"]
      : tunedValue !== undefined
        ? [tunedValue, "tuned"]
        : [fallback, "default"];
  const [reserveTokens, reserveSource] = pick(user.reserveTokens, tuned?.reserveTokens, PI_DEFAULT_RESERVE_TOKENS);
  const [keepRecentTokens, keepSource] = pick(
    user.keepRecentTokens,
    tuned?.keepRecentTokens,
    PI_DEFAULT_KEEP_RECENT_TOKENS,
  );
  const window = model.contextWindow ?? 0;
  const reason =
    window > 0
      ? `window ${window}, maxTokens ${model.maxTokens ?? "unknown"}: compact past ${window - reserveTokens} tokens (reserve ${reserveTokens}, ${reserveSource}), keep ${keepRecentTokens} recent (${keepSource})`
      : "no context window known: Pi's defaults";
  return { enabled: user.enabled ?? true, reserveTokens, keepRecentTokens, reserveSource, keepSource, reason };
}

/**
 * Debounced trigger decision. Compact when the context is past
 * `window − reserve` and the trigger is armed; disarm on triggering; re-arm
 * only when the context is seen back at or below the threshold. An unknown
 * size (right after a compaction) changes nothing.
 */
export function shouldAutoCompact(
  state: { armed: boolean },
  tokens: number | null | undefined,
  window: number,
  reserve: number,
): { compact: boolean; armed: boolean } {
  if (tokens === null || tokens === undefined || window <= 0) return { compact: false, armed: state.armed };
  if (tokens <= window - reserve) return { compact: false, armed: true };
  return state.armed ? { compact: true, armed: false } : { compact: false, armed: false };
}

function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) =>
    v
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(version), parse(minimum)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

// ─── Pi's prepareCompaction ────────────────────────────────────────────────

/** Pi's `prepareCompaction(pathEntries, settings)`. */
export type PrepareCompaction = (
  entries: unknown[],
  settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
) => PreparationLike | undefined;

export interface PreparationLike {
  firstKeptEntryId: string;
  settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  [key: string]: unknown;
}

let prepareLoad: Promise<PrepareCompaction | undefined> | undefined;

/** Where `@earendil-works/pi-coding-agent`'s entry lives, as the running loader sees it. */
function piEntryUrl(): string | undefined {
  // Pi loads extensions through jiti with an alias map; jiti's injected
  // `require` honours those aliases, while `import.meta.resolve` inside jiti's
  // wrapper is Node's own and fails (ERR_UNSUPPORTED_RESOLVE_REQUEST). So
  // require.resolve first, import.meta.resolve for plain ESM (tests, workers).
  try {
    if (typeof require === "function") return pathToFileURL(require.resolve("@earendil-works/pi-coding-agent")).href;
  } catch {
    // Fall through to ESM resolution.
  }
  try {
    const resolveSpecifier = (import.meta as { resolve?: (specifier: string) => string }).resolve;
    return typeof resolveSpecifier === "function" ? resolveSpecifier("@earendil-works/pi-coding-agent") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load Pi's own prepareCompaction from its compaction module (next to the
 * package entry). Undefined when it cannot be resolved; never throws.
 */
export function loadPiPrepareCompaction(): Promise<PrepareCompaction | undefined> {
  prepareLoad ??= (async () => {
    try {
      const entry = piEntryUrl();
      if (!entry) return undefined;
      const mod = (await import(new URL("./core/compaction/compaction.js", entry).href)) as {
        prepareCompaction?: unknown;
      };
      return typeof mod.prepareCompaction === "function" ? (mod.prepareCompaction as PrepareCompaction) : undefined;
    } catch {
      return undefined;
    }
  })();
  return prepareLoad;
}

// ─── Extension wiring ──────────────────────────────────────────────────────

/** The too-old-Pi notice is shown once per process, however often extensions reload. */
let unsupportedNoticed = false;

/** The slice of Pi's ExtensionContext used here. */
export interface AutoCompactionContext {
  cwd: string;
  model: (CompactionModel & Record<string, unknown>) | undefined;
  thinkingLevel?: unknown;
  signal?: AbortSignal;
  modelRegistry: { streamSimple(model: never, context: never, options?: never): unknown };
  sessionManager: { getBranch(): unknown[] };
  ui?: { setStatus?(key: string, text: string | undefined): void };
  isProjectTrusted(): boolean;
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
}

interface BeforeCompactEvent {
  preparation: PreparationLike;
  branchEntries: unknown[];
  customInstructions?: string;
  signal: AbortSignal;
}

interface TurnEndBoundaryEvent {
  entries: unknown[];
}

/** The slice of Pi's ExtensionAPI used here. */
export interface AutoCompactionHost {
  on(event: string, handler: (event: never, ctx: never) => unknown): void;
}

export interface AutoCompactionOptions {
  /** Pi's version; default the running pi-coding-agent's VERSION. */
  piVersion?: string;
  /** Agent dir holding the global settings; default Pi's getAgentDir(). */
  agentDir?: string;
  /** Turn the whole feature off (PI_AUTO_COMPACTION=0). */
  enabled?: boolean;
  /** Source of Pi's prepareCompaction; default loadPiPrepareCompaction. */
  loadPrepare?: () => Promise<PrepareCompaction | undefined>;
}

/** Turns after a failed tuned compaction before the trigger re-arms. */
export const REARM_AFTER_FAILED_TURNS = 3;
const STATUS_KEY = "pi-engineering:compaction";

/**
 * Register B (turn_end trigger) and A (session_before_compact content) on a Pi
 * extension host. Returns false when the running Pi is too old — then nothing
 * is registered, and a one-time notice says why.
 */
export function registerAutoCompaction(pi: AutoCompactionHost, options: AutoCompactionOptions = {}): boolean {
  if (options.enabled === false) return false;
  const piVersion = options.piVersion ?? VERSION;
  if (!versionAtLeast(piVersion, MIN_PI_VERSION)) {
    if (unsupportedNoticed) return false;
    unsupportedNoticed = true;
    emitTelemetry({
      level: "info",
      key: "compaction-autotune:unsupported",
      text: `Per-model compaction tuning needs Pi ${MIN_PI_VERSION} or newer (running ${piVersion}); Pi's own compaction settings apply unchanged.`,
    });
    return false;
  }

  const announced = new Set<string>();
  /** Effective values per (cwd, model); settings files are re-read after a model or session change. */
  const resolved = new Map<string, EffectiveCompaction>();
  let state = { armed: true };
  let turnsSinceFailure: number | undefined;

  const resolve = (ctx: AutoCompactionContext): EffectiveCompaction | undefined => {
    const model = ctx.model;
    if (!model) return undefined;
    const key = `${model.provider}/${model.id}`;
    const cacheKey = `${ctx.cwd}|${key}`;
    let effective = resolved.get(cacheKey);
    if (!effective) {
      effective = effectiveCompaction(
        model,
        readUserCompactionValues({
          cwd: ctx.cwd,
          ...(options.agentDir ? { agentDir: options.agentDir } : {}),
          projectTrusted: ctx.isProjectTrusted(),
          model,
        }),
      );
      resolved.set(cacheKey, effective);
    }
    if (!announced.has(key) && (effective.reserveSource === "tuned" || effective.keepSource === "tuned")) {
      announced.add(key);
      emitTelemetry({
        level: "info",
        key: `compaction-autotune:${key}`,
        text: `Compaction tuned for ${key}: ${effective.reason}.`,
      });
    }
    return effective;
  };

  /**
   * Pi's own compaction, cut and budgeted with the tuned values, summarized
   * through the session's registry (composed provider: gateway wrapper,
   * thinking-off, body budget; Pi resolves auth). Undefined when there is
   * nothing to summarize at the tuned cut; throws on failure.
   */
  const tunedCompaction = async (
    ctx: AutoCompactionContext,
    effective: EffectiveCompaction,
    branchEntries: unknown[],
    fallbackPreparation: PreparationLike | undefined,
    customInstructions: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CompactionResult | undefined> => {
    const model = ctx.model;
    if (!model) return undefined;
    const settings = {
      enabled: true,
      reserveTokens: effective.reserveTokens,
      keepRecentTokens: effective.keepRecentTokens,
    };
    const prepare = await (options.loadPrepare ?? loadPiPrepareCompaction)();
    let preparation: PreparationLike | undefined;
    if (prepare) {
      preparation = prepare(branchEntries, settings);
    } else {
      if (!announced.has("prepare-unavailable")) {
        announced.add("prepare-unavailable");
        emitTelemetry({
          level: "info",
          key: "compaction-autotune:prepare-unavailable",
          text: "Pi's prepareCompaction could not be loaded: compaction keeps Pi's own cut point and uses the tuned summary budget only.",
        });
      }
      preparation = fallbackPreparation
        ? {
            ...fallbackPreparation,
            settings: { ...fallbackPreparation.settings, reserveTokens: settings.reserveTokens },
          }
        : undefined;
    }
    if (!preparation) return undefined;
    const streamFn = ((m: never, c: never, o?: never) => ctx.modelRegistry.streamSimple(m, c, o)) as never;
    return compact(
      preparation as never,
      model as never,
      undefined,
      undefined,
      customInstructions,
      signal,
      ctx.thinkingLevel as never,
      streamFn,
    );
  };

  const onModelChange = (_event: unknown, ctx: AutoCompactionContext) => {
    // A new model (or session) means new values and a new threshold.
    resolved.clear();
    state = { armed: true };
    turnsSinceFailure = undefined;
    resolve(ctx);
  };
  pi.on("session_start", onModelChange as never);
  pi.on("model_select", onModelChange as never);
  // Any successful compaction (ours or Pi's) is a fresh start for the trigger.
  pi.on("session_compact", (() => {
    state = { armed: true };
    turnsSinceFailure = undefined;
  }) as never);

  // B: at each turn boundary, past the tuned threshold, supply the compaction.
  pi.on("turn_end", (async (event: TurnEndBoundaryEvent, ctx: AutoCompactionContext) => {
    const effective = resolve(ctx);
    if (!effective?.enabled || effective.reserveSource === "default") return undefined;
    if (turnsSinceFailure !== undefined && !state.armed) {
      turnsSinceFailure++;
      if (turnsSinceFailure >= REARM_AFTER_FAILED_TURNS) {
        state = { armed: true };
        turnsSinceFailure = undefined;
      }
    }
    const usage = ctx.getContextUsage();
    if (!usage) return undefined;
    const decision = shouldAutoCompact(state, usage.tokens, usage.contextWindow, effective.reserveTokens);
    state = { armed: decision.armed };
    if (!decision.compact) return undefined;

    ctx.ui?.setStatus?.(STATUS_KEY, "Compacting context (tuned for this model)…");
    try {
      const result = await tunedCompaction(
        ctx,
        effective,
        ctx.sessionManager.getBranch(),
        undefined,
        undefined,
        ctx.signal,
      );
      if (!result) {
        turnsSinceFailure = 0;
        return undefined;
      }
      turnsSinceFailure = undefined;
      const draft = {
        type: "compaction",
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        ...(result.details !== undefined ? { details: result.details } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      };
      // Boundary results REPLACE the accumulated drafts: keep other handlers'.
      return { entries: [...(event.entries ?? []), draft] };
    } catch (error) {
      turnsSinceFailure = 0;
      emitTelemetry({
        level: "warning",
        key: "compaction-autotune:failed",
        text: `Tuned compaction did not complete (${error instanceof Error ? error.message : String(error)}); Pi's own compaction still applies at its threshold.`,
      });
      return undefined;
    } finally {
      ctx.ui?.setStatus?.(STATUS_KEY, undefined);
    }
  }) as never);

  // A: every Pi compaction (threshold, overflow, manual /compact) honours the
  // tuned keepRecent and summary budget. On failure Pi's default compaction
  // runs; after a late failure (e.g. a summary timeout) that means a second,
  // from-scratch summary while the user waits — kept, because giving up would
  // leave an overflowing context uncompacted.
  pi.on("session_before_compact", (async (event: BeforeCompactEvent, ctx: AutoCompactionContext) => {
    const effective = resolve(ctx);
    if (!effective || !ctx.model) return undefined;
    if (effective.reserveSource !== "tuned" && effective.keepSource !== "tuned") return undefined;
    try {
      const compaction = await tunedCompaction(
        ctx,
        effective,
        event.branchEntries,
        event.preparation,
        event.customInstructions,
        event.signal,
      );
      return compaction ? { compaction } : undefined;
    } catch (error) {
      if (event.signal.aborted) throw error;
      emitTelemetry({
        level: "warning",
        key: "compaction-autotune:fallback",
        text: `Tuned compaction failed (${error instanceof Error ? error.message : String(error)}); Pi's default compaction runs instead.`,
      });
      return undefined;
    }
  }) as never);
  return true;
}
