/**
 * Fetching and staging Pi Engineering from a trusted git source (spec §12,
 * §15, §46).
 *
 * Security posture. Self-update is a supply-chain boundary.
 *   - Only remotes on the trusted list are fetched. The list defaults to the
 *     `origin` of the checkout Pi installed.
 *   - git runs via execFile with an argv array, never a shell. Every
 *     remote-derived string (refs, tags, versions, paths) is validated before
 *     use and never interpolated into a command line.
 *   - TLS verification cannot be switched off from the environment
 *     (GIT_SSL_NO_VERIFY is stripped and http.sslVerify is forced on).
 *     Protocols are restricted to https, ssh and, only when a trusted entry is
 *     a local path, file.
 *   - Repository identity: the candidate commit must descend from the
 *     repository's recorded root commit. A requested commit must resolve to
 *     exactly that commit and be reachable from a fetched branch or tag.
 *   - Extraction validates every tree path. No absolute paths, no `..`, no
 *     `.git` components, no submodules, and symlinks may only point inside the
 *     tree. After checkout every file is re-checked against the staging root.
 */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type UpdateChannel = "stable" | "main";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class UpdateSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateSourceError";
  }
}

const SHA = /^[0-9a-f]{40}$/;
const SHA_PREFIX = /^[0-9a-f]{7,40}$/;
const STABLE_TAG = /^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const SAFE_REF = /^refs\/(heads|tags|remotes)\/[A-Za-z0-9._/-]{1,200}$/;

