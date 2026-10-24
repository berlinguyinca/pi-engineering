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
 * Residual race (measured, documented, not hidden). The execution-relevant part of the repository config is listed
 * with `git config --list` and the command runs afterwards, so a worker that rewrites `.git/config` in that window
 * can still introduce a section that was not there when the policy was computed. What is done about it:
 *  - every driver name that an attributes file (info/attributes, any .gitattributes in the work tree) REFERENCES is
 *    neutralised up front whether or not a config section for it exists yet, so "attributes already there, config
 *    appears in the window" (the flip loop in test/unit/safe-git-race.test.ts) cannot run a driver: 0 hits in 300
 *    strict-mode runs, against 7 in 40 for the listing-only design;
 *  - strict mode points core.attributesFile at /dev/null;
 *  - after every command that can run a driver or touch the network the config is listed again; if the execution-
 *    relevant entries differ, the result is discarded (code 128, "changed while the command ran") and an error
 *    notice `git-config-changed-during-command` is emitted;
 *  - remote URLs are pinned per repository the first time Pi looks (see `pinProblem`).
 * Not closed: a worker that writes BOTH the attributes line and the config section inside the few milliseconds
 * between the listing and the command can still run one driver once; the post-command check then reports it, but
 * cannot undo it. Measured with both files flipping: see docs/architecture.md. A complete fix needs the worker not
 * to be able to write the shared `.git` at all (sandbox / read-only bind mount), which is outside this module.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { emitTelemetry } from "../telemetry/sink.ts";

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
 * neutralised through GIT_CONFIG_COUNT/KEY_n/VALUE_n set by safeGit itself (command scope outranks every config file, and a
 * key containing `=` survives, which `-c key=value` cannot carry); `core.gitProxy` is first-wins in git, so it is pinned with
 * GIT_PROXY_COMMAND instead. `diff`/`show`/`log` additionally get
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
  "GIT_PROXY_COMMAND",
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
const STRICT_ONLY_SETTINGS = ["core.sshCommand=ssh", "credential.helper=", "core.attributesFile=/dev/null"] as const;
const pairs = (list: readonly string[]) => list.flatMap((kv) => ["-c", kv]);

export const SAFE_GIT_CONFIG: readonly string[] = pairs([...STRICT_ONLY_SETTINGS, ...FORCED_SETTINGS]);
const OPERATOR_FORCED: readonly string[] = pairs(FORCED_SETTINGS);

const TRUSTED_SCOPES = new Set(["system", "global"]);

/** One `key = value` override. Carried in GIT_CONFIG_KEY_n/VALUE_n, never in a `-c key=value` argument (git splits that at the FIRST `=`, so a driver named `a=b` could not be addressed). */
export interface ConfigPair {
  key: string;
  value: string;
}

export interface ConfigEntry {
  scope: string;
  /** Path of the file the entry came from (`file:/x/.git/config`), or "" for command-line / environment entries. */
  origin: string;
  key: string;
  value: string;
}

/**
 * Parse `git config --list --show-scope --show-origin -z`: records `scope \0 origin \0 key \n value \0`.
 * A record that does not have all three fields is dropped (it cannot be classified).
 */
export function parseScopedConfig(out: string): ConfigEntry[] {
  const parts = out.split("\0");
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const rec = parts[i + 2] ?? "";
    const nl = rec.indexOf("\n");
    entries.push({
      scope: parts[i] ?? "",
      origin: parts[i + 1] ?? "",
      key: nl < 0 ? rec : rec.slice(0, nl),
      value: nl < 0 ? "" : rec.slice(nl + 1),
    });
  }
  return entries;
}

// ─── key classification ──────────────────────────────────────────────────────────────────────────────────────────
// A configuration key is `section[.subsection].variable`. Git's own rule: the section ends at the FIRST dot, the
// variable starts after the LAST dot, and everything between (any bytes except a newline, possibly empty) is the
// subsection, which is case-sensitive. Section and variable are case-insensitive. Classification is done on these
// parts, never by a regular expression over the whole key, so no subsection spelling can slip past a rule.

export interface ParsedKey {
  section: string;
  /** null when the key has no subsection; "" for `[filter ""]`. */
  sub: string | null;
  variable: string;
}

