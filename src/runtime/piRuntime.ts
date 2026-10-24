/**
 * Pi runtime selection: which Pi executable runs an agent.
 *
 * This is NOT `AgentRuntime` (legacy | herdr), which chooses the orchestration
 * backend. This chooses the Pi *binary*: standard Pi (the default), Pi-Bolt, or
 * Pi-Bolt's JIT build. It is consulted once, by the managed launcher
 * (scripts/pi-session-auto-resume.ts), before the agent starts.
 *
 *   pi_runtime:
 *     default: standard-pi              # standard-pi | pi-bolt | pi-bolt-jit
 *     roles:    { reviewer: pi-bolt }   # worker-role override
 *     missions: { <mission-id>: pi-bolt-jit }
 *     canary:   { runtime: pi-bolt, percent: 10 }   # deterministic per agent id
 *     binaries:
 *       pi-bolt: { path: /abs/pi, version: 1.0.0 }  # `verifyRuntimeBinary` writes the stamp
 *
 * Precedence, most specific first: role > mission > canary > default.
 * Layers (global < workspace) are merged by `loadPolicy`.
 *
 * Safety contract:
 *  - Standard Pi is the default and the only fallback.
 *  - Every refusal (unsupported host, missing/changed binary, bad config) is
 *    decided HERE, before the agent starts, and is reported as a reason.
 *  - Once an agent has started, nothing in this module can re-run it: a started
 *    agent is never replayed on a different runtime (tools may not be idempotent).
 */