/** Run git without a shell, with TLS verification enforced. */
export function runGit(
  args: string[],
  opts: { cwd?: string; gitDir?: string; timeoutMs?: number } = {},
): Promise<GitResult> {
  const env = { ...process.env };
  delete env.GIT_SSL_NO_VERIFY;
  env.GIT_TERMINAL_PROMPT = "0";
  const prefix = ["-c", "http.sslVerify=true", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
  const argv = [...prefix, ...(opts.gitDir ? ["--git-dir", opts.gitDir] : []), ...args];
  return new Promise((resolveResult) => {
    execFile(
      "git",
      argv,
      { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 1
          : 0;
        resolveResult({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function git(args: string[], opts: Parameters<typeof runGit>[1] = {}): Promise<string> {
  const r = await runGit(args, opts);
  if (r.code !== 0)
    throw new UpdateSourceError(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  return r.stdout;
}

/** Normalize a remote for comparison against the trusted list. */
export function normalizeRemote(remote: string): string {
  const r = remote.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(r) || /^[^/]+@[^:]+:/.test(r)) return r.replace(/\/+$/, "").replace(/\.git$/, "");
  return resolve(r).replace(/\.git$/, "");
}

export function isLocalRemote(remote: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) && !/^[^/]+@[^:]+:/.test(remote);
}

/** Reject anything that is not plainly a URL or a path (e.g. "--upload-pack=..."). */
export function assertSafeRemote(remote: string): void {
  if (!remote || remote.startsWith("-") || /[\0\n\r]/.test(remote)) {
    throw new UpdateSourceError(`refusing malformed remote ${JSON.stringify(remote)}`);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) && !/^(https|ssh|file):\/\//i.test(remote)) {
    throw new UpdateSourceError(`refusing remote protocol in ${remote}: only https, ssh and local paths are allowed`);
  }
  if (/^ext::|^fd::/i.test(remote)) throw new UpdateSourceError(`refusing remote helper in ${remote}`);
}

export interface TrustedSource {
  remote: string;
  trusted: string[];
  /** Root commit(s) identifying the repository; empty means "record on first fetch". */
  identityRoots: string[];
}

export function assertTrusted(source: TrustedSource): void {
  assertSafeRemote(source.remote);
  const want = normalizeRemote(source.remote);
  if (!source.trusted.map(normalizeRemote).includes(want)) {
    throw new UpdateSourceError(`update source ${source.remote} is not a trusted source`);
  }
}

function protocolArgs(source: TrustedSource): string[] {
  const allowFile = isLocalRemote(source.remote) || /^file:\/\//i.test(source.remote);
  return [
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.ssh.allow=always",
    "-c",
    `protocol.file.allow=${allowFile ? "always" : "never"}`,
  ];
}

/** The download cache: a bare repository private to the install root. */
export class SourceCache {
  readonly gitDir: string;

  constructor(gitDir: string) {
    this.gitDir = gitDir;
  }

  async ensure(): Promise<void> {
    if (existsSync(join(this.gitDir, "HEAD"))) return;
    await mkdir(dirname(this.gitDir), { recursive: true });
    await git(["init", "--quiet", "--bare", this.gitDir]);
  }

  /** Fetch branches and tags from the trusted remote into private namespaces. */
  async fetch(source: TrustedSource): Promise<void> {
    assertTrusted(source);
    await this.ensure();
    await git(
      [
        ...protocolArgs(source),
        "fetch",
        "--quiet",
        "--prune",
        "--no-recurse-submodules",
        "--",
        source.remote,
        "+refs/heads/*:refs/pi-src/heads/*",
        "+refs/tags/*:refs/pi-src/tags/*",
      ],
      { gitDir: this.gitDir, timeoutMs: 300_000 },
    );
  }

  private async refs(): Promise<Array<{ ref: string; sha: string }>> {
    const out = await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/pi-src/"], {
      gitDir: this.gitDir,
    });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [ref, sha] = l.split(" ");
        return { ref: ref as string, sha: sha as string };
      });
  }

  async commitOf(ref: string): Promise<string> {
    if (!/^refs\/pi-src\/(heads|tags)\/[A-Za-z0-9._/-]{1,200}$/.test(ref))
      throw new UpdateSourceError(`bad ref ${ref}`);
    const sha = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { gitDir: this.gitDir })).trim();
    if (!SHA.test(sha)) throw new UpdateSourceError(`ref ${ref} does not name a commit`);
    return sha;
  }

  /** Resolve a channel to a commit: main → the main branch; stable → the highest vX.Y.Z tag. */
  async resolveChannel(channel: UpdateChannel): Promise<{ sha: string; ref: string }> {
    if (channel === "main") {
      const ref = "refs/pi-src/heads/main";
      return { sha: await this.commitOf(ref), ref };
    }
    const tags = (await this.refs())
      .map((r) => r.ref.replace("refs/pi-src/tags/", ""))
      .filter((t) => STABLE_TAG.test(t))
      .sort((a, b) => compareTags(b, a));
    const best = tags[0];
    if (!best) throw new UpdateSourceError("no stable release tags (vX.Y.Z) on the update source");
    const ref = `refs/pi-src/tags/${best}`;
    return { sha: await this.commitOf(ref), ref };
  }

  /** Resolve a requested commit; it must be reachable from a fetched branch or tag (§46). */
  async resolveCommit(requested: string): Promise<{ sha: string; ref: string }> {
    const want = requested.trim().toLowerCase();
    if (!SHA_PREFIX.test(want)) throw new UpdateSourceError(`not a commit id: ${JSON.stringify(requested)}`);
    const r = await runGit(["rev-parse", "--verify", "--quiet", `${want}^{commit}`], { gitDir: this.gitDir });
    const sha = r.stdout.trim();
    if (r.code !== 0 || !SHA.test(sha)) throw new UpdateSourceError(`commit ${want} is not on the update source`);
    if (!sha.startsWith(want)) throw new UpdateSourceError(`commit ${want} resolved to a different commit ${sha}`);
    for (const { ref } of await this.refs()) {
      if (!SAFE_REF.test(ref.replace("refs/pi-src/", "refs/"))) continue;
      const anc = await runGit(["merge-base", "--is-ancestor", sha, ref], { gitDir: this.gitDir });
      if (anc.code === 0) return { sha, ref };
    }
    throw new UpdateSourceError(`commit ${sha} is not reachable from any branch or tag of the update source`);
  }

  /** Root commits of a commit's history: the repository's identity. */
  async rootsOf(sha: string): Promise<string[]> {
    const out = await git(["rev-list", "--max-parents=0", sha], { gitDir: this.gitDir });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => SHA.test(s));
  }

  /** The candidate must share a recorded root commit with the trusted repository. */
  async verifyIdentity(sha: string, identityRoots: string[]): Promise<void> {
    if (identityRoots.length === 0) return;
    const roots = await this.rootsOf(sha);
    if (!roots.some((r) => identityRoots.includes(r))) {
      throw new UpdateSourceError(`commit ${sha} does not belong to the trusted repository (unknown root commit)`);
    }
  }

  /** Read a file from a commit without checking anything out. */
  async readFile(sha: string, path: string): Promise<string> {
    if (!SHA.test(sha) || !/^[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) {
      throw new UpdateSourceError(`bad object path ${path}`);
    }
    return git(["show", `${sha}:${path}`], { gitDir: this.gitDir });
  }

  /** Validate every path in the commit's tree (§46: path traversal). */
  async validateTree(sha: string): Promise<number> {
    const out = await git(["ls-tree", "-r", "-z", "--full-tree", sha], { gitDir: this.gitDir });
    let count = 0;
    for (const entry of out.split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      const [mode, type, object] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      assertSafeTreePath(path);
      if (type === "commit" || mode === "160000") throw new UpdateSourceError(`submodule ${path} is not supported`);
      if (mode === "120000") {
        const target = await git(["cat-file", "blob", object as string], { gitDir: this.gitDir });
        assertSafeLink(path, target);
      }
      count++;
    }
    return count;
  }

  /** Export a commit's tree into an empty directory. */
  async exportTree(sha: string, target: string): Promise<void> {
    if (!SHA.test(sha)) throw new UpdateSourceError(`bad commit ${sha}`);
    await this.validateTree(sha);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    const index = join(target, "..", `.index-${sha.slice(0, 12)}-${process.pid}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await gitEnv(["read-tree", sha], this.gitDir, env);
      await gitEnv(["--work-tree", target, "checkout-index", "--all", "--force"], this.gitDir, env);
    } finally {
      await rm(index, { force: true });
    }
    assertContained(target);
  }
}

async function gitEnv(args: string[], gitDir: string, extra: Record<string, string>): Promise<void> {
  const env = { ...process.env, ...extra };
  delete env.GIT_SSL_NO_VERIFY;
  await new Promise<void>((resolveRun, reject) => {
    execFile(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=true", "--git-dir", gitDir, ...args],
      { env, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) reject(new UpdateSourceError(`git ${args.at(-3) ?? args[0]} failed: ${String(stderr).trim()}`));
        else resolveRun();
      },
    );
  });
}

export function assertSafeTreePath(path: string): void {
  const n = normalize(path);
  const parts = path.split("/");
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    n.startsWith("..") ||
    parts.some((p) => p === ".." || p === "." || p === "" || p.toLowerCase() === ".git")
  ) {
    throw new UpdateSourceError(`unsafe path in update tree: ${JSON.stringify(path)}`);
  }
}

export function assertSafeLink(path: string, target: string): void {
  if (isAbsolute(target)) throw new UpdateSourceError(`symlink ${path} points outside the tree (${target})`);
  const resolved = normalize(join(dirname(path), target));
  if (resolved === ".." || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) {
    throw new UpdateSourceError(`symlink ${path} points outside the tree (${target})`);
  }
}

/** Every entry under `root`, symlinks included, resolves inside `root`. */
export function assertContained(root: string): void {
  const base = realpathSync(root);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(full), readlinkSync(full));
        const rel = relative(base, target);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          throw new UpdateSourceError(`staged symlink ${relative(base, full)} escapes the staging tree`);
        }
      } else if (st.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(base);
}

function compareTags(a: string, b: string): number {
  const pa = (STABLE_TAG.exec(a) as RegExpExecArray).slice(1).map(Number);
  const pb = (STABLE_TAG.exec(b) as RegExpExecArray).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] as number) !== (pb[i] as number)) return (pa[i] as number) - (pb[i] as number);
  return 0;
}
