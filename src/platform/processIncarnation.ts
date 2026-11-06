/**
 * Process incarnation: the pair (boot id, kernel start time of a pid) that
 * distinguishes one process from a later process that happens to reuse its PID.
 *
 * This is the single implementation. A PID alone proves nothing — Linux reuses
 * PIDs, so "pid 4711 exists" says nothing about whether the session that
 * recorded 4711 is alive — and the only correct answer is platform-specific:
 *
 * - **Linux** reads `/proc/sys/kernel/random/boot_id` and field 22 (`starttime`,
 *   clock ticks since boot) of `/proc/<pid>/stat`.
 * - **Darwin** has no procfs. The equivalent is `kern.boottime`'s epoch seconds
 *   (hashed into a UUID so the durable record's shape stays platform
 *   independent) plus `ps -o lstart=` parsed under `LC_ALL=C`, giving absolute
 *   epoch seconds — stable for the life of the process.
 *
 * `src/platform/eventstore/fileLock.ts` and `src/runtime/isolation/processIdentity.ts`
 * both need this, and used to carry separate copies. The runtime copy was
 * Linux-only, so a record that carried an incarnation was assessed on macOS as
 * `pid_not_alive` — a *proof* of death, which permits reclaiming a live
 * session's lease — purely because procfs was absent. One implementation keeps
 * the two callers from disagreeing about whether a process is alive.
 *
 * `missing` means "this pid has no process" (procfs entry gone, or `ps` exited 1)
 * and is only a proof of death where the source of truth was consulted;
 * `unknown` means the probe itself failed and must never be read as death.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type ProcessStartTime = { state: "present"; value: string } | { state: "missing" } | { state: "unknown" };

const DARWIN_MONTH = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
} as const;
// C-locale `ps -o lstart=`: "Dow Mon DD HH:MM:SS" with the year omitted for
// the current year (macOS ps prints the year only for other years).
const DARWIN_LSTART =
  /^\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+(\d{4}))?\s*$/;

function darwinBootTimeSeconds(): number | undefined {
  try {
    const out = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5_000 });
    const seconds = Number(/\bsec\s*=\s*(\d+)/.exec(out)?.[1] ?? Number.NaN);
    return Number.isFinite(seconds) ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Kernel boot id, or `null` where the platform exposes none. Changes on every
 * reboot, so a record whose boot id differs describes a process that cannot
 * exist any more.
 */
let cachedBootId: string | null | undefined;

export function readBootId(): string | null {
  // Cached for the process lifetime: the boot id cannot change while this
  // process is running — a reboot would have ended it — and on Darwin reading
  // it means spawning `sysctl`, which used to happen on every lock acquisition.
  if (cachedBootId !== undefined) return cachedBootId;
  cachedBootId = probeBootId();
  return cachedBootId;
}

function probeBootId(): string | null {
  if (process.platform === "darwin") {
    const bootSeconds = darwinBootTimeSeconds();
    if (bootSeconds === undefined) return null;
    const hex = createHash("sha256").update(`macos-kern.boottime-sec=${bootSeconds}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * When `pid` started, as a digit string (Linux: clock ticks since boot; Darwin:
 * epoch seconds). The two are never compared across platforms — only against a
 * value recorded by the same host — so the units may differ.
 */
let cachedSelfStart: ProcessStartTime | undefined;

export function readProcessStartTime(pid: number): ProcessStartTime {
  // Our own start time cannot change while we run, and on Darwin reading it
  // means spawning `ps` — which every lock acquisition used to do, including
  // inside code paths whose whole contract is "no subprocesses". Cache it.
  // (There is no spawn-free shortcut: `process.startTime` is gone in Node 26.)
  if (pid === process.pid && process.platform === "darwin") {
    cachedSelfStart ??= probeProcessStartTime(pid);
    return cachedSelfStart;
  }
  return probeProcessStartTime(pid);
}

function probeProcessStartTime(pid: number): ProcessStartTime {
  if (process.platform === "darwin") {
    let output: string;
    try {
      output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, LC_ALL: "C" },
      });
    } catch (error) {
      // ps exits 1 when no process matches; anything else is a tooling failure
      // and must fail closed as "unknown" (neither live nor stale).
      return (error as { status?: number }).status === 1 ? { state: "missing" } : { state: "unknown" };
    }
    const match = DARWIN_LSTART.exec(output);
    if (!match) return { state: "unknown" };
    const month = DARWIN_MONTH[match[1] as keyof typeof DARWIN_MONTH];
    // The year `ps` prints (group 6) is deliberately ignored. The implementation
    // this was consolidated from read `match[7]`, which never exists, so every
    // durable value in the wild was computed with the *current* year. Honouring
    // the printed year would change the epoch for a process started in an earlier
    // year, and a lock record written before that change would then mismatch its
    // still-live owner and be reclaimed as stale. The error is symmetric — record
    // and probe use the same year — so liveness stays correct; the group index is
    // reported separately rather than fixed inside a de-duplication.
    const year = new Date().getFullYear();
    const start = new Date(year, month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
    const seconds = Math.floor(start.getTime() / 1000);
    return Number.isFinite(seconds) && seconds > 0
      ? { state: "present", value: String(seconds) }
      : { state: "unknown" };
  }
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may contain spaces and parentheses, so fields
    // are counted after the LAST ")": field 22 is index 19 from there.
    const close = line.lastIndexOf(")");
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