import { createHash } from "node:crypto";
import { constants, accessSync, createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PI_RUNTIMES = ["standard-pi", "pi-bolt", "pi-bolt-jit"] as const;
export type PiRuntimeName = (typeof PI_RUNTIMES)[number];

export interface RuntimeBinary {
  path: string;
  version?: string;
}

export interface PiRuntimeConfig {
  default: PiRuntimeName;
  roles: Record<string, PiRuntimeName>;
  missions: Record<string, PiRuntimeName>;
  canary: { runtime: PiRuntimeName; percent: number } | null;
  binaries: Partial<Record<PiRuntimeName, RuntimeBinary>>;
  issues: string[];
}

export interface RuntimeContext {
  role?: string;
  missionId?: string;
  /** Stable id (e.g. the pane id) used to place an agent in or out of the canary. */
  agentId?: string;
}

export type SelectionSource = "role" | "mission" | "canary" | "default" | "fallback";

export interface RuntimeSelection {
  /** What the config asked for. */
  requested: PiRuntimeName;
  /** What will run. */
  runtime: PiRuntimeName;
  source: SelectionSource;
  /** Executable for a non-standard runtime; null for standard Pi. */
  binary: string | null;
  /** Why `runtime` differs from `requested`, if it does. */
  fallbackReason: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asRuntime(v: unknown, path: string, issues: string[]): PiRuntimeName | undefined {
  if (v === undefined) return undefined;
  if ((PI_RUNTIMES as readonly unknown[]).includes(v)) return v as PiRuntimeName;
  issues.push(`${path} must be one of ${PI_RUNTIMES.join("|")}; ignoring`);
  return undefined;
}

function runtimeMap(raw: unknown, path: string, issues: string[]): Record<string, PiRuntimeName> {
  const out: Record<string, PiRuntimeName> = {};
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    issues.push(`${path} must be a mapping; ignoring`);
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    const r = asRuntime(v, `${path}.${k}`, issues);
    if (r) out[k] = r;
  }
  return out;
}

/** Validate a raw `pi_runtime` section. Invalid fields are dropped with an issue; the result is always usable. */
export function parsePiRuntimeConfig(raw: unknown): PiRuntimeConfig {
  const issues: string[] = [];
  const r = isRecord(raw) ? raw : {};
  if (raw !== undefined && !isRecord(raw)) issues.push("pi_runtime must be a mapping; using standard-pi");
  const binaries: PiRuntimeConfig["binaries"] = {};
  if (isRecord(r.binaries)) {
    for (const [name, b] of Object.entries(r.binaries)) {
      if (!(PI_RUNTIMES as readonly string[]).includes(name) || name === "standard-pi") {
        issues.push(`pi_runtime.binaries.${name} is not a configurable runtime; ignoring`);
        continue;
      }
      if (!isRecord(b) || typeof b.path !== "string" || !b.path.startsWith("/")) {
        issues.push(`pi_runtime.binaries.${name}.path must be an absolute path; ignoring`);
        continue;
      }
      binaries[name as PiRuntimeName] = {
        path: b.path,
        ...(typeof b.version === "string" ? { version: b.version } : {}),
      };
    }
  }
  let canary: PiRuntimeConfig["canary"] = null;
  if (r.canary !== undefined) {
    const c = isRecord(r.canary) ? r.canary : {};
    const rt = asRuntime(c.runtime, "pi_runtime.canary.runtime", issues);
    const pct = c.percent;
    if (rt && typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      canary = { runtime: rt, percent: pct };
    } else {
      issues.push("pi_runtime.canary needs runtime and percent 0..100; ignoring");
    }
  }
  return {
    default: asRuntime(r.default, "pi_runtime.default", issues) ?? "standard-pi",
    roles: runtimeMap(r.roles, "pi_runtime.roles", issues),
    missions: runtimeMap(r.missions, "pi_runtime.missions", issues),
    canary,
    binaries,
    issues,
  };
}

/** Deterministic 0..99 bucket for an agent id (same id, same bucket, every start). */
export function canaryBucket(agentId: string): number {
  return createHash("sha256").update(agentId).digest().readUInt32BE(0) % 100;
}

/** The runtime the configuration asks for, before any host or binary check. */
export function requestedRuntime(
  config: PiRuntimeConfig,
  ctx: RuntimeContext,
): { runtime: PiRuntimeName; source: Exclude<SelectionSource, "fallback"> } {
  if (ctx.role && config.roles[ctx.role]) return { runtime: config.roles[ctx.role] as PiRuntimeName, source: "role" };
  if (ctx.missionId && config.missions[ctx.missionId]) {
    return { runtime: config.missions[ctx.missionId] as PiRuntimeName, source: "mission" };
  }
  if (config.canary && ctx.agentId && canaryBucket(ctx.agentId) < config.canary.percent) {
    return { runtime: config.canary.runtime, source: "canary" };
  }
  return { runtime: config.default, source: "default" };
}

export interface HostFacts {
  platform: NodeJS.Platform;
  arch: string;
  /** Linux only: "glibc" | "musl" | "unknown". */
  libc: string;
  /** x64 only. */
  avx2: boolean;
}

export function detectHost(): HostFacts {
  const libc = process.platform !== "linux" ? "n/a" : detectLibc();
  let avx2 = false;
  if (process.platform === "linux" && process.arch === "x64") {
    try {
      avx2 = /\bavx2\b/.test(readFileSync("/proc/cpuinfo", "utf8"));
    } catch {
      avx2 = false;
    }
  }
  return { platform: process.platform, arch: process.arch, libc, avx2 };
}

function detectLibc(): string {
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    if (report?.header?.glibcVersionRuntime) return "glibc";
  } catch {
    // fall through
  }
  return "unknown";
}

/**
 * Why Pi-Bolt cannot run on this host, or null. Mirrors Pi-Bolt's published support
 * (README, 2026-10-23): Linux x64 (AVX2 build) / arm64 on glibc, macOS on Apple silicon.
 * Anything else stays on standard Pi.
 */
export function unsupportedHostReason(host: HostFacts): string | null {
  if (host.platform === "darwin")
    return host.arch === "arm64" ? null : `macOS ${host.arch} is not supported (Apple silicon only)`;
  if (host.platform === "linux") {
    if (host.libc === "musl") return "musl libc is not supported";
    if (host.arch === "arm64") return null;
    if (host.arch === "x64") return host.avx2 ? null : "x64 CPU lacks AVX2 (only the baseline build would run)";
    return `linux ${host.arch} is not supported`;
  }
  return `${host.platform} is not supported by the pinned Pi-Bolt build`;
}

