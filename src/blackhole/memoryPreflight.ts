/**
 * Memory provisioning preflight (issue #673, ask 3).
 *
 * Surfaces the per-check provisioning state of durable memory as one line per
 * check, so a never-provisioned or misconfigured host is visible from
 * `/engineering version` instead of only failing silently at recall time.
 *
 * The checks themselves — binary present + version matches the pinned revision,
 * managed config valid, credential files 0600 in a 0700 parent, server
 * reachable — are owned and enforced by `herdr-eng memory doctor`, which already
 * prints exactly this list. This module shells out to it (`--json`) and renders
 * its output; it deliberately does NOT re-implement the checks, which belong to
 * the herdr-engineering package that owns the pin and the credential layout.
 *
 * Every failure path is fail-closed: a missing `herdr-eng`, a timeout, a
 * non-zero exit or unreadable output all resolve to an `available: false`
 * result with a reason, never a throw. A preflight failure must never propagate
 * out of session start or the version command.
 */
import { execFile } from "node:child_process";

/** One provisioning check as reported by `herdr-eng memory doctor`. */
export interface MemoryPreflightCheck {
  name: string;
  /** Normalised to one of these; any unknown doctor status maps to "fail". */
  status: "ok" | "unknown" | "fail";
  detail: string;
}

/** The outcome of a preflight run. `available:false` means doctor could not be consulted. */
export type MemoryPreflightResult =
  | { available: true; ok: boolean; overall: string; checks: MemoryPreflightCheck[] }
  | { available: false; code: "not-installed" | "timeout" | "error"; reason: string };

/** Injectable subprocess runner; resolves with a captured exit code rather than throwing on non-zero. */
export type PreflightRunner = (args: string[], timeoutMs: number) => Promise<{ stdout: string; exitCode: number }>;

/** The doctor binary. Lives in the herdr-engineering venv, symlinked onto PATH as `herdr-eng`. */
export const DOCTOR_CLI = "herdr-eng";

/**
 * Doctor contacts the live memory service (its `server` check), so the budget
 * covers a cold python start plus one network round trip. Measured 2026-11-18
 * on beast: `herdr-eng memory doctor` wall clock 1.35 s. 8 s is headroom over
 * that, kept well under a session-start or command deadline; on expiry the run
 * resolves `timeout`, never hangs the caller.
 */
export const DOCTOR_TIMEOUT_MS = 8_000;

/** Doctor's `--harness` only accepts these four names; any other configured harness is passed as `--all`. */
const DOCTOR_HARNESSES = new Set(["pi", "claude", "codex", "opencode"]);

export const defaultPreflightRunner: PreflightRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      DOCTOR_CLI,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env } },
      (error, stdout) => {
        if (!error) return resolve({ stdout, exitCode: 0 });
        const code = (error as { code?: unknown }).code;
        // A non-zero exit still carries doctor's JSON on stdout; keep it.
        if (typeof code === "number") return resolve({ stdout: String(stdout ?? ""), exitCode: code });
        reject(error); // ENOENT (not installed), timeout kill (ETIMEDOUT), etc.
      },
    );
  });

interface DoctorPayload {
  ok: boolean;
  overall: string;
  checks: MemoryPreflightCheck[];
}

function normaliseStatus(raw: unknown): MemoryPreflightCheck["status"] {
  if (raw === "ok") return "ok";
  if (raw === "unknown") return "unknown";
  return "fail";
}

/** Parse `herdr-eng memory doctor --json`. Returns null on anything structurally unexpected. */
export function parseDoctorJson(stdout: string): DoctorPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.checks)) return null;
  const checks: MemoryPreflightCheck[] = [];
  for (const entry of obj.checks) {
    if (typeof entry !== "object" || entry === null) return null;
    const c = entry as Record<string, unknown>;
    if (typeof c.name !== "string") return null;
    checks.push({
      name: c.name,
      status: normaliseStatus(c.status),
      detail: typeof c.detail === "string" ? c.detail : "",
    });
  }
  return {
    ok: obj.ok === true,
    overall: typeof obj.overall === "string" ? obj.overall : "unknown",
    checks,
  };
}

/**
 * Consult `herdr-eng memory doctor` for this host's memory provisioning state.
 * Never throws: every failure resolves to `available: false` with a reason.
 */
export async function runMemoryPreflight(opts: {
  harness: string;
  runner?: PreflightRunner;
  timeoutMs?: number;
}): Promise<MemoryPreflightResult> {
  const runner = opts.runner ?? defaultPreflightRunner;
  const timeoutMs = opts.timeoutMs ?? DOCTOR_TIMEOUT_MS;
  const args = ["memory", "doctor", "--json"];
  // Only the four names doctor knows reach --harness; anything else uses the default (all harnesses).
  if (DOCTOR_HARNESSES.has(opts.harness)) args.push("--harness", opts.harness);
  try {
    const { stdout } = await runner(args, timeoutMs);
    const parsed = parseDoctorJson(stdout);
    if (!parsed) {
      return { available: false, code: "error", reason: "herdr-eng memory doctor returned unreadable output" };
    }
    // A non-zero exit is not treated as "unavailable": doctor reports failing
    // checks in the JSON it still prints, and those are exactly what to show.
    return { available: true, ok: parsed.ok, overall: parsed.overall, checks: parsed.checks };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const message = (error as Error)?.message ?? "unknown error";
    if (code === "ENOENT") {
      return { available: false, code: "not-installed", reason: "herdr-eng is not installed on this host" };
    }
    if (code === "ETIMEDOUT" || /\btimed out\b|\btimeout\b/i.test(message)) {
      return { available: false, code: "timeout", reason: `herdr-eng memory doctor timed out after ${timeoutMs}ms` };
    }
    return { available: false, code: "error", reason: `herdr-eng memory doctor failed: ${message}` };
  }
}

const STATUS_LABEL: Record<MemoryPreflightCheck["status"], string> = {
  ok: "OK",
  unknown: "UNKNOWN",
  fail: "FAIL",
};

/**
 * Render a preflight result as the lines of a `Memory preflight:` section: a
 * summary line, then one line per check. An unavailable result is a single line
 * naming why doctor could not be consulted.
 */
export function formatMemoryPreflight(result: MemoryPreflightResult): string[] {
  if (!result.available) {
    return ["Memory preflight:", `  UNAVAILABLE  ${result.reason}`];
  }
  const failing = result.checks.filter((c) => c.status === "fail").length;
  const summary =
    failing > 0
      ? `Memory preflight: ${result.overall} (${result.checks.length} checks, ${failing} failing)`
      : `Memory preflight: ${result.overall} (${result.checks.length} checks)`;
  const lines = [summary];
  for (const check of result.checks) {
    const label = STATUS_LABEL[check.status].padEnd(7);
    lines.push(`  ${label} ${check.name}${check.detail ? `  ${check.detail}` : ""}`);
  }
  return lines;
}
