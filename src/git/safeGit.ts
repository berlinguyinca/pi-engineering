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
import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * Trust model (T16 H5). The repository's LOCAL and WORKTREE config, `info/attributes`, `.gitattributes` and hooks can
 * be written by the agent working in a linked worktree (they share the primary's `.git`). Two modes:
 *
 *  - `strict` (default): system and global config are ignored too (forks / promotion path).
 *  - `operator`: the operator's own system/global config is kept (identity, credential helpers, git-lfs, ssh
 *    settings) but every execution vector that the repo-local or worktree scope defines is replaced by the
 *    operator's value, or by a neutral one when the operator has none.
 *
 * Both modes: no hooks, no fsmonitor, no gpg, no external diff, no editor, no pager, and every `filter.*`
 * (clean/smudge/process), `diff.*.textconv`, `merge.*.driver`, `credential.*.helper`, `remote.*.uploadpack`,
 * `core.sshCommand`, `core.gitProxy`, `core.askpass`, `core.alternateRefsCommand` defined by the repository is
 * neutralised on the command line (which outranks every config file). `diff`/`show`/`log` additionally get
 * `--no-ext-diff --no-textconv`.
 *
 * Spawns that INTENTIONALLY run worker-authored commands are exempt and listed in `RAW_GIT_EXCEPTIONS`
 * (test/unit/safe-git-callers.test.ts enforces that no other source file spawns git directly).
 */

export type GitTrust = "strict" | "operator";

const KEEP_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SSH_AUTH_SOCK", "SYSTEMROOT"] as const;
/**
 * Extra variables kept in `operator` mode: Pi's own process environment belongs to the operator (a worker cannot
 * change it), so the operator's config isolation, CA bundle, transport and identity choices are honoured. Never
 * GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_EXTERNAL_DIFF / GIT_EDITOR / GIT_PAGER and the like.
 */
const OPERATOR_ENV = [
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_ALLOW_PROTOCOL",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_CERT",
  "GIT_SSL_KEY",
  "GIT_SSL_NO_VERIFY",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export function safeGitEnv(source: NodeJS.ProcessEnv = process.env, trust: GitTrust = "strict"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of KEEP_ENV) if (source[k] !== undefined) env[k] = source[k];
  if (trust === "operator") {
    for (const k of OPERATOR_ENV) if (source[k] !== undefined) env[k] = source[k];
  } else {
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = "/dev/null";
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "echo";
  // Strict mode pins the transports; in operator mode the operator's own GIT_ALLOW_PROTOCOL (if any) stands, and
  // `protocol.ext.allow=never` is forced on the command line either way.
  if (trust === "strict") env.GIT_ALLOW_PROTOCOL = "https:ssh:file";
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_EDITOR = "true";
  env.GIT_SEQUENCE_EDITOR = "true";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  return env;
}

const FORCED_SETTINGS = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "protocol.ext.allow=never",
  "core.pager=cat",
  "diff.external=",
  "gpg.program=false",
  "commit.gpgsign=false",
  "tag.gpgsign=false",
  "push.gpgsign=false",
  "log.showsignature=false",
  "merge.verifysignatures=false",
] as const;
/** Strict mode additionally pins ssh and credential settings, because it also ignores the operator's own config. */
const STRICT_ONLY_SETTINGS = ["core.sshCommand=ssh", "credential.helper="] as const;
const pairs = (list: readonly string[]) => list.flatMap((kv) => ["-c", kv]);

export const SAFE_GIT_CONFIG: readonly string[] = pairs([...STRICT_ONLY_SETTINGS, ...FORCED_SETTINGS]);
const OPERATOR_FORCED: readonly string[] = pairs(FORCED_SETTINGS);