export function parseKey(key: string): ParsedKey | null {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first <= 0 || last === key.length - 1) return null;
  const section = key.slice(0, first).toLowerCase();
  const variable = key.slice(last + 1).toLowerCase();
  if (first === last) return { section, sub: null, variable };
  return { section, sub: key.slice(first + 1, last), variable };
}

/** Identity of a key as git sees it: case-insensitive section/variable, CASE-SENSITIVE subsection. */
export function keyId(p: ParsedKey): string {
  return `${p.section}\0${p.sub === null ? "N" : `S${p.sub}`}\0${p.variable}`;
}

const NEUTRAL_CORE: Record<string, string> = {
  sshcommand: "ssh",
  gitproxy: "false",
  askpass: "",
  alternaterefscommand: "true",
  editor: "true",
};

/** The harmless value that replaces a repository-defined execution vector, or null when the key is not one. */
export function neutralFor(p: ParsedKey): string | null {
  const { section, sub, variable } = p;
  switch (section) {
    case "filter":
      if (sub === null) return null;
      if (variable === "clean" || variable === "smudge" || variable === "process") return "";
      return variable === "required" ? "false" : null;
    case "diff":
      if (sub === null) return null;
      return variable === "textconv" ? "cat" : variable === "command" ? "" : null;
    case "merge":
      return sub !== null && variable === "driver" ? "" : null;
    case "trailer":
      return sub !== null && (variable === "command" || variable === "cmd") ? "" : null;
    case "core":
      return sub === null && variable in NEUTRAL_CORE ? (NEUTRAL_CORE[variable] as string) : null;
    case "sequence":
      return sub === null && variable === "editor" ? "true" : null;
    case "gpg":
      if (variable === "program") return "false";
      return sub === "ssh" && variable === "defaultkeycommand" ? "" : null;
    case "submodule":
      return sub !== null && variable === "update" ? "checkout" : null;
    case "lfs":
      // git-lfs runs `lfs.extension.<n>.clean|smudge` as filters and `lfs.customtransfer.<n>.path` as a transfer agent
      if (sub !== null && (sub.startsWith("extension.") || sub.startsWith("customtransfer."))) {
        return variable === "clean" || variable === "smudge" || variable === "path" || variable === "args" ? "" : null;
      }
      return null;
    default:
      return null;
  }
}

export const isCredentialHelper = (p: ParsedKey): boolean => p.section === "credential" && p.variable === "helper";

/**
 * Keys that decide WHERE a network command goes or what it sends, or that run a command on one. A `-c` override of
 * these is either ignored by git (first value wins) or unsafe (an empty `url.<x>.insteadOf` matches everything), so a
 * network command is refused while the repository (not the operator) defines one.
 */
export function refusesNetwork(p: ParsedKey): boolean {
  const { section, sub, variable } = p;
  switch (section) {
    case "remote":
      return (
        sub !== null &&
        (variable === "uploadpack" ||
          variable === "receivepack" ||
          variable === "vcs" ||
          variable === "proxy" ||
          variable === "proxyauthmethod")
      );
    case "http":
    case "protocol":
    case "url":
      return true;
    case "lfs":
      return (
        variable === "url" ||
        variable === "pushurl" ||
        variable === "access" ||
        variable === "standalonetransferagent" ||
        variable === "locksverify"
      );
    default:
      return false;
  }
}

const isRemoteUrl = (p: ParsedKey): boolean =>
  p.section === "remote" && p.sub !== null && (p.variable === "url" || p.variable === "pushurl");

const trustedScope = (e: ConfigEntry, trust: GitTrust): boolean => trust === "operator" && TRUSTED_SCOPES.has(e.scope);

/** The vectors a driver NAME taken from a gitattributes file can reach, per attribute. */
const ATTRIBUTE_VARIABLES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  filter: [
    ["clean", ""],
    ["smudge", ""],
    ["process", ""],
    ["required", "false"],
  ],
  diff: [
    ["textconv", "cat"],
    ["command", ""],
  ],
  merge: [["driver", ""]],
};

