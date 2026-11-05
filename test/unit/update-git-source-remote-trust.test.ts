/**
 * Issue #590: the allow-list is only as good as the URL git actually contacts.
 *
 * `assertTrusted()` judges a string; git then applies `url.<x>.insteadOf` and may contact
 * something else entirely. On a fresh install the identity root recorded from that fetch
 * pins the wrong repository as the true one, so the defence meant to catch a hostile
 * candidate certifies it. These tests seed two local repositories and redirect one to the
 * other by each vector: injected environment, and the user's own config file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SourceCache, UpdateSourceError, effectiveRemote } from "../../src/update/gitSource.ts";

const root = mkdtempSync(join(tmpdir(), "update-insteadof-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A repo with one commit whose VERSION file names it, so a fetched tree proves the source. */
function seedRepo(path: string, message: string): string {
  mkdirSync(path, { recursive: true });
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: path,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      encoding: "utf8",
    });
  run(["init", "--quiet", "-b", "main", path]);
  writeFileSync(join(path, "VERSION"), message);
  run(["-c", "user.email=t@example.invalid", "-c", "user.name=trust-test", "add", "-A"]);
  run(["-c", "user.email=t@example.invalid", "-c", "user.name=trust-test", "commit", "--quiet", "-m", message]);
  return run(["rev-parse", "HEAD"]).trim();
}

/** What the cache's `refs/pi-src/heads/main` points at (empty when nothing was fetched). */
function fetchedSha(gitDir: string): string {
  try {
    return execFileSync("git", ["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", "refs/pi-src/heads/main"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function sourceOf(remote: string, trusted: string[] = [remote]) {
  return { remote, trusted, identityRoots: [] };
}

test("an injected url.<x>.insteadOf cannot redirect the fetch (#590)", async () => {
  const trusted = join(root, "trusted");
  const evil = join(root, "evil");
  const trustedSha = seedRepo(trusted, "trusted");
  seedRepo(evil, "evil");
  const cache = new SourceCache(join(root, "cache-env.git"));

  // The attack: one env entry, no network, no privileged paths.
  const keys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
  const saved = keys.map((k) => process.env[k]);
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${evil}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = trusted;
  try {
    await new SourceCache(cache.gitDir).fetch(sourceOf(trusted));
  } finally {
    keys.forEach((k, i) => {
      const v = saved[i];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  }

  const sha = fetchedSha(cache.gitDir);
  assert.equal(sha, trustedSha, "the fetch must serve the trusted repository, not the injected one");
});

test("a config-file insteadOf that leaves the allow-list is refused (#590)", async () => {
  const trusted = join(root, "trusted2");
  const evil = join(root, "evil2");
  seedRepo(trusted, "trusted2");
  seedRepo(evil, "evil2");
  const globalConfig = join(root, "global-redirect.gitconfig");
  writeFileSync(globalConfig, `[url "${evil}"]\n\tinsteadOf = ${trusted}\n`);
  const cache = new SourceCache(join(root, "cache-config.git"));

  // Not injected: this is the user's own config file, which git is entitled to honour.
  // The expansion is therefore checked against the allow-list instead of stripped.
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    await assert.rejects(
      () => cache.fetch(sourceOf(trusted)),
      (error: unknown) => {
        assert.ok(error instanceof UpdateSourceError);
        assert.match((error as Error).message, /resolves to .* after git's URL rewriting/);
        return true;
      },
    );
    assert.equal(fetchedSha(cache.gitDir), "", "nothing is fetched once the effective remote is refused");
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
});

test("a mirror the operator trusts keeps working when rewriting is legitimate", async () => {
  const origin = join(root, "origin3");
  const mirror = join(root, "mirror3");
  seedRepo(origin, "origin3");
  const mirrorSha = seedRepo(mirror, "mirror3");
  const globalConfig = join(root, "mirror.gitconfig");
  writeFileSync(globalConfig, `[url "${mirror}"]\n\tinsteadOf = ${origin}\n`);
  const cache = new SourceCache(join(root, "cache-mirror.git"));

  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    // The mirror is on the trusted list, so the rewrite is the operator's intent, not a bypass.
    await cache.fetch(sourceOf(origin, [origin, mirror]));
    assert.equal(fetchedSha(cache.gitDir), mirrorSha);
    assert.equal(await effectiveRemote(origin, cache.gitDir), mirror);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
});
