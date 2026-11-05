/**
 * Issue #512: a repository named by `-C <dir>` must stay the repository that was
 * named. `GIT_DIR` in the environment beats `-C`, and the two read sites outside
 * `safeGit` handed git the ambient environment, so an inherited variable chose a
 * different checkout — `bar/scope.ts` labelled the audit revision from another
 * repository, and `runtime/host/loader.ts` fed the git dir it printed straight to
 * `SourceCache.exportTree`, building a generation snapshot from that repository.
 *
 * Both now hand git `withoutInjectedConfig(process.env)`, the same filter
 * `safeGit` and the self-update path use (issue #590).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sourceRevision } from "../../src/bar/index.ts";
import { withoutInjectedConfig } from "../../src/git/gitEnvironment.ts";
import { snapshotRuntimeSource } from "../../src/runtime/host/loader.ts";

const root = mkdtempSync(join(tmpdir(), "git-env-inherited-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Seed a one-commit repo whose HEAD is identifiable by the file it carries. */
function seedRepo(name: string, marker: string): { dir: string; head: string } {
  const dir = join(root, name);
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  writeFileSync(join(dir, "src", "lib", "a.ts"), `export const marker = ${JSON.stringify(marker)};\n`);
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      // The fixture builds the repos it wants; the code under test is what must
      // resist the environment.
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      encoding: "utf8",
    });
  run(["init", "--quiet", "-b", "main", dir]);
  run(["add", "-A"]);
  run(["-c", "user.email=fixture@pi.eng", "-c", "user.name=fixture", "commit", "--quiet", "-m", marker]);
  return { dir, head: run(["rev-parse", "HEAD"]).trim() };
}

/** Run a body with an injected environment, and put the process back afterwards. */
function withEnv<T>(injected: Record<string, string>, body: () => T): T {
  const saved = Object.entries(injected).map(([k]) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(injected)) process.env[k] = v;
  try {
    return body();
  } finally {
    restore(saved);
  }
}

/**
 * The async form: the environment has to stay injected until the work actually
 * runs, or the `finally` puts it back before the child process is spawned and the
 * test proves nothing.
 */
async function withEnvAsync<T>(injected: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const saved = Object.entries(injected).map(([k]) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(injected)) process.env[k] = v;
  try {
    return await body();
  } finally {
    restore(saved);
  }
}

function restore(saved: Array<readonly [string, string | undefined]>): void {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test("sourceRevision reports the HEAD of the repository it was given", () => {
  const a = seedRepo("scope-a", "A");
  assert.equal(sourceRevision(a.dir), a.head);
});

test("an inherited GIT_DIR does not choose the repository sourceRevision reads", () => {
  const a = seedRepo("scope-a2", "A");
  const b = seedRepo("scope-b2", "B");
  // Without the filter this returns B's HEAD: GIT_DIR outranks `-C <a.dir>`.
  const seen = withEnv({ GIT_DIR: join(b.dir, ".git") }, () => sourceRevision(a.dir));
  assert.equal(seen, a.head, "the revision came from the repository the environment named, not the one passed in");
});

test("injected config and a foreign work tree do not move the revision either", () => {
  const a = seedRepo("scope-a3", "A");
  const b = seedRepo("scope-b3", "B");
  const seen = withEnv(
    {
      GIT_DIR: join(b.dir, ".git"),
      GIT_WORK_TREE: b.dir,
      GIT_COMMON_DIR: join(b.dir, ".git"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${join(b.dir, ".git")}.insteadOf`,
      GIT_CONFIG_VALUE_0: join(a.dir, ".git"),
    },
    () => sourceRevision(a.dir),
  );
  assert.equal(seen, a.head);
});

test("the filter keeps the environment git needs to run at all", () => {
  // Stripping injection must not cost PATH: every one of these call sites relies
  // on finding the git binary the same way the caller does.
  const env = withoutInjectedConfig({ PATH: "/usr/bin", GIT_DIR: "/elsewhere/.git" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GIT_DIR, undefined);
});

test("a generation snapshot is exported from the source root, not from the repository the environment names", async () => {
  const a = seedRepo("loader-a", "A");
  const b = seedRepo("loader-b", "B");
  const snapshot = await withEnvAsync({ GIT_DIR: join(b.dir, ".git") }, () =>
    snapshotRuntimeSource(a.dir, join(root, "gens-loader"), "gen1", a.head),
  );
  assert.equal(readFileSync(join(snapshot, "src", "lib", "a.ts"), "utf8"), 'export const marker = "A";\n');
});

test("the same export still works with a clean environment", async () => {
  const a = seedRepo("loader-c", "C");
  const snapshot = await snapshotRuntimeSource(a.dir, join(root, "gens-clean"), "gen2", a.head);
  assert.equal(readFileSync(join(snapshot, "src", "lib", "a.ts"), "utf8"), 'export const marker = "C";\n');
});