/**
 * `-c`-style overrides (as key/value pairs) that replace every execution vector the repository (any non-trusted scope)
 * defines, plus - for each driver name that an attributes file REFERENCES - the same neutral values even when no
 * config section for it exists yet. Naming the drivers up front is what keeps a section that appears between the
 * listing and the command from running (see "Residual race" in the header).
 *
 * In operator mode a key the operator's own system/global config defines keeps the operator's value. Pure.
 */
export function neutralisers(
  entries: readonly ConfigEntry[],
  trust: GitTrust,
  attributeDrivers: ReadonlyArray<readonly [string, string]> = [],
): ConfigPair[] {
  const out: ConfigPair[] = [];
  const done = new Set<string>();
  const trustedValues = (id: string): string[] =>
    entries
      .filter((t) => {
        if (!trustedScope(t, trust)) return false;
        const tp = parseKey(t.key);
        return tp !== null && keyId(tp) === id;
      })
      .map((t) => t.value);
  for (const e of entries) {
    if (trustedScope(e, trust)) continue;
    const p = parseKey(e.key);
    if (!p) continue;
    const id = keyId(p);
    if (done.has(id)) continue;
    if (isCredentialHelper(p)) {
      done.add(id);
      out.push({ key: e.key, value: "" });
      for (const v of trustedValues(id)) out.push({ key: e.key, value: v });
      continue;
    }
    const neutral = neutralFor(p);
    if (neutral === null) continue;
    done.add(id);
    const kept = trustedValues(id);
    out.push({ key: e.key, value: kept.length > 0 ? (kept[kept.length - 1] as string) : neutral });
  }
  for (const [kind, name] of attributeDrivers) {
    for (const [variable, neutral] of ATTRIBUTE_VARIABLES[kind] ?? []) {
      const p: ParsedKey = { section: kind, sub: name, variable };
      const id = keyId(p);
      if (done.has(id)) continue;
      done.add(id);
      const kept = trustedValues(id);
      out.push({
        key: `${kind}.${name}.${variable}`,
        value: kept.length > 0 ? (kept[kept.length - 1] as string) : neutral,
      });
    }
  }
  return out;
}

/** Repository-defined keys that make a network command unsafe (see `refusesNetwork`), by their spelling in the config. */
export function remoteExecKeys(entries: readonly ConfigEntry[], trust: GitTrust): string[] {
  return entries
    .filter((e) => {
      if (trustedScope(e, trust)) return false;
      const p = parseKey(e.key);
      return p !== null && refusesNetwork(p);
    })
    .map((e) => e.key);
}

/** Canonical text of every entry that matters to the policy (used to notice a change while a command ran). */
export function policyDigest(entries: readonly ConfigEntry[], trust: GitTrust): string {
  const rows: string[] = [];
  for (const e of entries) {
    if (trustedScope(e, trust)) continue;
    const p = parseKey(e.key);
    if (p && (neutralFor(p) !== null || isCredentialHelper(p) || refusesNetwork(p))) {
      rows.push(`${e.scope}\0${e.key}\0${e.value}`);
    }
  }
  return rows.sort().join("\u0001");
}

/** Remote URLs the repository defines, in a stable text form (for the pin). */
function remoteUrls(entries: readonly ConfigEntry[], trust: GitTrust): string {
  const rows: string[] = [];
  for (const e of entries) {
    if (trustedScope(e, trust)) continue;
    const p = parseKey(e.key);
    if (p && isRemoteUrl(p)) rows.push(`${e.key}\0${e.value}`);
  }
  return rows.sort().join("\u0001");
}

// ─── gitattributes: driver names ─────────────────────────────────────────────────────────────────────────────────

const MAX_ATTR_FILES = 4096;
const MAX_ATTR_BYTES = 1024 * 1024;
const MAX_ATTR_NAMES = 4096;

/** Pure: the `filter=`/`diff=`/`merge=` driver names a gitattributes text refers to. */
export function attributeDriverNames(text: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // the pattern is the first token (it may be a double-quoted string with spaces); the attributes follow
    let rest: string;
    if (line.startsWith('"')) {
      let i = 1;
      while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
      rest = line.slice(i + 1);
    } else {
      const m = /^\S+/.exec(line);
      rest = m ? line.slice(m[0].length) : "";
    }
    for (const token of rest.split(/[ \t]+/)) {
      const eq = token.indexOf("=");
      if (eq <= 0) continue;
      const kind = token.slice(0, eq);
      const name = token.slice(eq + 1);
      if ((kind === "filter" || kind === "diff" || kind === "merge") && name) found.push([kind, name]);
    }
  }
  return found;
}

