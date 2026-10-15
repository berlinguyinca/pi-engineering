/**
 * `/mission` leading flags (R-MODE): `--mode`, `--backend`, `--budget`,
 * `--max-workers`.
 *
 * Pure parsing: nothing here reads the environment or starts anything. The
 * caller passes the autospec flags, so `--mode autospec|mission` and
 * `--backend autospec-managed` are refused unless the feature flags allow them,
 * instead of being silently downgraded. Only LEADING flags are consumed; dashes
 * inside the request text are left alone, and the `resume`, `cancel` and `why`
 * subcommands are not flag-prefixed so they never reach this parser's options.
 */

import type { AutospecFlags, ExecutionBackendChoice, ExecutionMode } from "./missionMode.ts";

export const MISSION_FLAGS_USAGE =
  "/mission [--mode local|autospec|mission] [--backend pi-local|autospec-managed] [--budget <size>] [--max-workers <n>] <normal-language request> | /mission resume <missionId> | /mission cancel <missionId>";

export interface MissionFlagLimits {
  /** Largest `--max-workers` accepted; larger values are capped and a warning is returned. */
  maxWorkersCap?: number;
}

export interface MissionFlagsResult {
  mode?: ExecutionMode;
  backend?: ExecutionBackendChoice;
  /** Disk budget for the mission in bytes (the protocol Budget unit). */
  budgetBytes?: number;
  maxWorkers?: number;
  /** The request with the leading flags removed. */
  rest: string;
  error?: string;
  /** Non-fatal notes, such as a capped `--max-workers`. */
  warnings: string[];
}

/** Matches the gateway's default concurrency (`PI_GATEWAY_MAX_CONCURRENCY`); callers pass the configured one. */
export const DEFAULT_MAX_WORKERS_CAP = 4;

const MODES: readonly ExecutionMode[] = ["local", "autospec", "mission"];
const BACKENDS: readonly ExecutionBackendChoice[] = ["pi-local", "autospec-managed"];
const UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};
const FLAG = /^--([A-Za-z][A-Za-z-]*)(?:=(\S*)|\s+(\S+))?(?:\s+|$)/;

/** `100GiB`, `512MiB`, `4096` (bytes). Binary units only; anything else is rejected. */
function parseBudgetBytes(raw: string): number | undefined {
  const m = /^(\d+)\s*([A-Za-z]*)$/.exec(raw);
  if (!m) return undefined;
  const unit = (m[2] ?? "").toLowerCase();
  const scale = unit === "" ? 1 : UNITS[unit];
  if (scale === undefined) return undefined;
  const bytes = Number(m[1]) * scale;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

export function parseMissionFlags(
  text: string,
  flags: AutospecFlags,
  limits: MissionFlagLimits = {},
): MissionFlagsResult {
  const fail = (error: string): MissionFlagsResult => ({ rest: text, error, warnings: [] });
  const cap = Math.max(1, limits.maxWorkersCap ?? DEFAULT_MAX_WORKERS_CAP);
  const warnings: string[] = [];
  const seen = new Set<string>();
  let mode: ExecutionMode | undefined;
  let backend: ExecutionBackendChoice | undefined;
  let budgetBytes: number | undefined;
  let maxWorkers: number | undefined;
  let rest = text.trimStart();
  let consumed = false;

  while (rest.startsWith("--")) {
    const m = FLAG.exec(rest);
    if (!m) return fail(`malformed option near "${rest.slice(0, 20)}"`);
    const name = (m[1] ?? "").toLowerCase();
    // `--flag=value` carries its value in group 2 (possibly empty); `--flag value` in group 3.
    const value = m[2] !== undefined ? m[2] : m[3];
    if (!["mode", "backend", "budget", "max-workers"].includes(name)) return fail(`unknown option --${name}`);
    if (seen.has(name)) return fail(`--${name} given more than once`);
    seen.add(name);
    if (value === undefined || value === "") return fail(`--${name} needs a value`);
    rest = rest.slice(m[0].length);
    consumed = true;

    if (name === "mode") {
      if (!MODES.includes(value as ExecutionMode)) return fail(`--mode must be one of ${MODES.join(", ")}`);
      mode = value as ExecutionMode;
      if (mode !== "local" && !flags.enabled) {
        return fail(`--mode ${mode} needs PI_AUTOSPEC_ENABLED to be on (it is off by default)`);
      }
    } else if (name === "backend") {
      if (!BACKENDS.includes(value as ExecutionBackendChoice)) {
        return fail(`--backend must be one of ${BACKENDS.join(", ")}`);
      }
      backend = value as ExecutionBackendChoice;
      if (backend === "autospec-managed" && !flags.managedEnabled) {
        return fail("--backend autospec-managed needs PI_AUTOSPEC_MANAGED_ENABLED to be on (it is off by default)");
      }
    } else if (name === "budget") {
      budgetBytes = parseBudgetBytes(value);
      if (budgetBytes === undefined) {
        return fail("--budget must be a positive size such as 100GiB, 512MiB or a byte count");
      }
    } else {
      if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
        return fail("--max-workers must be a positive integer");
      }
      const requested = Number(value);
      maxWorkers = Math.min(requested, cap);
      if (requested > cap) warnings.push(`--max-workers ${requested} capped at ${cap}`);
    }
    rest = rest.trimStart();
  }

  if (!consumed) return { rest: text, warnings };
  if (rest.trim() === "") return fail("a request is required after the options");
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(backend !== undefined ? { backend } : {}),
    ...(budgetBytes !== undefined ? { budgetBytes } : {}),
    ...(maxWorkers !== undefined ? { maxWorkers } : {}),
    rest: rest.trim(),
    warnings,
  };
}
