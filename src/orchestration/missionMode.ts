/**
 * Execution mode and backend selection (R-MODE).
 *
 * `local` is stand-alone Pi and the only mode reachable with every flag unset.
 * `autospec` and `mission` are optional adapters (AGENTS.md "Scope"): they are
 * reachable only through `PI_AUTOSPEC_ENABLED`, and the managed backend only
 * through `PI_AUTOSPEC_MANAGED_ENABLED` on top of that. Classification is
 * deterministic; there is no model call here.
 *
 * Flags are read from an env record the caller passes in, never from
 * `process.env`, so the choice is a pure function and testable.
 */

export type ExecutionMode = "local" | "autospec" | "mission";
export type ExecutionBackendChoice = "pi-local" | "autospec-managed";

export interface AutospecFlags {
  /** `PI_AUTOSPEC_ENABLED`: master switch for the autospec and mission modes. */
  enabled: boolean;
  /** `PI_AUTOSPEC_MANAGED_ENABLED`: allows the managed (`autospec-managed`) backend. */
  managedEnabled: boolean;
  /** `PI_AUTOSPEC_AUTO_CLASSIFY`: allows the router to propose `autospec` unprompted. */
  autoClassify: boolean;
}

export type FlagEnv = Readonly<Record<string, string | undefined>>;

function flagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Read the three default-off flags. Only `1` and `true` (any case) turn one on. */
export function readAutospecFlags(env: FlagEnv): AutospecFlags {
  return {
    enabled: flagOn(env.PI_AUTOSPEC_ENABLED),
    managedEnabled: flagOn(env.PI_AUTOSPEC_MANAGED_ENABLED),
    autoClassify: flagOn(env.PI_AUTOSPEC_AUTO_CLASSIFY),
  };
}

/** Signals that a request is a multi-step delivery job rather than a single edit. */
const DELIVERY_SIGNALS: readonly RegExp[] = [
  /\bend[- ]to[- ]end\b/i,
  /\bacross (the |all )?(services?|repos?|repositories|packages|modules)\b/i,
  /\b(open|raise|create|file) (a |the )?(pr|pull request)\b/i,
  /\bmerge (it|this|the (pr|pull request))\b/i,
  /\bautonomous(ly)?\b/i,
  /\b(whole|entire|full) (feature|backlog|roadmap|epic)\b/i,
  /\b(all|every) (the )?(open )?issues?\b/i,
];

/** Deterministic proposal: does this request look like autonomous delivery work? */
function looksLikeAutospecWork(text: string): boolean {
  if (/\bautospec\b/i.test(text)) return true;
  return DELIVERY_SIGNALS.filter((p) => p.test(text)).length >= 2;
}

/**
 * Choose the execution mode.
 *
 * - Without `PI_AUTOSPEC_ENABLED` the answer is always `local`, whatever was
 *   requested and whatever the other two flags say.
 * - An explicit `requested` mode wins when enabled.
 * - Otherwise `autospec` is proposed only when `PI_AUTOSPEC_AUTO_CLASSIFY` is on
 *   and the request looks like delivery work. Auto classification never
 *   proposes `mission`.
 */
export function chooseMode(text: string, flags: AutospecFlags, requested?: ExecutionMode): ExecutionMode {
  if (!flags.enabled) return "local";
  if (requested) return requested;
  if (flags.autoClassify && looksLikeAutospecWork(text)) return "autospec";
  return "local";
}

/**
 * Choose the backend for a mode. The managed backend needs `autospec` mode AND
 * `PI_AUTOSPEC_MANAGED_ENABLED`; an explicit `pi-local` request always wins, and
 * an explicit managed request that the flags do not allow falls back to `pi-local`.
 */
export function chooseBackend(
  mode: ExecutionMode,
  flags: AutospecFlags,
  requested?: ExecutionBackendChoice,
): ExecutionBackendChoice {
  if (mode !== "autospec" || !flags.enabled || !flags.managedEnabled) return "pi-local";
  return requested ?? "autospec-managed";
}
