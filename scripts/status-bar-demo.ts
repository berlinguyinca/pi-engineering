/**
 * Live status-bar validation demo.
 *
 * Exercises the reusable status telemetry layer end-to-end:
 *   - git context resolution (primary worktree, linked worktree, detached HEAD,
 *     non-git dir) against real git repos;
 *   - rolling token/s throughput during a simulated streaming generation;
 *   - final usage reconciliation and idle retention of the last completed TPS;
 *   - responsive layout across wide / medium / narrow terminal widths.
 *
 * No sleeping: throughput uses an injected fake clock.
 *
 * Run: node scripts/status-bar-demo.ts
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { DEFAULT_STATUS_BAR_CONFIG } from "../src/status/config.ts";
import { GitContextProvider } from "../src/status/git-context.ts";
import { renderStatus } from "../src/status/layout.ts";
import type { HarnessStatusState } from "../src/status/state.ts";
import { ThroughputTracker } from "../src/status/throughput.ts";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) => {
  const { stdout } = await exec("git", ["-C", cwd, ...args]);
  return stdout.trim();
};

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "statusbar-demo-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "a.txt"), "hello\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "initial"]);
  await git(dir, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
  return dir;
}

function stateFrom(g: Awaited<ReturnType<GitContextProvider["resolve"]>>, model: string): HarnessStatusState {
  return {
    cwd: g.repositoryRoot ?? ".",
    repository: g.repository,
    repositoryRoot: g.repositoryRoot,
    worktree: g.worktree,
    branch: g.branch,
    detachedHead: g.detachedHead,
    model,
    provider: "openrouter",
    throughput: {},
  };
}

function withTps(s: HarnessStatusState, tps: number, phase: "streaming" | "idle" = "streaming"): HarnessStatusState {
  return {
    ...s,
    throughput:
      phase === "streaming"
        ? { phase: "streaming", currentTokensPerSecond: tps, outputTokens: undefined }
        : {
            phase: "idle",
            currentTokensPerSecond: undefined,
            lastCompletedTokensPerSecond: tps,
            outputTokens: undefined,
          },
  };
}

async function main() {
  console.log("pi-engineering-runtime — status bar live demo\n");

  const clock = { now: 0 };
  const tracker = new ThroughputTracker({
    windowMs: DEFAULT_STATUS_BAR_CONFIG.tpsWindowMs,
    now: () => clock.now,
  });
  const gitProvider = new GitContextProvider();

  const repo = await makeRepo();
  let wtPath = "";
  try {
    // --- 1. Primary worktree, multi-width -------------------------------
    const g = await gitProvider.resolve(repo);
    const base = stateFrom(g, "deepseek-v4-flash");
    console.log("[1] primary worktree — responsive widths");
    for (const w of [140, 100, 70, 50, 40]) {
      console.log(`  width ${String(w).padStart(3)} | ${renderStatus(base, w, DEFAULT_STATUS_BAR_CONFIG)}`);
    }

    // --- 2. Live streaming TPS ------------------------------------------
    console.log("\n[2] live streaming — cumulative token samples over a rolling window");
    tracker.beginGeneration();
    const samples: Array<[number, number]> = [
      [0, 0],
      [400, 320],
      [800, 640],
      [1200, 960],
      [1600, 1280],
      [2000, 1600],
      [2400, 1920],
    ];
    for (const [t, tokens] of samples) {
      clock.now = t;
      tracker.onStreamEvent({ cumulativeOutputTokens: tokens, deltaText: "" });
      const snap = tracker.snapshot();
      const tps = snap.currentTokensPerSecond ?? 0;
      console.log(
        `  t=${String(t).padStart(4)}ms tokens=${String(tokens).padStart(4)} tps=${tps.toFixed(1).padStart(6)} | ${renderStatus(withTps(base, tps), 100, DEFAULT_STATUS_BAR_CONFIG)}`,
      );
    }

    // --- 3. Idle retains last completed TPS (authoritative reconcile) ----
    console.log("\n[3] end of generation — authoritative final usage reconcile");
    clock.now = 2500;
    tracker.endGeneration(2000); // authoritative final output tokens
    const idleSnap = tracker.snapshot();
    const idleState = withTps(base, idleSnap.lastCompletedTokensPerSecond ?? 0, "idle");
    console.log(
      `  last=${idleSnap.lastCompletedTokensPerSecond?.toFixed(1)} live=${idleSnap.currentTokensPerSecond ?? 0}`,
    );
    console.log(`  ${renderStatus(idleState, 100, DEFAULT_STATUS_BAR_CONFIG)}`);

    // --- 4. Linked worktree ---------------------------------------------
    wtPath = join(repo, "..", "statusbar-demo-wt");
    await mkdir(wtPath, { recursive: true });
    await git(repo, ["worktree", "add", "-q", "-b", "feature/widget", wtPath]);
    gitProvider.invalidate();
    const wt = await gitProvider.resolve(wtPath);
    const wtState = stateFrom(wt, "qwen3.8-flash-next");
    console.log("\n[4] linked worktree (wt:<name>)");
    console.log(`  ${JSON.stringify({ repository: wt.repository, worktree: wt.worktree, branch: wt.branch })}`);
    console.log(`  ${renderStatus(wtState, 100, DEFAULT_STATUS_BAR_CONFIG)}`);

    // --- 5. Detached HEAD -----------------------------------------------
    await git(repo, ["checkout", "-q", "--detach"]);
    gitProvider.invalidate();
    const det = await gitProvider.resolve(repo);
    const detState = stateFrom(det, "deepseek-v4-flash");
    console.log("\n[5] detached HEAD");
    console.log(`  ${JSON.stringify({ detachedHead: det.detachedHead, branch: det.branch ?? null })}`);
    console.log(`  ${renderStatus(detState, 100, DEFAULT_STATUS_BAR_CONFIG)}`);
    await git(repo, ["checkout", "-q", "main"]);

    // --- 6. Non-git directory -------------------------------------------
    const nonGit = await mkdtemp(join(tmpdir(), "statusbar-nongit-"));
    gitProvider.invalidate();
    const ng = await gitProvider.resolve(nonGit);
    const ngState = stateFrom(ng, "deepseek-v4-flash");
    console.log("\n[6] outside git — graceful degradation");
    for (const w of [100, 40]) {
      console.log(`  width ${w} | ${renderStatus(ngState, w, DEFAULT_STATUS_BAR_CONFIG)}`);
    }
    await rm(nonGit, { recursive: true, force: true });

    console.log("\nOK — all status-bar demo scenarios rendered.");
  } finally {
    if (wtPath) await git(repo, ["worktree", "remove", wtPath, "--force"]).catch(() => {});
    await rm(repo, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
