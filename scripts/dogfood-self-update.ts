#!/usr/bin/env node
/**
 * Self-update dogfood: exercise the update path against REAL git checkouts.
 *
 * The unit tests drive a scripted git. What they cannot show is that the
 * commands are the ones git actually accepts, that porcelain v2 parses what
 * this git version emits, and — the one that matters — that a checkout with
 * uncommitted work is left untouched when a real `git merge` is one call away.
 *
 * Every phase either reads or operates on a disposable clone. The repository
 * you are sitting in is only ever READ.
 *
 *   node scripts/dogfood-self-update.ts [--verbose]
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkForUpdate } from "../src/update/selfUpdate.ts";

const exec = promisify(execFile);
const verbose = process.argv.includes("--verbose");
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

function gitIn(cwd: string) {
  return async (args: string[]) => {
    try {
      const r = await exec("git", ["-C", cwd, ...args], { timeout: 30_000 });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        code: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "",
      };
    }
  };
}

async function head(cwd: string): Promise<string> {
  const r = await exec("git", ["-C", cwd, "rev-parse", "HEAD"]);
  return r.stdout.trim();
}

/** An upstream repo plus a clone that is one commit behind it. */
async function behindClone(): Promise<{ root: string; clone: string; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "selfupdate-"));
  const origin = join(root, "origin");
  const clone = join(root, "clone");
  await exec("git", ["init", "-q", "--bare", origin]);

  const seed = join(root, "seed");
  await exec("git", ["clone", "-q", origin, seed]);
  await exec("git", ["-C", seed, "config", "user.email", "t@example.invalid"]);
  await exec("git", ["-C", seed, "config", "user.name", "t"]);
  writeFileSync(join(seed, "a.txt"), "one");
  await exec("git", ["-C", seed, "add", "-A"]);
  await exec("git", ["-C", seed, "commit", "-qm", "first"]);
  await exec("git", ["-C", seed, "push", "-q", "origin", "HEAD:refs/heads/main"]);

  await exec("git", ["clone", "-q", "-b", "main", origin, clone]);
  await exec("git", ["-C", clone, "config", "user.email", "t@example.invalid"]);
  await exec("git", ["-C", clone, "config", "user.name", "t"]);

  // Advance upstream so the clone is genuinely behind.
  writeFileSync(join(seed, "a.txt"), "two");
  await exec("git", ["-C", seed, "commit", "-qam", "second"]);
  // `HEAD:main` again: the seed clone of an empty bare repo sits on git's
  // default init branch, whatever that is configured to be locally.
  await exec("git", ["-C", seed, "push", "-q", "origin", "HEAD:main"]);

  return { root, clone, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function phaseAppliesRealFastForward(): Promise<void> {
  console.log("\nphase 1: a real clone behind its upstream is fast-forwarded");
  const h = await behindClone();
  try {
    const before = await head(h.clone);
    const result = await checkForUpdate({ cwd: h.clone, git: gitIn(h.clone), apply: true });
    const after = await head(h.clone);
    if (verbose) console.log(`  ${before.slice(0, 8)} -> ${after.slice(0, 8)} · ${result.decision.reason}`);

    check(result.decision.action === "update", `detected as update (${result.decision.action})`);
    check(result.applied, "the fast-forward was applied");
    check(after !== before, "HEAD actually moved");
    check(result.head === after, "the reported commit is the real one");
  } finally {
    h.cleanup();
  }
}

async function phaseRefusesDirtyTree(): Promise<void> {
  console.log("\nphase 2: uncommitted work is never pulled over");
  const h = await behindClone();
  try {
    // A real, uncommitted edit — the thing that must survive.
    writeFileSync(join(h.clone, "a.txt"), "MY UNCOMMITTED WORK");
    const before = await head(h.clone);

    const result = await checkForUpdate({ cwd: h.clone, git: gitIn(h.clone), apply: true });
    const after = await head(h.clone);
    const content = (await exec("cat", [join(h.clone, "a.txt")])).stdout;

    check(result.applied === false, "no update applied");
    check(result.decision.action === "report", `reported rather than applied (${result.decision.action})`);
    check(after === before, "HEAD did not move");
    check(content === "MY UNCOMMITTED WORK", "the uncommitted edit is intact");
  } finally {
    h.cleanup();
  }
}

async function phaseReadsThisCheckout(): Promise<void> {
  console.log("\nphase 3: this repository is read, never written");
  const cwd = process.cwd();
  const before = await head(cwd);
  const result = await checkForUpdate({ cwd, git: gitIn(cwd), apply: false, offline: true });
  const after = await head(cwd);

  if (verbose) console.log(`  decision: ${result.decision.action} · ${result.decision.reason}`);
  check(after === before, "HEAD unchanged after a report-only run");
  check(result.applied === false, "nothing applied");
  check(result.observation?.branch != null, "the real branch was parsed from porcelain v2");
}

async function phaseNonRepoIsSilence(): Promise<void> {
  console.log("\nphase 4: a directory that is not a repository is silence");
  const dir = mkdtempSync(join(tmpdir(), "selfupdate-bare-"));
  try {
    const result = await checkForUpdate({ cwd: dir, git: gitIn(dir), apply: true });
    check(result.decision.action === "skip", `skipped (${result.decision.action})`);
    check(result.unavailable !== undefined, "reported as unavailable, not as an error");
    check(result.applied === false, "nothing applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("self-update dogfood");
  await phaseAppliesRealFastForward();
  await phaseRefusesDirtyTree();
  await phaseReadsThisCheckout();
  await phaseNonRepoIsSilence();

  console.log("");
  if (failures.length > 0) {
    console.log(`SELF-UPDATE DOGFOOD FAILED: ${failures.length} check(s)`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("SELF-UPDATE DOGFOOD OK");
}

main().catch((err) => {
  console.error("dogfood-self-update:", err);
  process.exit(1);
});
