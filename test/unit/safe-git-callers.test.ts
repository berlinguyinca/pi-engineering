/**
 * T16 H5 regression guard: no source file may spawn `git` directly unless it is listed, with a reason, in
 * RAW_GIT_EXCEPTIONS (src/git/safeGit.ts). Everything else goes through safeGit / safeGitOrThrow, which neutralise
 * repository-local drivers, hooks, fsmonitor and helpers a worker can plant.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { RAW_GIT_EXCEPTIONS } from "../../src/git/safeGit.ts";

const ROOT = join(import.meta.dirname, "..", "..");
// Any call whose first argument is the literal "git": spawn/spawnSync/execFile/execFileSync/exec/execFileAsync/run(...)
// ... and the shell-string form: exec("git status"), execSync(`git ${args}`), sh -c "git ...".
const RAW_GIT = new RegExp(
  [
    "\\b[A-Za-z_]\\w*\\(\\s*[\"'`]git[\"'`]\\s*,", // spawn("git", [...]) and friends
    "\\b\\w*(?:exec|spawn|run|shell|system)\\w*\\(\\s*[\"'`]git\\s", // exec("git status")
  ].join("|"),
  "i",
);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".mts") || p.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "extensions"))].map((p) => relative(ROOT, p));
const offenders = files.filter((f) => RAW_GIT.test(readFileSync(join(ROOT, f), "utf8")));

test("only safeGit and the documented exceptions spawn git directly", () => {
  const allowed = new Set(["src/git/safeGit.ts", ...Object.keys(RAW_GIT_EXCEPTIONS)]);
  const unexpected = offenders.filter((f) => !allowed.has(f));
  assert.deepEqual(
    unexpected,
    [],
    `route these through safeGit (src/git/safeGit.ts) or document them: ${unexpected.join(", ")}`,
  );
});

test("every exception still exists and says why", () => {
  for (const [file, ex] of Object.entries(RAW_GIT_EXCEPTIONS)) {
    assert.ok(files.includes(file), `${file} is listed but does not exist`);
    assert.ok(ex.why.length > 10, `${file} needs a reason`);
    if (ex.kind !== "worker-command")
      assert.ok(offenders.includes(file), `${file} no longer spawns git directly; remove the entry`);
  }
});

test("worker-command exceptions scrub the environment", () => {
  for (const [file, ex] of Object.entries(RAW_GIT_EXCEPTIONS)) {
    if (ex.kind !== "worker-command") continue;
    assert.match(readFileSync(join(ROOT, file), "utf8"), /workerCommandEnv\(/, `${file} must use workerCommandEnv`);
  }
});

test("the detector itself matches the shapes it exists to catch", () => {
  assert.ok(RAW_GIT.test('await exec("git", ["status"])'));
  assert.ok(RAW_GIT.test("spawn(\n    'git',\n    args)"));
  assert.ok(RAW_GIT.test("execFileSync(`git`, args)"));
  assert.ok(RAW_GIT.test('execSync("git status --porcelain")'));
  assert.ok(RAW_GIT.test("exec(`git ${args}`)"));
  assert.ok(!RAW_GIT.test('safeGit(["status"], { cwd })'));
  assert.ok(!RAW_GIT.test('const x = exec("gitlab-runner", [])'));
});