/** Driver names referenced by info/attributes and every .gitattributes of the work tree (`nested` = the ls-files result). */
function attributeNames(
  entries: readonly ConfigEntry[],
  where: string,
  nested: SafeGitResult,
): { names: Array<[string, string]>; problem: string | null } {
  const files: string[] = [];
  const local = entries.find((e) => e.scope === "local" && e.origin.startsWith("file:"));
  if (local) files.push(join(dirname(resolve(where, local.origin.slice(5))), "info", "attributes"));
  if (nested.code !== 0 || nested.truncated) return { names: [], problem: "the attribute files cannot be listed" };
  for (const rel of nested.stdout.split("\0")) if (rel) files.push(resolve(where, rel));
  if (files.length > MAX_ATTR_FILES) return { names: [], problem: "too many attribute files to inspect" };
  const seen = new Set<string>();
  const names: Array<[string, string]> = [];
  for (const f of files) {
    let text: string;
    try {
      const st = statSync(f);
      if (!st.isFile()) continue;
      if (st.size > MAX_ATTR_BYTES) return { names, problem: "an attribute file is too large to inspect" };
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const [kind, name] of attributeDriverNames(text)) {
      const k = `${kind}\0${name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      names.push([kind, name]);
      if (names.length > MAX_ATTR_NAMES) return { names, problem: "too many attribute drivers to inspect" };
    }
  }
  return { names, problem: null };
}

// ─── running git ─────────────────────────────────────────────────────────────────────────────────────────────────

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
/** Network subcommands: refused while the repository defines a network-steering key, and while its remote URLs changed. */
const NETWORK_SUBCOMMANDS = new Set(["fetch", "pull", "push", "ls-remote", "clone", "remote", "submodule", "lfs"]);
/** Subcommands that can run an attribute-selected driver (filter, textconv, merge driver) or read the work tree through one. */
const DRIVER_SUBCOMMANDS = new Set([
  "add",
  "am",
  "apply",
  "archive",
  "blame",
  "cat-file",
  "checkout",
  "checkout-index",
  "cherry-pick",
  "clean",
  "commit",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "format-patch",
  "grep",
  "log",
  "merge",
  "merge-file",
  "mv",
  "pull",
  "read-tree",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "show",
  "stash",
  "status",
  "switch",
  "update-index",
  "worktree",
  "hash-object",
  "fetch",
  "push",
  "submodule",
]);

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

/** Test seam: runs between the plan and the command, so a test can edit the config exactly there. */
export const testHooks: { afterPlan?: () => void | Promise<void> } = {};

const failed = (stderr: string): SafeGitResult => ({ code: 128, stdout: "", stderr });

function spawnGit(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  opts: { cwd?: string; timeoutMs: number; maxBuffer: number; input?: string; signal?: AbortSignal },
): Promise<SafeGitResult> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", [...argv], {
        env,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      // E2BIG (argument or environment too large), ENOENT ...: a result, never a rejection
      resolvePromise(
        failed(`refused: git could not be started (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`),
      );
      return;
    }
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
    child.stdout?.on("data", take(out));
    child.stderr?.on("data", take(err));
    child.stdin?.on("error", () => {});
    child.on("error", (e) => {
      failure ||= e.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stderr = [Buffer.concat(err).toString("utf8"), failure].filter(Boolean).join("\n");
      resolvePromise({
        code: failure && code === null ? 1 : (code ?? 1),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr,
        ...(truncated ? { truncated } : {}),
      });
    });
    child.stdin?.end(opts.input ?? "");
  });
}

let configListMax = 64 * 1024 * 1024;
/** Test hook: shrink the config-listing buffer so the fail-closed path can be exercised cheaply. */
export function setConfigListLimitForTests(bytes: number): void {
  configListMax = bytes;
}

/** Config overrides as environment (GIT_CONFIG_COUNT/KEY_n/VALUE_n): a key may contain `=`, `.`, spaces, quotes. */
export function configEnv(pairs: readonly ConfigPair[]): Record<string, string> {
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach((c, i) => {
    out[`GIT_CONFIG_KEY_${i}`] = c.key;
    out[`GIT_CONFIG_VALUE_${i}`] = c.value;
  });
  return out;
}

/** Variables through which a caller or the ambient environment could inject config; removed before ours are set. */
export function withoutInjectedConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "GIT_CONFIG_COUNT" || k === "GIT_CONFIG_PARAMETERS" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** One environment entry may not exceed MAX_ARG_STRLEN (128 KiB) on Linux, and the total is bounded too. */
const MAX_PAIR_BYTES = 32 * 1024;
const MAX_PAIRS_BYTES = 512 * 1024;

export interface Plan {
  prefix: string[];
  config: ConfigPair[];
  extraEnv: Record<string, string>;
  remoteExec: string[];
  unreadable: string | undefined;
  /** policy digest of the listing this plan was built from (compared after the command) */
  digest: string;
  /** remote URLs at planning time (for the pin) and the repository the pin belongs to */
  pinKey: string;
  pinValue: string;
}

const unplanned = (unreadable: string): Plan => ({
  prefix: [],
  config: [],
  extraEnv: {},
  remoteExec: [],
  unreadable,
  digest: "",
  pinKey: "",
  pinValue: "",
});

/**
 * Pure: turn the config listing (or its failure) and the driver names found in attribute files into the plan.
 * `attrs` is null for subcommands that cannot run a driver.
 */
export function planFromListing(
  listed: SafeGitResult,
  cwd: string,
  trust: GitTrust,
  env: NodeJS.ProcessEnv,
  attrs: ReadonlyArray<readonly [string, string]> | null,
): Plan {
  // Fail closed: a listing that failed or was cut short (a worker can pad the shared config with junk keys) means the
  // neutralisers cannot be computed, and running the command anyway would run every planted driver.
  if (listed.code !== 0 || listed.truncated) {
    return unplanned(
      listed.truncated ? "the repository config is too large to inspect" : "the repository config is unreadable",
    );
  }
  const entries = parseScopedConfig(listed.stdout);
  // (A key cannot contain a newline: the listing ends a key at the first one, and the file syntax forbids it.)
  const config = neutralisers(entries, trust, attrs ?? []);
  let total = 0;
  for (const c of config) {
    const n = Buffer.byteLength(c.key) + Buffer.byteLength(c.value);
    if (n > MAX_PAIR_BYTES) return unplanned("a config key is too long to neutralise");
    total += n + 32;
  }
  if (total > MAX_PAIRS_BYTES) return unplanned("the repository config defines too many drivers to neutralise");
  // core.gitProxy: git keeps the FIRST value it reads and reads the environment variable before any config, so the
  // only reliable override is GIT_PROXY_COMMAND (a `-c core.gitProxy=` is ignored once the repository's value is read).
  // The operator's own proxy, from env or from trusted config, is kept; otherwise it is pinned to a no-op.
  const extraEnv: Record<string, string> = {};
  const operatorProxy =
    trust === "operator" &&
    (env.GIT_PROXY_COMMAND !== undefined ||
      entries.some((e) => {
        if (!TRUSTED_SCOPES.has(e.scope)) return false;
        const p = parseKey(e.key);
        return p !== null && p.section === "core" && p.sub === null && p.variable === "gitproxy";
      }));
  if (!operatorProxy) extraEnv.GIT_PROXY_COMMAND = "false";
  const local = entries.find((e) => e.scope === "local" && e.origin.startsWith("file:"));
  return {
    unreadable: undefined,
    prefix: [...(trust === "operator" ? OPERATOR_FORCED : SAFE_GIT_CONFIG), "-C", cwd],
    config,
    extraEnv,
    remoteExec: remoteExecKeys(entries, trust),
    digest: policyDigest(entries, trust),
    pinKey: local ? `file:${resolve(cwd, local.origin.slice(5))}` : "",
    pinValue: remoteUrls(entries, trust),
  };
}

const LISTING = ["config", "--list", "--show-scope", "--show-origin", "-z"];
const ATTR_LISTING = [
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
  "--",
  ":(top,glob)**/.gitattributes",
];

// Remote URLs as first seen per repository: a worker-writable `remote.origin.url` must not redirect Pi's credentials.
const remotePins = new Map<string, string>();
const MAX_PINS = 256;
export function forgetRemotePinsForTests(): void {
  remotePins.clear();
}

function pinProblem(plan: Plan, sub: string | undefined): string | null {
  if (!plan.pinKey) return null;
  if (sub === "remote" || sub === "config" || sub === "init" || sub === "clone") {
    remotePins.delete(plan.pinKey);
    return null;
  }
  const pinned = remotePins.get(plan.pinKey);
  if (pinned === undefined) {
    // Nothing to pin until the repository has a remote: adding the first one is how a remote is normally set up.
    if (plan.pinValue === "") return null;
    if (remotePins.size >= MAX_PINS) remotePins.delete(remotePins.keys().next().value as string);
    remotePins.set(plan.pinKey, plan.pinValue);
    return null;
  }
  if (sub && NETWORK_SUBCOMMANDS.has(sub) && pinned !== plan.pinValue) {
    return "this repository's remote URLs changed since Pi first used it";
  }
  return null;
}

function refusal(plan: Plan, args: readonly string[], at: number): SafeGitResult | null {
  if (plan.unreadable) return failed(`refused: ${plan.unreadable}`);
  const sub = args[at];
  if (sub && NETWORK_SUBCOMMANDS.has(sub) && plan.remoteExec.length > 0) {
    return failed(`refused: the repository config defines ${plan.remoteExec.slice(0, 5).join(", ")}`);
  }
  const pin = pinProblem(plan, sub);
  if (pin) return failed(`refused: ${pin}`);
  return null;
}

export function diffing(args: readonly string[], at: number): string[] {
  const sub = args[at];
  return sub && DIFFING.has(sub)
    ? [...args.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...args.slice(at + 1)]
    : [...args];
}

const watched = (sub: string | undefined): boolean =>
  sub !== undefined && (DRIVER_SUBCOMMANDS.has(sub) || NETWORK_SUBCOMMANDS.has(sub));

/** `-C <dir>` among git's own leading options moves the repository: read THAT repository's (and worktree's) config. */
function configRoot(args: readonly string[], at: number, cwd: string): string {
  let where = cwd;
  for (let i = 0; i < at; i++)
    if (args[i] === "-C" && args[i + 1] !== undefined) where = resolve(where, args[i + 1] as string);
  return where;
}

function tainted(): SafeGitResult {
  return failed(
    "refused: the repository config changed while the command ran; its result is discarded (a worker may be editing it)",
  );
}

function reportTaint(sub: string | undefined): void {
  emitTelemetry({
    level: "error",
    key: "git-config-changed-during-command",
    text: `git ${sub ?? ""}: the repository's execution-relevant config changed while the command ran; the result was discarded. Something is editing .git/config concurrently.`,
  });
}

export async function safeGit(args: readonly string[], opts: SafeGitOptions): Promise<SafeGitResult> {
  const trust = opts.trust ?? "strict";
  const env = withoutInjectedConfig({ ...safeGitEnv(process.env, trust), ...(opts.env ?? {}) });
  const at = subcommandIndex(args);
  const sub = args[at];
  const where = configRoot(args, at, opts.cwd);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const listOpts = { timeoutMs: Math.max(15_000, timeoutMs), maxBuffer: configListMax };
  const listed = await spawnGit(["-C", where, ...LISTING], env, listOpts);
  let attrs: Array<[string, string]> | null = null;
  if (DRIVER_SUBCOMMANDS.has(sub ?? "") && listed.code === 0 && !listed.truncated) {
    const nested = await spawnGit([...OPERATOR_FORCED, "-C", where, ...ATTR_LISTING], env, {
      ...listOpts,
      maxBuffer: 16 * 1024 * 1024,
    });
    const r = attributeNames(parseScopedConfig(listed.stdout), where, nested);
    if (r.problem) return failed(`refused: ${r.problem}`);
    attrs = r.names;
  }
  const plan = planFromListing(listed, opts.cwd, trust, env, attrs);
  const refused = refusal(plan, args, at);
  if (refused) return refused;
  await testHooks.afterPlan?.();
  const result = await spawnGit(
    [...plan.prefix, ...diffing(args, at)],
    { ...env, ...plan.extraEnv, ...configEnv(plan.config) },
    {
      timeoutMs,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );
  if (watched(sub)) {
    const after = await spawnGit(["-C", where, ...LISTING], env, listOpts);
    if (after.code === 0 && !after.truncated && policyDigest(parseScopedConfig(after.stdout), trust) !== plan.digest) {
      reportTaint(sub);
      return tainted();
    }
  }
  return result;
}

function runSync(argv: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number, maxBuffer: number): SafeGitResult {
  const r = spawnSync("git", [...argv], {
    env,
    timeout: timeoutMs,
    maxBuffer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "E2BIG" || code === "ENOENT") return failed(`refused: git could not be started (${code})`);
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: [r.stderr ?? "", r.error?.message ?? ""].filter(Boolean).join("\n"),
    ...(code === "ENOBUFS" ? { truncated: true } : {}),
  };
}

/** Longest time the synchronous variant blocks the event loop on its own config probes. */
const SYNC_PROBE_CAP_MS = 5_000;

/**
 * Synchronous twin of `safeGit` for the few callers that cannot be async (version/commit probes in the update host).
 * Same environment, neutralisers, refusals and post-command check. It blocks the event loop for as long as git runs,
 * so its own config probes are capped at 5 s and callers must pass a small `timeoutMs`.
 */
export function safeGitSync(args: readonly string[], opts: SafeGitOptions): SafeGitResult {
  const trust = opts.trust ?? "strict";
  const env = withoutInjectedConfig({ ...safeGitEnv(process.env, trust), ...(opts.env ?? {}) });
  const at = subcommandIndex(args);
  const sub = args[at];
  const where = configRoot(args, at, opts.cwd);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const probeMs = Math.min(SYNC_PROBE_CAP_MS, Math.max(1_000, timeoutMs));
  const listed = runSync(["-C", where, ...LISTING], env, probeMs, configListMax);
  let attrs: Array<[string, string]> | null = null;
  if (DRIVER_SUBCOMMANDS.has(sub ?? "") && listed.code === 0 && !listed.truncated) {
    const nested = runSync([...OPERATOR_FORCED, "-C", where, ...ATTR_LISTING], env, probeMs, 16 * 1024 * 1024);
    const r = attributeNames(parseScopedConfig(listed.stdout), where, nested);
    if (r.problem) return failed(`refused: ${r.problem}`);
    attrs = r.names;
  }
  const plan = planFromListing(listed, opts.cwd, trust, env, attrs);
  const refused = refusal(plan, args, at);
  if (refused) return refused;
  void testHooks.afterPlan?.();
  const result = runSync(
    [...plan.prefix, ...diffing(args, at)],
    { ...env, ...plan.extraEnv, ...configEnv(plan.config) },
    timeoutMs,
    opts.maxBuffer ?? 16 * 1024 * 1024,
  );
  if (watched(sub)) {
    const after = runSync(["-C", where, ...LISTING], env, probeMs, configListMax);
    if (after.code === 0 && !after.truncated && policyDigest(parseScopedConfig(after.stdout), trust) !== plan.digest) {
      reportTaint(sub);
      return tainted();
    }
  }
  return result;
}

/** The full argv prefix (before the subcommand) for one invocation, including repository-specific neutralisers (as `-c`, for display and tests). */
export async function safeGitPrefix(cwd: string, trust: GitTrust = "strict", env = safeGitEnv(process.env, trust)) {
  const listed = await spawnGit(["-C", cwd, ...LISTING], withoutInjectedConfig(env), {
    timeoutMs: 15_000,
    maxBuffer: configListMax,
  });
  const plan = planFromListing(listed, cwd, trust, env, null);
  return [...plan.prefix, ...plan.config.flatMap((c) => ["-c", `${c.key}=${c.value}`])];
}

/** Synchronous `safeGitOrThrow` returning stdout (operator trust unless stated); for the update host's probes. */
export function safeGitSyncOut(args: readonly string[], opts: SafeGitOptions): string {
  const r = safeGitSync(args, { trust: "operator", ...opts });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed (${r.code})`);
  return r.stdout;
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
