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
 *   epoch seconds — stable for the life of the process, and read from the year
 *   ps prints (see {@link parseDarwinLstart}), because the year a process began
 *   in is not something the probing clock gets to decide.
 *
 * Two resolution limits, on Darwin only, both inherent to `ps` — the only
 * start-time source Node can reach without a native helper — so stated rather
 * than fixed:
 *
 * - `lstart` reports whole seconds, so a pid reused within the same second as
 *   its predecessor is indistinguishable there, while Linux `starttime` ticks
 *   (~10 ms) usually tell them apart.
 * - In the DST fall-back hour `ps` prints the same wall clock for two instants
 *   3600 s apart, and `new Date(y, m, d, h, mi, s)` resolves both to the first
 *   pass, so a pid reused exactly one hour after its predecessor on that night
 *   is indistinguishable too.
 *
 * Neither weakens the year rule. Its own tolerance (see
 * {@link compareDarwinStartTimes}) accepts a same-boot pid reused at the
 * identical local month, day and hh:mm:ss in *any other year* — a window that
 * is open for every record, not only pre-fix ones — and the boot id covers it.
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
// C-locale `ps -o lstart=`: "Dow Mon DD HH:MM:SS YYYY". macOS ps prints the year
// for every process (verified on this host: `ps -o lstart= -p 1` ->
// "Fri Nov 20 13:03:30 2026"); BSD ps omits it for current-year processes, which
// is the only case `probeYear` below exists to cover.
const DARWIN_LSTART =
  /^\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+(\d{4}))?\s*$/;

/**
 * Local epoch seconds for a `ps -o lstart=` rendering, or `undefined` when the
 * text is not one. Fields are range-checked rather than left for `Date` to
 * normalise, so a truncated or corrupt probe yields "no answer" instead of a
 * plausible wrong instant.
 *
 * `probeYear` is used only when ps printed no year. Where a year is printed it
 * is a fact about the process and wins: deriving it from the clock instead made
 * one process yield a different incarnation after 1 January, which both callers
 * read as PID reuse and acted on by reclaiming a live owner's lease.
 */
export function parseDarwinLstart(output: string, probeYear: number): number | undefined {
  const match = DARWIN_LSTART.exec(output);
  if (!match) return undefined;
  const month = (DARWIN_MONTH as Partial<Record<string, number>>)[match[1] ?? ""];
  const day = Number(match[2]);
  const hours = Number(match[3]);
  const minutes = Number(match[4]);
  const seconds = Number(match[5]);
  const year = match[6] === undefined ? probeYear : Number(match[6]);
  if (
    month === undefined ||
    day < 1 ||
    day > 31 ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59 ||
    !Number.isSafeInteger(year) ||
    year < 1000
  ) {
    return undefined;
  }
  const start = new Date(year, month, day, hours, minutes, seconds);
  // "Feb 31" passes the range check; `Date` would hand back 3 March. A day the
  // month does not have is corrupt output, not an instant.
  if (start.getMonth() !== month || start.getDate() !== day) return undefined;
  const epoch = Math.floor(start.getTime() / 1000);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : undefined;
}

function epochSecondsOf(value: string): number | undefined {
  return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : undefined;
}

export type StartTimeComparison = "exact" | "year_ambiguous" | "different";

/** What the pre-fix code wrote for `instant`'s wall clock when the probe ran in `year`. */
function renderedInYear(instant: Date, year: number): number {
  return Math.floor(
    new Date(
      year,
      instant.getMonth(),
      instant.getDate(),
      instant.getHours(),
      instant.getMinutes(),
      instant.getSeconds(),
    ).getTime() / 1000,
  );
}

/**
 * Compare two Darwin incarnation values.
 *
 * `exact` is the normal answer. `year_ambiguous` means one value is what the
 * pre-fix code — same wall clock, the *probe's* year — would have written for
 * the other, so it must never be read as PID reuse. Usually that is the same
 * month, day and clock time in a different year, but the test is the rendering
 * itself, not the fields: a 29 February birth rendered into a non-leap probe
 * year was squeezed by `Date` to 1 March and does not even share a month with
 * the canonical value, and it is still the same process.
 *
 * The tolerance is permanent — every record is compared this way, not only
 * pre-fix ones — so the window it opens is a pid reused at the identical local
 * month, day and hh:mm:ss in any other year on a machine that never rebooted.
 * Both call sites check the boot id first, which covers that coincidence.
 */
export function compareDarwinStartTimes(stored: string, probed: string): StartTimeComparison {
  if (stored === probed) return "exact";
  const a = epochSecondsOf(stored);
  const b = epochSecondsOf(probed);
  if (a === undefined || b === undefined) return "different";
  const left = new Date(a * 1000);
  const right = new Date(b * 1000);
  if (left.getFullYear() === right.getFullYear()) return "different";
  const sameWallClock =
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate() &&
    left.getHours() === right.getHours() &&
    left.getMinutes() === right.getMinutes() &&
    left.getSeconds() === right.getSeconds();
  const oneIsTheOtherRendered =
    renderedInYear(right, left.getFullYear()) === a || renderedInYear(left, right.getFullYear()) === b;
  return sameWallClock || oneIsTheOtherRendered ? "year_ambiguous" : "different";
}

/**
 * Do these two recorded/probed start times describe the same process?
 *
 * Identity on Linux is exact (field 22 is ticks since boot, so a year means
 * nothing there) and on Darwin it is exact plus the year ambiguity above.
 * `platform` is a parameter so the Darwin rule is testable off macOS.
 */
export function startTimesMatch(stored: string, probed: string, platform: NodeJS.Platform = process.platform): boolean {
  if (stored === probed) return true;
  return platform === "darwin" && compareDarwinStartTimes(stored, probed) === "year_ambiguous";
}

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
 * Kernel boot id, or `null` where the platform exposes none. (Bounded by design:
 * one probe per process lifetime.) Changes on every
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
    const seconds = parseDarwinLstart(output, new Date().getFullYear());
    return seconds === undefined ? { state: "unknown" } : { state: "present", value: String(seconds) };
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