const FILTER_KEY = /^filter\..+\.(clean|smudge|process)$/;
const NEUTRAL: ReadonlyArray<readonly [RegExp, (key: string) => string]> = [
  [FILTER_KEY, () => ""],
  [/^filter\..+\.required$/, () => "false"],
  [/^diff\..+\.textconv$/, () => "cat"],
  [/^diff\..+\.command$/, () => ""],
  [/^merge\..+\.driver$/, () => ""],
  [/^trailer\..+\.command$/, () => ""],
  [/^core\.sshcommand$/, () => "ssh"],
  [/^core\.gitproxy$/, () => ""],
  [/^core\.askpass$/, () => ""],
  [/^core\.alternaterefscommand$/, () => ""],
  [/^core\.editor$/, () => "true"],
  [/^sequence\.editor$/, () => "true"],
  [/^gpg(\..+)?\.program$/, () => "false"],
  [/^gpg\.ssh\.defaultkeycommand$/, () => ""],
];
/**
 * Per-remote commands that git runs for fetch/push/ls-remote and that a `-c` override cannot replace (git keeps the
 * first value it reads). Network subcommands are refused while the repository defines one.
 */
const REMOTE_EXEC_KEY = /^remote\..+\.(uploadpack|receivepack|vcs)$/;
const NETWORK_SUBCOMMANDS = new Set(["fetch", "pull", "push", "ls-remote", "clone", "remote", "submodule"]);
const CREDENTIAL_HELPER = /^credential(\..+)?\.helper$/;
const TRUSTED_SCOPES = new Set(["system", "global"]);

interface ConfigEntry {
  scope: string;
  key: string;
  value: string;
}

/** Parse `git config --list --show-scope -z`: records alternate `scope\0key\nvalue\0`. */
export function parseScopedConfig(out: string): ConfigEntry[] {
  const parts = out.split("\0");
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i] ?? "";
    const rec = parts[i + 1] ?? "";
    const nl = rec.indexOf("\n");
    entries.push({ scope, key: nl < 0 ? rec : rec.slice(0, nl), value: nl < 0 ? "" : rec.slice(nl + 1) });
  }
  return entries;
}

/**
 * `-c` overrides that replace every execution vector the repository (local / worktree / command scope) defines.
 * Pure: exported for tests.
 */
export function neutralisers(entries: readonly ConfigEntry[], trust: GitTrust): string[] {
  const trusted = (e: ConfigEntry) => trust === "operator" && TRUSTED_SCOPES.has(e.scope);
  const args: string[] = [];
  const done = new Set<string>();
  for (const e of entries) {
    if (trusted(e)) continue;
    const lower = e.key.toLowerCase();
    if (done.has(lower)) continue;
    if (CREDENTIAL_HELPER.test(lower)) {
      done.add(lower);
      args.push("-c", `${e.key}=`);
      for (const t of entries) if (trusted(t) && t.key.toLowerCase() === lower) args.push("-c", `${t.key}=${t.value}`);
      continue;
    }
    const rule = NEUTRAL.find(([re]) => re.test(lower));
    if (!rule) continue;
    done.add(lower);
    let value = rule[1](lower);
    for (const t of entries) if (trusted(t) && t.key.toLowerCase() === lower) value = t.value;
    args.push("-c", `${e.key}=${value}`);
  }
  return args;
}

/** Index of the subcommand, skipping git's own leading options (`-c k=v`, `-C dir`, `--no-pager` ...). */
export function subcommandIndex(args: readonly string[]): number {
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? "";
    if (a === "-c" || a === "-C" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") i += 2;
    else if (a.startsWith("-")) i += 1;
    else break;
  }
  return i;
}

const DIFFING = new Set(["diff", "show", "log"]);

export interface SafeGitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Output hit `maxBuffer`; `stdout` holds what was read before the process was stopped. */
  truncated?: boolean;
}

export interface SafeGitOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Default `strict`. `operator` keeps the operator's own system/global config (see the header). */
  trust?: GitTrust;
  /** Extra variables set by trusted code (for example GIT_INDEX_FILE). Applied last. */
  env?: Record<string, string>;
  /** Payload for stdin (hash-object, mktree ...). */
  input?: string;
  signal?: AbortSignal;
}

