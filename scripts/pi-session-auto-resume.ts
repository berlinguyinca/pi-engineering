#!/usr/bin/env node
/** Installed by install-session-auto-resume.ts; delegates to the existing Pi CLI. */
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// `--check` lets the managed hook prove this file loads before it hands Pi over to it.
if (process.argv[2] === "--check") process.exit(0);
const [given, ...argv] = process.argv.slice(2);
if (!given) throw new Error("Expected the original Pi CLI path");
let cli = given;
try {
  // A managed Pi switches releases under this launcher, so the Pi to run is resolved at
  // every start (the wrapper passes its release's bin entry, a symlink to the real CLI),
  // and the Pi packages the recovery rules import are re-pointed at that same release.
  cli = realpathSync(given);
  const { refreshLinks } = await import("../src/gateway/launcherLinks.ts");
  refreshLinks(resolve(dirname(fileURLToPath(import.meta.url)), ".."), cli);
} catch (error) {
  process.stderr.write(
    `[session recovery] Could not align the launcher with this Pi: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
type Prepared = { argv: string[]; waitMs: number; recovering: boolean; kind?: string; skipped?: string };
let prepared: Prepared = { argv, waitMs: 0, recovering: false };
try {
  // Piped input becomes Pi's initial prompt; never compete with it.
  // Loaded here, not at the top: if anything the recovery rules import is missing
  // or broken, Pi must still start. It then starts without recovery.
  if (process.stdin.isTTY) {
    const { prepareSessionAutoResume } = await import("../src/gateway/sessionAutoResume.ts");
    prepared = await prepareSessionAutoResume(argv, process.cwd());
  }
} catch (error) {
  process.stderr.write(
    `[session recovery] Preflight skipped: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
if (prepared.skipped) {
  process.stderr.write(
    `[session recovery] Not recovering this session: ${prepared.skipped}. Close it, or set PI_SESSION_AUTO_RESUME_IGNORE_LIVE=1.\n`,
  );
}
if (prepared.recovering) {
  const why =
    prepared.kind === "interrupted"
      ? "Pi stopped mid-turn"
      : prepared.kind === "failed-turn"
        ? "the last request failed"
        : "the last request was refused";
  process.stderr.write(
    `[session recovery] ${why}; continuing after Pi restores the session and selects its model (PI_SESSION_AUTO_RESUME=0 to skip).\n`,
  );
  if (prepared.waitMs > 0) await setTimeout(prepared.waitMs);
}
process.argv = [process.argv[0]!, cli, ...prepared.argv];
await import(pathToFileURL(cli).href);