/** Cheap identity of a file: changes if it is replaced or rewritten. */
export function fingerprint(path: string): string {
  const s = statSync(path);
  return `${s.size}:${Math.trunc(s.mtimeMs)}:${s.ino}`;
}

export interface VerifyStamp {
  sha256: string;
  fingerprint: string;
  version?: string;
  verifiedAt: string;
}

export function stampPath(binaryPath: string): string {
  return join(dirname(binaryPath), ".pi-runtime-verified.json");
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/**
 * Hash the binary and compare with `expectedSha256`; on a match write a stamp beside
 * it. Run this at install time. Launch only compares the stamp's fingerprint, because
 * a 260 MB hash on every agent start is not free.
 */
export async function verifyRuntimeBinary(
  binaryPath: string,
  expectedSha256: string,
  version?: string,
): Promise<VerifyStamp> {
  const actual = await sha256File(binaryPath);
  if (actual !== expectedSha256.toLowerCase()) throw new Error(`sha256 mismatch for ${binaryPath}: got ${actual}`);
  const stamp: VerifyStamp = {
    sha256: actual,
    fingerprint: fingerprint(binaryPath),
    ...(version ? { version } : {}),
    verifiedAt: new Date().toISOString(),
  };
  writeFileSync(stampPath(binaryPath), `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o644 });
  return stamp;
}

/** Why this binary must not be used, or null. */
export function binaryRefusal(binaryPath: string, expectVersion?: string): string | null {
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    return `binary missing or not executable: ${binaryPath}`;
  }
  let stamp: VerifyStamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath(binaryPath), "utf8")) as VerifyStamp;
  } catch {
    return `binary has no verification stamp (run the verify step): ${binaryPath}`;
  }
  try {
    if (stamp.fingerprint !== fingerprint(binaryPath)) return "binary changed since it was verified";
  } catch {
    return "binary cannot be inspected";
  }
  if (expectVersion && stamp.version !== expectVersion) {
    return `verified version ${stamp.version ?? "unknown"} differs from pinned ${expectVersion}`;
  }
  return null;
}

/**
 * Decide, before the agent starts, which Pi runs. Never throws: any problem becomes
 * a standard-Pi selection with a reason.
 */
export function selectPiRuntime(
  config: PiRuntimeConfig,
  ctx: RuntimeContext,
  host: HostFacts = detectHost(),
): RuntimeSelection {
  const { runtime: requested, source } = requestedRuntime(config, ctx);
  if (requested === "standard-pi") return { requested, runtime: requested, source, binary: null, fallbackReason: null };
  const fallback = (reason: string): RuntimeSelection => ({
    requested,
    runtime: "standard-pi",
    source: "fallback",
    binary: null,
    fallbackReason: reason,
  });
  const hostReason = unsupportedHostReason(host);
  if (hostReason) return fallback(hostReason);
  const entry = config.binaries[requested];
  if (!entry) return fallback(`no pi_runtime.binaries.${requested} configured`);
  const refusal = binaryRefusal(entry.path, entry.version);
  if (refusal) return fallback(refusal);
  return { requested, runtime: requested, source, binary: entry.path, fallbackReason: null };
}

export interface LaunchDecision extends RuntimeSelection {
  context: RuntimeContext;
  configIssues: string[];
}

/** Worker identity as exported to a launched agent. Optional: an interactive `pi` has none. */
export function contextFromEnv(env: NodeJS.ProcessEnv): RuntimeContext {
  const pick = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
  const role = pick(env.PI_ENGINEERING_ROLE);
  const missionId = pick(env.PI_ENGINEERING_MISSION_ID);
  const agentId = pick(env.HERDR_PANE_ID);
  return { ...(role ? { role } : {}), ...(missionId ? { missionId } : {}), ...(agentId ? { agentId } : {}) };
}

/**
 * `pi_runtime` merged across layers, later paths overriding earlier ones key by key
 * (global < workspace, the same order `loadPolicy` uses). Deliberately not `loadPolicy`:
 * the launcher is a copied file set, and that import pulls the whole policy graph into it.
 * Only `yaml` is needed; where Pi does not bundle it this throws and the caller falls back.
 */
async function loadRuntimeSection(paths: string[]): Promise<unknown> {
  const { parse } = await import("yaml");
  let merged: Record<string, unknown> | undefined;
  for (const p of paths) {
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const section = (parse(text) as Record<string, unknown> | null)?.pi_runtime;
    if (section === undefined) continue;
    if (!isRecord(section)) return section; // reported as invalid by the parser
    merged = mergeSection(merged ?? {}, section);
  }
  return merged;
}

function mergeSection(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    const prev = out[k];
    out[k] = isRecord(prev) && isRecord(v) ? mergeSection(prev, v) : v;
  }
  return out;
}

function mentionsPiRuntime(paths: string[]): boolean {
  return paths.some((p) => {
    try {
      return readFileSync(p, "utf8").includes("pi_runtime");
    } catch {
      return false;
    }
  });
}

/**
 * Launch-time decision for the managed launcher. Returns null when no layer of
 * engineering.yaml mentions `pi_runtime` (the common case costs two file reads) and never
 * throws: a broken config yields standard Pi plus the reason.
 */
export async function decideLaunchRuntime(
  cwd: string,
  agentDir: string,
  env: NodeJS.ProcessEnv,
  host: HostFacts = detectHost(),
): Promise<LaunchDecision | null> {
  const context = contextFromEnv(env);
  try {
    if (!mentionsPiRuntime([join(agentDir, "engineering.yaml"), join(cwd, ".pi", "engineering.yaml")])) return null;
    const section = await loadRuntimeSection([
      join(agentDir, "engineering.yaml"),
      join(cwd, ".pi", "engineering.yaml"),
    ]);
    const config = parsePiRuntimeConfig(section);
    return { ...selectPiRuntime(config, context, host), context, configIssues: config.issues };
  } catch (error) {
    return {
      requested: "standard-pi",
      runtime: "standard-pi",
      source: "fallback",
      binary: null,
      fallbackReason: `runtime selection failed: ${error instanceof Error ? error.message : String(error)}`,
      context,
      configIssues: [],
    };
  }
}

/** The slice of `process` that `runtimeFacts` reads (fakeable in tests). */
export interface ProcessLike {
  versions: { node?: string; bun?: string };
  cpuUsage(): { user: number; system: number };
  memoryUsage(): { rss: number };
}

export interface RuntimeFacts {
  runtime_kind: PiRuntimeName;
  runtime_source: string;
  /** "bun" under Pi-Bolt, else "node". */
  js_engine: "bun" | "node";
  js_engine_version: string;
  cpu_s: number;
  rss_mib: number;
  /** Why the requested runtime was not used (launcher fell back to standard Pi), if it was. */
  fallback_reason?: string;
}

/**
 * What the running agent is, for the runtime event log / dashboard. The launcher tags a
 * non-standard child with PI_RUNTIME_KIND / PI_RUNTIME_SOURCE; anything else is standard Pi.
 * Runtime metrics only: inference (tokens, latency, queue) stays in the inference metrics.
 */
export function runtimeFacts(env: NodeJS.ProcessEnv = process.env, proc: ProcessLike = process): RuntimeFacts {
  const kind = (PI_RUNTIMES as readonly string[]).includes(env.PI_RUNTIME_KIND ?? "")
    ? (env.PI_RUNTIME_KIND as PiRuntimeName)
    : "standard-pi";
  const bun = proc.versions.bun;
  const cpu = proc.cpuUsage();
  return {
    runtime_kind: kind,
    runtime_source: kind === "standard-pi" ? "default" : (env.PI_RUNTIME_SOURCE ?? "unknown"),
    js_engine: bun ? "bun" : "node",
    js_engine_version: bun ?? proc.versions.node ?? "unknown",
    cpu_s: Math.round(((cpu.user + cpu.system) / 1e6) * 1000) / 1000,
    rss_mib: Math.round((proc.memoryUsage().rss / 1048576) * 10) / 10,
    ...(env.PI_RUNTIME_FALLBACK_REASON ? { fallback_reason: env.PI_RUNTIME_FALLBACK_REASON.slice(0, 200) } : {}),
  };
}