function spawnGit(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  opts: { cwd?: string; timeoutMs: number; maxBuffer: number; input?: string; signal?: AbortSignal },
): Promise<SafeGitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", [...argv], {
      env,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let failure = "";
    let truncated = false;
    const stop = (why: string) => {
      failure ||= why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(`killed (timeout ${opts.timeoutMs}ms)`), opts.timeoutMs);
    const take = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > opts.maxBuffer) {
        truncated = true;
        return stop("output exceeded maxBuffer");
      }
      into.push(chunk);
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      failure ||= e.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stderr = [Buffer.concat(err).toString("utf8"), failure].filter(Boolean).join("\n");
      resolve({
        code: failure && code === null ? 1 : (code ?? 1),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr,
        ...(truncated ? { truncated } : {}),
      });
    });
    child.stdin.end(opts.input ?? "");
  });
}

/** Config keys defined by the repository that would run a command on a network operation and cannot be overridden. */
export function remoteExecKeys(entries: readonly ConfigEntry[], trust: GitTrust): string[] {
  return entries
    .filter((e) => !(trust === "operator" && TRUSTED_SCOPES.has(e.scope)) && REMOTE_EXEC_KEY.test(e.key.toLowerCase()))
    .map((e) => e.key);
}

let configListMax = 64 * 1024 * 1024;
/** Test hook: shrink the config-listing buffer so the fail-closed path can be exercised cheaply. */
export function setConfigListLimitForTests(bytes: number): void {
  configListMax = bytes;
}

/** The full argv prefix (before the subcommand) for one invocation, including repository-specific neutralisers. */
export async function safeGitPrefix(cwd: string, trust: GitTrust = "strict", env = safeGitEnv(process.env, trust)) {
  return (await planGit(cwd, trust, env)).prefix;
}

async function planGit(cwd: string, trust: GitTrust, env: NodeJS.ProcessEnv, timeoutMs = 15_000) {
  const listed = await spawnGit(["-C", cwd, "config", "--list", "--show-scope", "-z"], env, {
    // Never shorter than the caller's own budget for the command: on a loaded host the listing is as slow as the command.
    timeoutMs: Math.max(15_000, timeoutMs),
    maxBuffer: configListMax,
  });
  // Fail closed: a listing that failed or was cut short (a worker can pad the shared config with junk keys) means the
  // neutralisers cannot be computed, and running the command anyway would run every planted driver.
  if (listed.code !== 0 || listed.truncated) {
    return {
      prefix: [] as string[],
      remoteExec: [] as string[],
      unreadable: listed.truncated
        ? "the repository config is too large to inspect"
        : "the repository config is unreadable",
    };
  }
  const entries = parseScopedConfig(listed.stdout);
  return {
    unreadable: undefined as string | undefined,
    prefix: [...(trust === "operator" ? OPERATOR_FORCED : SAFE_GIT_CONFIG), ...neutralisers(entries, trust), "-C", cwd],
    remoteExec: remoteExecKeys(entries, trust),
  };
}

