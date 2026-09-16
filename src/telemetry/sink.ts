/**
 * Where diagnostic lines go.
 *
 * This exists because of a rendering bug with one root cause. Several
 * subsystems reported themselves with `process.stderr.write(JSON.stringify(…))`,
 * which is correct in a headless worker and destructive inside Pi: the TUI owns
 * the screen, composites an overlay into a frame it drew itself, and a raw
 * write lands underneath all of that. What the operator sees is a line of JSON
 * running off the right edge without wrapping, straight through the side panel,
 * and — because the write scrolls the terminal by a row the TUI does not know
 * about — the frame beneath it shifted by one, which is how a file called
 * `extensions/index.ts` comes to be drawn as `xtensions/index.ts`.
 *
 * So the rule is: nothing writes to the terminal directly. A subsystem emits a
 * SHORT, human-readable notice at a severity, and the surface it is running on
 * decides how to show it. With no surface installed — a worker, a script, a
 * test — the default is exactly the old behaviour, because a background process
 * has no TUI to corrupt and its stderr is the only record there is.
 */

export type TelemetryLevel = "info" | "warning" | "error";

export interface TelemetryNotice {
  level: TelemetryLevel;
  /** One line, already phrased for a human. No JSON. */
  text: string;
  /**
   * What this notice is ABOUT, for throttling repeats.
   *
   * Separate from `text` because the text carries live numbers — a gateway
   * wait names the queue depth, which moves between waits — so two notices
   * that are the same event to an operator are different strings. Throttling on
   * the text would silence the one case it should not (an unchanging repeat)
   * and let through the one it should (the same condition, renumbered).
   *
   * Absent means the text is stable enough to key on.
   */
  key?: string;
  /**
   * The structured event, for a sink that wants to record rather than show it.
   * Never rendered by the default sink: that is what the bug was.
   */
  detail?: unknown;
}

export type TelemetrySink = (notice: TelemetryNotice) => void;

/**
 * Installed surfaces, newest last. The one in force is the newest still live.
 *
 * A stack rather than a single slot plus a remembered predecessor, which is
 * what this was and which a fresh-context review found broken: each
 * uninstaller captured whatever had been installed before it and restored that
 * value, with no way to know the predecessor had ALSO been uninstalled in the
 * meantime. Install A, install B, uninstall A, uninstall B and the process is
 * left pointed at A — a sink belonging to a session that has already gone,
 * which is the exact failure the single-slot version was written to avoid.
 *
 * With a stack, removal is removal: an entry that is gone cannot be restored
 * by anyone else's teardown, in any order.
 */
const stack: TelemetrySink[] = [];

/**
 * Route notices to a surface. Returns an uninstaller.
 *
 * The newest surface wins while it is installed, and teardown order does not
 * matter: uninstalling is idempotent and removes only the caller's own entry.
 */
export function setTelemetrySink(sink: TelemetrySink): () => void {
  stack.push(sink);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const at = stack.lastIndexOf(sink);
    if (at >= 0) stack.splice(at, 1);
  };
}

/** The sink in force, for tests and for callers that want to check. */
export function currentTelemetrySink(): TelemetrySink | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined;
}

/** Drop every installed surface. Tests only, for isolation between cases. */
export function resetTelemetrySinks(): void {
  stack.length = 0;
}

/**
 * Should structured lines go to stderr even when a surface is installed?
 *
 * The escape hatch for diagnosing the gateway itself, where a scrambled frame
 * is a fair price for the raw events. Off by default.
 */
export function stderrForced(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.PI_TELEMETRY_STDERR ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/**
 * Report a notice.
 *
 * Never throws: a sink that fails must not take down the work it was reporting
 * on, and a failed sink falls back to stderr rather than swallowing the line.
 */
export function emitTelemetry(notice: TelemetryNotice, env: NodeJS.ProcessEnv = process.env): void {
  const sink = currentTelemetrySink();
  if (!sink) {
    writeStderr(notice);
    return;
  }
  if (stderrForced(env)) writeStderr(notice);
  try {
    sink(notice);
  } catch {
    if (!stderrForced(env)) writeStderr(notice);
  }
}

/** The headless default: a tagged line on stderr, as it has always been. */
function writeStderr(notice: TelemetryNotice): void {
  try {
    const detail = notice.detail === undefined ? "" : ` ${safeJson(notice.detail)}`;
    process.stderr.write(`[${notice.level}] ${notice.text}${detail}\n`);
  } catch {
    /* A closed stderr is not worth an exception. */
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
