#!/usr/bin/env node
/** Installed by install-session-auto-resume.ts; delegates to the existing Pi CLI. */
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { prepareSessionAutoResume } from "../src/gateway/sessionAutoResume.ts";

const [cli, ...argv] = process.argv.slice(2);
if (!cli) throw new Error("Expected the original Pi CLI path");
let prepared = { argv, waitMs: 0, recovering: false };
try {
  // Piped input becomes Pi's initial prompt; never compete with it.
  if (process.stdin.isTTY) prepared = await prepareSessionAutoResume(argv, process.cwd());
} catch (error) {
  process.stderr.write(
    `[session recovery] Preflight skipped: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
if (prepared.recovering) {
  process.stderr.write(
    "[session recovery] Continuing interrupted work after Pi restores the session and selects its model.\n",
  );
  if (prepared.waitMs > 0) await setTimeout(prepared.waitMs);
}
process.argv = [process.argv[0]!, cli, ...prepared.argv];
await import(pathToFileURL(cli).href);
