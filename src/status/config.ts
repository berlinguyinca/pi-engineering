/**
 * Live status-bar configuration.
 *
 * Follows the harness's existing configuration convention (env-var driven with
 * safe defaults, mirroring the Generation Guard `PI_GUARD_*` and OpenViking
 * `PI_OPENVIKING_*` config). The footer is enabled by default; set
 * `PI_STATUS_BAR_ENABLED=0` to disable it entirely.
 */

export interface StatusBarConfig {
  enabled: boolean;

  showDirectory: boolean;
  showRepository: boolean;
  showWorktree: boolean;
  showBranch: boolean;
  showModel: boolean;
  showThroughput: boolean;

  /** Rolling throughput window in ms (spec default 2500). */
  throughputWindowMs: number;
  /** Max TUI redraw rate in ms while streaming (spec ~4-8 Hz => 125-250ms). */
  refreshMs: number;
  /** How long a cached Git context is trusted before a background re-resolve. */
  gitCacheTtlMs: number;
  /** Minimum chars of streamed delta buffered before a fallback estimate sample. */
  estimateBatchChars: number;
  /** Characters per token used by the lightweight fallback estimate. */
  estimateCharsPerToken: number;
}

export const DEFAULT_STATUS_BAR_CONFIG: StatusBarConfig = {
  enabled: true,
  showDirectory: true,
  showRepository: true,
  showWorktree: true,
  showBranch: true,
  showModel: true,
  showThroughput: true,
  throughputWindowMs: 2500,
  refreshMs: 150,
  gitCacheTtlMs: 30_000,
  estimateBatchChars: 32,
  estimateCharsPerToken: 4,
};

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function int(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

const ENV = {
  enabled: "PI_STATUS_BAR_ENABLED",
  directory: "PI_STATUS_BAR_SHOW_DIRECTORY",
  repository: "PI_STATUS_BAR_SHOW_REPOSITORY",
  worktree: "PI_STATUS_BAR_SHOW_WORKTREE",
  branch: "PI_STATUS_BAR_SHOW_BRANCH",
  model: "PI_STATUS_BAR_SHOW_MODEL",
  throughput: "PI_STATUS_BAR_SHOW_THROUGHPUT",
  windowMs: "PI_STATUS_BAR_WINDOW_MS",
  refreshMs: "PI_STATUS_BAR_REFRESH_MS",
  gitTtlMs: "PI_STATUS_BAR_GIT_TTL_MS",
} as const;

/** Resolve status-bar config from environment, falling back to defaults. */
export function resolveStatusBarConfig(env: Record<string, string | undefined> = process.env): StatusBarConfig {
  const base = DEFAULT_STATUS_BAR_CONFIG;
  return {
    enabled: bool(env[ENV.enabled], base.enabled),
    showDirectory: bool(env[ENV.directory], base.showDirectory),
    showRepository: bool(env[ENV.repository], base.showRepository),
    showWorktree: bool(env[ENV.worktree], base.showWorktree),
    showBranch: bool(env[ENV.branch], base.showBranch),
    showModel: bool(env[ENV.model], base.showModel),
    showThroughput: bool(env[ENV.throughput], base.showThroughput),
    throughputWindowMs: int(env[ENV.windowMs], base.throughputWindowMs),
    refreshMs: int(env[ENV.refreshMs], base.refreshMs),
    gitCacheTtlMs: int(env[ENV.gitTtlMs], base.gitCacheTtlMs),
    estimateBatchChars: base.estimateBatchChars,
    estimateCharsPerToken: base.estimateCharsPerToken,
  };
}
