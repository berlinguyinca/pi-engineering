#!/usr/bin/env node
/** Installed by install-session-auto-resume.ts; delegates to the existing Pi CLI. */
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { prepareSessionAutoResume } from "../src/gateway/sessionAutoResume.ts";

const [cli, ...argv] = process.argv.slice(2);
if (!cli) throw new Error("Expected the original Pi CLI path");
let prepared: Awaited<ReturnType<typeof prepareSessionAutoResume>> = { argv, waitMs: 0, recovering: false };
try {
  // Piped input becomes Pi's initial prompt; never compete with it.
  if (process.stdin.isTTY) prepared = await prepareSessionAutoResume(argv, process.cwd());
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
