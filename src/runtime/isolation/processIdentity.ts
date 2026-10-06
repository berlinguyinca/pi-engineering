/**
 * Process identity and liveness.
 *
 * A PID alone does not identify a process: Linux reuses PIDs, so "pid 4711
 * exists" proves nothing about whether the session that recorded pid 4711 is
 * still alive. An owner record therefore carries the incarnation of its process
 * — boot id plus the kernel's start time for that PID — and liveness compares
 * the recorded incarnation against the live one.
 *
 * On Linux the start time is field 22 of `/proc/<pid>/stat` (clock ticks since
 * boot). Elsewhere it is unavailable and liveness degrades to `kill(pid, 0)`,
 * which callers must combine with heartbeat age before reclaiming anything.
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export interface ProcessIdentity {
  pid: number;
  host: string;
  /** Kernel boot id; changes on every reboot. Null where unavailable. */
  bootId: string | null;
  /** Clock ticks since boot at which the process started. Null where unavailable. */
  processStartTime: string | null;
}

export type ProcessLiveness =
  | { state: "alive"; reason: "incarnation_matches" | "signal_ok" }
  | { state: "dead"; reason: "pid_not_alive" | "pid_reused" | "rebooted" }
  | { state: "unknown"; reason: "remote_host" | "identity_unavailable" | "permission_denied" };

export function readBootId(): string | null {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Field 22 (`starttime`) of `/proc/<pid>/stat`. The command name (field 2) may
 * contain spaces and parentheses, so fields are counted after the LAST `)`.
 */
export function readProcessStartTime(
  pid: number,
): { state: "present"; value: string } | { state: "missing" } | { state: "unknown" } {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = line.lastIndexOf(")");
    // After ")" come field 3 (state) onwards; field 22 is index 19 there.
    const value =
      close >= 0
        ? line
            .slice(close + 2)
            .trim()
            .split(/\s+/)[19]
        : undefined;
    return value && /^\d+$/.test(value) ? { state: "present", value } : { state: "unknown" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return { state: "missing" };
    return { state: "unknown" };
  }
}

/** Absolute boot time in epoch seconds (`btime` in /proc/stat), when available. */
export function readBootTimeSeconds(): number | null {
  try {
    const match = /^btime\s+(\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

let cachedSelf: ProcessIdentity | null = null;

/** Identity of the current process. Cached: none of it changes during a process lifetime. */
export function currentProcessIdentity(): ProcessIdentity {
  if (cachedSelf && cachedSelf.pid === process.pid) return { ...cachedSelf };
  const start = readProcessStartTime(process.pid);
  cachedSelf = {
    pid: process.pid,
    host: hostname(),
    bootId: readBootId(),
    processStartTime: start.state === "present" ? start.value : null,
  };
  return { ...cachedSelf };
}

function signalProbe(pid: number): "alive" | "dead" | "permission_denied" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return "permission_denied";
    return "dead";
  }
}

/**
 * Decide whether the process described by `owner` is the same live process.
 *
 * `dead` is a proof (gone, PID reused, or machine rebooted) and permits
 * reclamation. `unknown` is NOT proof of death: callers fall back to heartbeat
 * expiry before reclaiming.
 */
export function assessProcess(owner: ProcessIdentity): ProcessLiveness {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return { state: "dead", reason: "pid_not_alive" };
  if (owner.host !== hostname()) return { state: "unknown", reason: "remote_host" };
  const bootId = readBootId();
  if (owner.bootId && bootId && owner.bootId !== bootId) return { state: "dead", reason: "rebooted" };
  if (owner.processStartTime) {
    const start = readProcessStartTime(owner.pid);
    if (start.state === "missing") return { state: "dead", reason: "pid_not_alive" };
    if (start.state === "present") {
      return start.value === owner.processStartTime
        ? { state: "alive", reason: "incarnation_matches" }
        : { state: "dead", reason: "pid_reused" };
    }
  }
  // No recorded or readable incarnation (non-Linux, or /proc hidden).
  const probe = signalProbe(owner.pid);
  if (probe === "dead") return { state: "dead", reason: "pid_not_alive" };
  if (probe === "permission_denied") return { state: "unknown", reason: "permission_denied" };
  return owner.processStartTime
    ? { state: "unknown", reason: "identity_unavailable" }
    : { state: "alive", reason: "signal_ok" };
}
