/**
 * `memory.hindsight` configuration: schema, defaults and validation.
 *
 * Configuration is YAML only (global `engineering.yaml` under the agent dir,
 * then the repository's `.pi/engineering.yaml`); there are no environment
 * variables. Pure module: it must not import `lifecycle/policy.ts`, which
 * embeds these defaults in `DEFAULT_POLICY`.
 *
 * The herdr-memory CLI owns every credential. Nothing secret belongs here.
 */

export interface HindsightSettings {
  /** Opt-in. Memory is off unless this is true. */
  enabled: boolean;
  /** Executable to shell out to (global config only; a repository cannot choose it). */
  cli: string;
  /** Scopes recalled and written: `project`, `global`, `infra`, `mission:<id>`. */
  scopes: string[];
  /** Per-call CLI timeout in ms. */
  timeout_ms: number;
  /** Harness name the CLI records as provenance and uses to pick its credential. */
  harness: string;
  /** Pause automatic requests this long after a timeout or bad exit (ms). */
  failure_backoff_ms: number;
  /** Pause automatic requests this long after a missing CLI or refused write (ms). */
  unavailable_backoff_ms: number;
}

export interface HindsightSettingsIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export const HINDSIGHT_SCOPE_RE = /^(project|global|infra|mission:[a-z0-9][a-z0-9_-]{0,63})$/;
export const HINDSIGHT_HARNESS_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export const DEFAULT_HINDSIGHT_SETTINGS: HindsightSettings = {
  enabled: false,
  cli: "herdr-memory",
  scopes: ["project"],
  timeout_ms: 5000,
  harness: "pi",
  failure_backoff_ms: 60_000,
  unavailable_backoff_ms: 300_000,
};

export const HINDSIGHT_RANGES = {
  timeout_ms: [100, 60_000],
  failure_backoff_ms: [1_000, 3_600_000],
  unavailable_backoff_ms: [1_000, 86_400_000],
} as const satisfies Record<string, readonly [number, number]>;

const BASE = "memory.hindsight";

export function validateHindsightSettings(raw: unknown): HindsightSettingsIssue[] {
  const issues: HindsightSettingsIssue[] = [];
  const err = (key: string, message: string) => issues.push({ path: `${BASE}.${key}`, message, severity: "error" });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [{ path: BASE, message: "expected a mapping of settings", severity: "error" }];
  }
  const s = raw as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!(key in DEFAULT_HINDSIGHT_SETTINGS)) {
      issues.push({ path: `${BASE}.${key}`, message: "unknown key (ignored)", severity: "warning" });
    }
  }
  if (typeof s.enabled !== "boolean") err("enabled", "expected true or false");
  if (typeof s.cli !== "string" || !s.cli.trim() || s.cli.length > 512 || /[\0\r\n]/.test(s.cli)) {
    err("cli", "expected a non-empty executable name or path (max 512 characters, one line)");
  }
  if (
    !Array.isArray(s.scopes) ||
    s.scopes.length === 0 ||
    !s.scopes.every((x) => typeof x === "string" && HINDSIGHT_SCOPE_RE.test(x))
  ) {
    err("scopes", "expected a non-empty list drawn from project, global, infra, mission:<id>");
  }
  if (typeof s.harness !== "string" || !HINDSIGHT_HARNESS_RE.test(s.harness)) {
    err("harness", "expected a lowercase name (letters, digits, - or _; max 32 characters)");
  }
  for (const [key, [min, max]] of Object.entries(HINDSIGHT_RANGES)) {
    const v = s[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      err(key, `expected a number between ${min} and ${max}`);
    }
  }
  return issues;
}
