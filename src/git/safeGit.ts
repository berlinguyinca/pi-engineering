/**
 * One hardened way to run `git` against a repository whose configuration, hooks and attributes may have been
 * written by someone else (for example the agent working in a fork's worktree, which shares the repository's
 * `.git` directory with the original).
 *
 * What it closes:
 *  - the environment is rebuilt from a short allow-list: no inherited `GIT_*` (GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF,
 *    GIT_CONFIG_*, GIT_DIR ...), only what git and ssh need to run;
 *  - system and global config are not read (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null), so nothing in the
 *    caller's dotfiles redirects a command either;
 *  - command-line `-c` settings outrank every config file, so hooks (`core.hooksPath`), the filesystem monitor
 *    (`core.fsmonitor`, which runs a command on status), `core.sshCommand`, credential helpers and `ext::`
 *    transports are switched off for this invocation whatever the repository says;
 *  - only https, ssh and file transports are allowed.
 *
 * What it cannot close from the outside: repository-local `url.<base>.insteadOf` rewrites and `include` files can
 * still change where an unpinned remote points, and `filter.<name>.smudge|clean|process` drivers run on checkout.
 * Callers that push therefore pass an explicit, operator-pinned URL and refuse such config (see `rewriteKeys` in
 * `forkGit.ts`).
 */
import { execFile } from "node:child_process";

const KEEP_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SSH_AUTH_SOCK", "SYSTEMROOT"] as const;

export function safeGitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of KEEP_ENV) if (source[k] !== undefined) env[k] = source[k];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "echo";
  env.GIT_ALLOW_PROTOCOL = "https:ssh:file";
  env.LC_ALL = "C";
  return env;
}

export const SAFE_GIT_CONFIG: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.sshCommand=ssh",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
];

export interface SafeGitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SafeGitOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export function safeGit(args: readonly string[], opts: SafeGitOptions): Promise<SafeGitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...SAFE_GIT_CONFIG, "-C", opts.cwd, ...args],
      {
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        windowsHide: true,
        env: safeGitEnv(),
      },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Strip anything that could spoof or smuggle in a note built from git's stderr. */
export function tidyStderr(text: string, max = 200, lines = 2): string {
  const kept = text
    .split("\n")
    .map((l) => l.replace(/[^\x20-\x7e]/g, " ").trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" | ");
  return kept.slice(0, max);
}
