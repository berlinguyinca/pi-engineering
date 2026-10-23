#!/usr/bin/env node
/** Installed by install-session-auto-resume.ts; delegates to the existing Pi CLI. */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
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
// Runtime selection (pi_runtime in engineering.yaml). Decided HERE, before Pi starts: any problem
// leaves standard Pi in place. A runtime that has started is never replayed on another one.
let decision: import("../src/runtime/piRuntime.ts").LaunchDecision | null = null;
const agentDir = process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent");
try {
  const { decideLaunchRuntime } = await import("../src/runtime/piRuntime.ts");
  decision = await decideLaunchRuntime(process.cwd(), agentDir, process.env);
  if (decision) {
    mkdirSync(agentDir, { recursive: true });
    appendFileSync(
      resolve(agentDir, "runtime-selection.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...decision })}\n`,
    );
    if (decision.fallbackReason) {
      process.stderr.write(
        `[pi runtime] ${decision.requested} unavailable, using standard Pi: ${decision.fallbackReason}\n`,
      );
    }
  }
} catch (error) {
  decision = null;
  process.stderr.write(`[pi runtime] Selection skipped: ${error instanceof Error ? error.message : String(error)}\n`);
}
if (decision?.binary) {
  const child = spawn(decision.binary, prepared.argv, {
    stdio: "inherit",
    env: { ...process.env, PI_RUNTIME_KIND: decision.runtime, PI_RUNTIME_SOURCE: decision.source },
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  child.on("error", (error) => {
    // Failed to start at all (nothing ran): the only case where standard Pi may still take over.
    process.stderr.write(`[pi runtime] ${decision.runtime} did not start (${error.message}); using standard Pi\n`);
    process.argv = [process.argv[0]!, cli, ...prepared.argv];
    void import(pathToFileURL(cli).href);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 + (signal === "SIGINT" ? 2 : 15) : 1)));
} else {
  process.argv = [process.argv[0]!, cli, ...prepared.argv];
  await import(pathToFileURL(cli).href);
}
