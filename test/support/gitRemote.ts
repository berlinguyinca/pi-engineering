/**
 * A real update source for updater tests: a bare repository acting as the
 * remote, an upstream working clone that publishes releases to it, and the
 * checkout Pi "installed" (cloned from the remote, so its origin is trusted).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FixtureOptions, writeFixtureRuntime } from "./runtimeFixtures.ts";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  })
    .toString()
    .trim();
}

export interface UpdateRepo {
  remote: string;
  upstream: string;
  checkout: string;
  /** Write a release into upstream, commit, push main; returns the commit. */
  publish(opts: FixtureOptions & { version: string }, extra?: (dir: string) => void): string;
  tag(name: string, commit?: string): void;
  head(): string;
}

export function createUpdateRepo(root: string, key: string, first: FixtureOptions & { version: string }): UpdateRepo {
  const remote = join(root, "remote.git");
  const upstream = join(root, "upstream");
  const checkout = join(root, "checkout");
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--quiet", "--initial-branch=main", upstream);
  git(upstream, "config", "user.email", "release@example.invalid");
  git(upstream, "config", "user.name", "release");
  git(upstream, "remote", "add", "origin", remote);
  const publish = (opts: FixtureOptions & { version: string }, extra?: (dir: string) => void) => {
    writeFixtureRuntime(upstream, key, opts);
    extra?.(upstream);
    git(upstream, "add", "-A");
    git(upstream, "commit", "--quiet", "--allow-empty", "-m", `release ${opts.version}`);
    git(upstream, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    return git(upstream, "rev-parse", "HEAD");
  };
  publish(first);
  git(root, "clone", "--quiet", "--branch", "main", remote, checkout);
  return {
    remote,
    upstream,
    checkout,
    publish,
    tag: (name, commit) => {
      git(upstream, "tag", "--force", name, commit ?? "HEAD");
      git(upstream, "push", "--quiet", "--force", "origin", `refs/tags/${name}`);
    },
    head: () => git(upstream, "rev-parse", "HEAD"),
  };
}

/** Replace upstream main with an unrelated history (different root commit). */
export function publishUnrelatedHistory(
  repo: UpdateRepo,
  key: string,
  opts: FixtureOptions & { version: string },
): string {
  const dir = join(repo.upstream, "..", "impostor");
  rmSync(dir, { recursive: true, force: true });
  git(join(repo.upstream, ".."), "init", "--quiet", "--initial-branch=main", dir);
  git(dir, "config", "user.email", "evil@example.invalid");
  git(dir, "config", "user.name", "evil");
  writeFixtureRuntime(dir, key, opts);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "impostor");
  git(dir, "push", "--quiet", "--force", repo.remote, "HEAD:refs/heads/main");
  return git(dir, "rev-parse", "HEAD");
}

/** Add a symlink pointing outside the tree to the next release. */
export function escapingSymlink(dir: string): void {
  symlinkSync("../../../../etc/passwd", join(dir, "evil-link"));
  writeFileSync(join(dir, "README.md"), "escape\n");
}
