/**
 * The one way Pi talks to the `herdr-memory` executable: spawn it, hand back stdout and the exit code, and
 * reject when the process itself could not run (missing binary, killed at the deadline).
 *
 * This lives apart from the provider so that both the provider and the preflight (#717) speak through the same
 * seam — a check that spawned the CLI differently from the calls it was checking would prove nothing.
 */
import { execFile } from "node:child_process";

export interface HindsightRunResult {
  stdout: string;
  exitCode: number;
}
/** Injectable subprocess runner; must reject or resolve non-zero on failure. */
export type HindsightRunner = (cli: string, args: string[], timeoutMs: number) => Promise<HindsightRunResult>;

/**
 * herdr-memory picks the credential and provenance harness from HERDR_HARNESS
 * (default "codex"). That is the CLI's own interface, so it is set on the child
 * process from the `memory.hindsight.harness` setting; Pi never reads it.
 */
export const makeRunner =
  (harness: string): HindsightRunner =>
  (cli, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env, HERDR_HARNESS: harness };
      execFile(
        cli,
        args,
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env },
        (error, stdout) => {
          if (!error) return resolve({ stdout, exitCode: 0 });
          const code = (error as { code?: unknown }).code;
          if (typeof code === "number") return resolve({ stdout: String(stdout ?? ""), exitCode: code });
          reject(error); // ENOENT, timeout kill, etc.
        },
      );
    });

export const defaultRunner: HindsightRunner = makeRunner("pi");
