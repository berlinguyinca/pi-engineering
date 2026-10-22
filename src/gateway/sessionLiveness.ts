/**
 * Is another Pi process already working in this session's directory?
 *
 * Pi takes no lock on a session file, and the age of the last entry cannot
 * tell a dead session from a live one that is busy: a 15-minute build tool
 * call, a long reasoning stream, or the in-session retry layers waiting out an
 * outage all leave an old tail. Recovering such a session would start a second
 * Pi on the same file, both appending to it.
 *
 * So the launcher asks the OS. On Linux that is a scan of /proc for another Pi
 * CLI whose working directory is the session's. It is deliberately coarse —
 * any other Pi in that directory counts — because the wrong answer is
 * asymmetric: a skipped recovery costs the operator one "retry"; a hijacked
 * live session costs a corrupted transcript. Without /proc (macOS) there is no
 * answer, and the age gate alone applies.
 */

import { readFileSync, readdirSync, readlinkSync } from "node:fs";

// Both layouts: dist/cli.js and the bundled dist/bundle/cli.js the installed `pi` runs.
const PI_CLI = /pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js$/;
const WRAPPER = /pi-session-auto-resume\.ts$/;

/** Process ids (other than `selfPid`) running a Pi CLI with `cwd` as working directory. */
export function otherPiProcessesIn(cwd: string, selfPid = process.pid, procRoot = "/proc"): number[] {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    try {
      const args = readFileSync(`${procRoot}/${entry}/cmdline`, "utf8").split("\0");
      if (!args.some((arg) => PI_CLI.test(arg) || WRAPPER.test(arg))) continue;
      if (readlinkSync(`${procRoot}/${entry}/cwd`) === cwd) found.push(pid);
    } catch {
      // The process exited, or belongs to someone we may not inspect.
    }
  }
  return found.sort((a, b) => a - b);
}