export async function safeGit(args: readonly string[], opts: SafeGitOptions): Promise<SafeGitResult> {
  const trust = opts.trust ?? "strict";
  const env = { ...safeGitEnv(process.env, trust), ...(opts.env ?? {}) };
  const at = subcommandIndex(args);
  // `-C <dir>` among git's own leading options moves the repository: read THAT repository's (and worktree's) config.
  let where = opts.cwd;
  for (let i = 0; i < at; i++)
    if (args[i] === "-C" && args[i + 1] !== undefined) where = resolve(where, args[i + 1] as string);
  const { prefix, remoteExec, unreadable } = await planGit(where, trust, env, opts.timeoutMs ?? 60_000);
  if (unreadable) return { code: 128, stdout: "", stderr: `refused: ${unreadable}` };
  const sub = args[at];
  if (sub && NETWORK_SUBCOMMANDS.has(sub) && remoteExec.length > 0) {
    return { code: 128, stdout: "", stderr: `refused: the repository config defines ${remoteExec.join(", ")}` };
  }
  const argv =
    sub && DIFFING.has(sub)
      ? [...args.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...args.slice(at + 1)]
      : [...args];
  return spawnGit([...prefix, ...argv], env, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/** Like `safeGit` but rejects (message = git's stderr, `.code` = exit status) on a non-zero exit. */
export async function safeGitOrThrow(
  args: readonly string[],
  opts: SafeGitOptions,
): Promise<{ stdout: string; stderr: string }> {
  const r = await safeGit(args, opts);
  if (r.code !== 0) {
    throw Object.assign(new Error(r.stderr.trim() || r.stdout.trim() || `git ${args[0]} failed (${r.code})`), {
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

export interface RawSpawnException {
  /** `worker-command`: runs commands a worker authored (not git) with a scrubbed env. `git-plumbing`: raw git that only reads refs/config/blobs and never touches a worker tree's index or attributes. `pi-owned`: git against Pi's own install/cache or a throwaway repo it created. */
  kind: "worker-command" | "git-plumbing" | "pi-owned";
  why: string;
}

/**
 * Spawns that are deliberately NOT routed through safeGit. test/unit/safe-git-callers.test.ts fails when a new file
 * spawns `git` directly without an entry here, and when an entry here no longer matches anything (so the list
 * cannot rot). `worker-command` entries are not git spawns at all; they document the code that intentionally runs
 * worker-authored commands (package.json scripts, CI files, AGENTS.md, Makefile) and must use `workerCommandEnv`.
 */
export const RAW_GIT_EXCEPTIONS: Readonly<Record<string, RawSpawnException>> = {
  "src/lifecycle/verification.ts": {
    kind: "worker-command",
    why: "runs the project's own check commands - worker-authored code by design; env is scrubbed of Herdr/GitHub secrets with workerCommandEnv (T16 M14)",
  },
  "src/cav/runner.ts": {
    kind: "worker-command",
    why: "runs a caller-supplied deterministic test command; env scrubbed with workerCommandEnv",
  },
  "src/bar/scope.ts": { kind: "git-plumbing", why: "rev-parse HEAD only" },
  "src/blackhole/connectionSetup.ts": { kind: "git-plumbing", why: "rev-parse HEAD only" },
  "src/git/rustBuildCache.ts": { kind: "git-plumbing", why: "rev-parse --show-toplevel / --git-common-dir only" },
  "src/guard/primaryWorktreeGuard.ts": {
    kind: "git-plumbing",
    why: "rev-parse of the worker's cwd; the guard must see exactly what the worker's own git sees",
  },
  "src/integrations/autospec/provider.ts": {
    kind: "git-plumbing",
    why: "cat-file / show of a committed blob; never reads the worktree or index",
  },
  "src/runtime/host/extension.ts": {
    kind: "pi-owned",
    why: "Pi's own checkout: rev-parse, remote get-url, status for the version stamp",
  },
  "src/runtime/host/loader.ts": { kind: "git-plumbing", why: "rev-parse --absolute-git-dir" },
  "src/runtime/host/sourceWatch.ts": {
    kind: "pi-owned",
    why: "Pi's own checkout: follow-remote fetch under an unattended env that already pins ssh",
  },
  "src/runtime/isolation/WorktreeIdentity.ts": { kind: "git-plumbing", why: "rev-parse of toplevel / git dirs" },
  "src/update/gitSource.ts": {
    kind: "pi-owned",
    why: "Pi-owned --git-dir cache with its own -c hardening and scrubbed env",
  },
  "src/update/manager.ts": {
    kind: "pi-owned",
    why: "Pi's own install checkout: rev-list root / status for the dirty check",
  },
  "src/benchmark/PlannerWorkerBenchmark.ts": {
    kind: "pi-owned",
    why: "creates and inspects its own throwaway repository",
  },
};

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
