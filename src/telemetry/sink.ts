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
   * The structured event, for a sink that wants to record rather than show it.
   * Never rendered by the default sink: that is what the bug was.
   */
  detail?: unknown;
}

export type TelemetrySink = (notice: TelemetryNotice) => void;

let installed: TelemetrySink | undefined;

/**
 * Route notices to a surface. Returns an uninstaller.
 *
 * Last writer wins, and the uninstaller only clears the sink if it is still the
 * one it installed — two sessions tearing down out of order must not leave the
 * process with no sink while one of them is still running.
 */
export function setTelemetrySink(sink: TelemetrySink | undefined): () => void {
  const previous = installed;
  installed = sink;
  return () => {
    if (installed === sink) installed = previous;
  };
}

/** The sink in force, for tests and for callers that want to check. */
export function currentTelemetrySink(): TelemetrySink | undefined {
  return installed;
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
  const sink = installed;
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
