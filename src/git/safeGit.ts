/**
 * One hardened way to run `git` against a repository whose configuration, hooks and attributes may have been
 * written by someone else (for example the agent working in a fork's worktree, which shares the repository's
 * `.git` directory with the original).
 *
 * Design: an ALLOW-LIST, not a deny-list.
 *
 * The repository's own `config` is never handed to git. For every call safeGit
 *  1. finds the repository itself (walking up from the working directory, reading `.git`, `gitdir:` and `commondir`
 *     files - no git process, so `core.worktree` or `core.bare` in a planted config cannot redirect the search),
 *  2. lists the repository's `config` once (`git config --file`, which reads exactly one file and runs nothing),
 *  3. writes a GENERATED config into a private shadow common directory that contains only the keys on an explicit
 *     allow-list, each value validated, and symlinks to everything else in the real common directory (objects, refs,
 *     packed-refs, logs, worktrees ...), with an EMPTY `hooks` directory,
 *  4. runs git with `GIT_COMMON_DIR` = the shadow, `GIT_DIR` = the real per-worktree directory and `GIT_WORK_TREE`,
 *  5. afterwards moves into the real directory what git created in the shadow because it did not exist yet (`shallow`),
 *     maps the shadow path out of git's output and out of the files it wrote (worktree `.git` files), and replays the
 *     config entries that the command itself added or removed (`git remote add`, `git config`,
 *     `branch --set-upstream-to`, LFS auth) onto the real config. Refs, packed-refs, HEAD and the index are the REAL
 *     files: git takes them from the real per-worktree directory (and its `commondir` file), so their locks are the
 *     real locks.
 *
 * Consequences:
 *  - there is no window between "list the config" and "run the command": git reads the generated file, so a worker
 *    that rewrites `.git/config` (or adds an attributes file, a `.lfsconfig`, `core.attributesFile` ...) at any
 *    moment changes nothing for the command that is running. The flip loops in test/unit/safe-git-race.test.ts
 *    measure 0 hits in 400 runs per mode;
 *  - execution vectors are ABSENT instead of neutralised: no `filter.*`, `diff.*.textconv`, `merge.*.driver`,
 *    `credential.*.helper`, `core.fsmonitor`, `core.sshCommand`, `core.gitProxy`, `core.askpass`, `core.editor`,
 *    `core.attributesFile`, `core.hooksPath`, `core.alternateRefsCommand`, `gpg.*`, `submodule.*.update`,
 *    `remote.*.vcs|uploadpack|receivepack|proxy|promisor`, `extensions.partialclone`, `url.*.insteadOf`,
 *    `include*`, `lfs.*` (except `lfs.<url>.access`) reaches git, whatever their spelling (the allow-list never
 *    parses names to reject them), including keys this module has never heard of;
 *  - credentials cannot be steered to another host: `remote.<n>.url|pushurl` are checked against the first-seen pin
 *    (and the operator's optional `pi.allowedRemote` list), `branch.<b>.remote|pushRemote` and `remote.pushDefault`
 *    must name a remote that exists, `url.<x>.insteadOf` is not honoured, `http.*` / `credential.*` of the
 *    repository are not honoured;
 *  - the environment is rebuilt from a short allow-list (no inherited `GIT_*`), system and global config are not read
 *    in `strict` mode, and command-line settings switch off hooks, fsmonitor, signing, pagers, `ext::` transports,
 *    submodule recursion, auto-gc and the submodule status that would run a NESTED repository's own config.
 *
 * Nested repositories and submodules: a tracked gitlink whose directory holds its own `.git` makes `git add`,
 * `diff-files`, `diff-index` and `describe --dirty` spawn a child `git status` that reads THAT repository's config
 * (a filter there would run). The generated environment forces `diff.ignoreSubmodules=all` etc.; where that is not
 * enough, `--ignore-submodules=all` is added (diff-files, diff-index), the nested paths are excluded from `git add`
 * with `:(exclude)` pathspecs, and `describe --dirty` is refused while a nested repository exists.
 *
 * Limits (documented, not hidden): see docs/architecture.md. The shadow directory lives in the temp directory and is
 * removed after each call; it is not a security boundary against a worker that can already write the operator's
 * home directory, and a worker that can swap `.git` for a symlink between calls changes which repository is used
 * (the repository is re-discovered on every call, so that is the repository git would have used too).
 */
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { emitTelemetry } from "../telemetry/sink.ts";

/**
 * Trust model (T16 H5). The repository's LOCAL and WORKTREE config, `info/attributes`, `.gitattributes`, `.lfsconfig`
 * and hooks can be written by the agent working in a linked worktree (they share the primary's `.git`). Two modes:
 *
 *  - `strict` (default): system and global config are ignored too (forks / promotion path).
 *  - `operator`: the operator's own system/global config is kept (identity, credential helpers, git-lfs, ssh
 *    settings, `url.*.insteadOf`). The repository-local scope is the generated allow-list in both modes.
 *
 * Spawns that INTENTIONALLY run worker-authored commands are exempt and listed in `RAW_GIT_EXCEPTIONS`
 * (test/unit/safe-git-callers.test.ts enforces that no other source file spawns git directly).
 */

export type GitTrust = "strict" | "operator";

const KEEP_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SSH_AUTH_SOCK", "SYSTEMROOT"] as const;
/**
 * Extra variables kept in `operator` mode: Pi's own process environment belongs to the operator (a worker cannot
 * change it), so the operator's config isolation, CA bundle, transport and identity choices are honoured. Never
 * GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR / GIT_INDEX_FILE / GIT_EXTERNAL_DIFF / GIT_EDITOR / GIT_PAGER and the like.
 * (Pi's own environment is trusted; a variable that only a worker's shell could have set never reaches this list
 * because Pi does not run in the worker's shell.)
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
  // Both modes pin the transports (operator mode keeps an operator-supplied GIT_ALLOW_PROTOCOL, strict ignores it).
  // `protocol.ext.allow=never` is forced on the command line either way; the pin also stops `<helper>::<url>` remotes.
  if (trust === "strict") env.GIT_ALLOW_PROTOCOL = "https:ssh:file";
  else if (env.GIT_ALLOW_PROTOCOL === undefined) env.GIT_ALLOW_PROTOCOL = "https:http:ssh:file:git";
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
  // nested repositories / submodules: never let git start a child that reads another repository's config
  "submodule.recurse=false",
  "diff.submodule=log",
  "diff.ignoreSubmodules=all",
  "status.submoduleSummary=false",
  "fetch.recurseSubmodules=false",
  "push.recurseSubmodules=no",
  // a detached `gc --auto` would outlive the shadow directory it was started in
  "gc.auto=0",
  "gc.autoDetach=false",
  "maintenance.auto=false",
] as const;
/** Strict mode additionally pins ssh and credential settings, because it also ignores the operator's own config. */
const STRICT_ONLY_SETTINGS = ["core.sshCommand=ssh", "credential.helper=", "core.attributesFile=/dev/null"] as const;
const pairs = (list: readonly string[]) => list.flatMap((kv) => ["-c", kv]);

export const SAFE_GIT_CONFIG: readonly string[] = pairs([...STRICT_ONLY_SETTINGS, ...FORCED_SETTINGS]);
const OPERATOR_FORCED: readonly string[] = pairs(FORCED_SETTINGS);

const TRUSTED_SCOPES = new Set(["system", "global"]);

/** One `key = value` override. Carried in GIT_CONFIG_KEY_n/VALUE_n, never in a `-c key=value` argument (git splits that at the FIRST `=`). */
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
 * A record that does not have all three fields is dropped.
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

/** One entry of a single config file as `git config --file F --list -z` prints it. `value` is null for a bare boolean key. */
export interface FileEntry {
  key: string;
  value: string | null;
}

/** Parse `git config --file F --list -z`: records `key \n value \0` (no newline = a key without a value). */
export function parseFileConfig(out: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const rec of out.split("\0")) {
    if (rec === "") continue;
    const nl = rec.indexOf("\n");
    entries.push(nl < 0 ? { key: rec, value: null } : { key: rec.slice(0, nl), value: rec.slice(nl + 1) });
  }
  return entries;
}

// ─── key parsing ─────────────────────────────────────────────────────────────────────────────────────────────────
// A configuration key is `section[.subsection].variable`. Git's own rule: the section ends at the FIRST dot, the
// variable starts after the LAST dot, and everything between (any bytes except a newline, possibly empty) is the
// subsection, which is case-sensitive. Section and variable are case-insensitive.

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

// ─── the allow-list ──────────────────────────────────────────────────────────────────────────────────────────────

type Validator = (value: string | null) => string | null;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const SAFE_TEXT = /^[^\x00-\x08\x0a-\x1f\x7f]{0,4096}$/;
const text: Validator = (v) => (v !== null && SAFE_TEXT.test(v) ? v : null);
const BOOL = /^(true|false|yes|no|on|off|1|0)$/i;
const bool: Validator = (v) => (v === null ? "true" : BOOL.test(v) ? v : null);
const INT = /^\d{1,12}[kKmMgG]?$/;
const int: Validator = (v) => (v !== null && INT.test(v) ? v : null);
const oneOf =
  (...allowed: string[]): Validator =>
  (v) =>
    v !== null && allowed.includes(v.toLowerCase()) ? v : null;
const boolOr = (...more: string[]): Validator => {
  return (v) => (v === null ? "true" : BOOL.test(v) || more.includes(v.toLowerCase()) ? v : null);
};

/** Keys without a subsection: `section.variable`. Everything else is dropped. */
const ALLOWED_PLAIN: Record<string, Validator> = {
  "core.filemode": bool,
  "core.ignorecase": bool,
  "core.symlinks": bool,
  "core.logallrefupdates": boolOr("always"),
  "core.precomposeunicode": bool,
  "core.autocrlf": boolOr("input"),
  "core.eol": oneOf("lf", "crlf", "native"),
  "core.safecrlf": boolOr("warn"),
  "core.quotepath": bool,
  "core.trustctime": bool,
  "core.checkstat": oneOf("default", "minimal"),
  "core.untrackedcache": boolOr("keep"),
  "core.sparsecheckout": bool,
  "core.sparsecheckoutcone": bool,
  "core.compression": int,
  "core.loosecompression": int,
  "core.bigfilethreshold": int,
  "core.preloadindex": bool,
  "core.longpaths": bool,
  "core.abbrev": int,
  "core.warnambiguousrefs": boolOr("warn"),
  "core.fsync": text,
  "extensions.objectformat": oneOf("sha1", "sha256"),
  "extensions.compatobjectformat": oneOf("sha1", "sha256"),
  "extensions.refstorage": oneOf("files", "reftable"),
  "extensions.preciousobjects": bool,
  "extensions.noop": bool,
  "user.name": text,
  "user.email": text,
  "user.useconfigonly": bool,
  "push.default": oneOf("nothing", "current", "upstream", "tracking", "simple", "matching"),
  "push.autosetupremote": bool,
  "pull.rebase": boolOr("merges", "interactive"),
  "pull.ff": boolOr("only"),
  "merge.ff": boolOr("only"),
  "fetch.prune": bool,
  "fetch.prunetags": bool,
  "rebase.autostash": bool,
  "diff.renames": boolOr("copy", "copies"),
  "diff.algorithm": oneOf("default", "myers", "minimal", "patience", "histogram"),
  "merge.conflictstyle": oneOf("merge", "diff3", "zdiff3"),
  "rerere.enabled": bool,
  "init.defaultbranch": text,
};

/** Keys with a subsection: `section.*.variable` (the subsection is a branch / remote name, or a URL for lfs). */
const ALLOWED_SUB: Record<string, Validator> = {
  "branch.*.merge": text,
  "branch.*.rebase": boolOr("merges", "interactive"),
  "remote.*.fetch": text,
  "remote.*.push": text,
  "remote.*.tagopt": oneOf("--no-tags", "--tags"),
  "remote.*.prune": bool,
  "remote.*.prunetags": bool,
  "remote.*.mirror": bool,
  "remote.*.skipdefaultupdate": bool,
  "remote.*.skipfetchall": bool,
  // git-lfs records "basic" after a first authenticated request; the value picks no host (that is decided by the remote URL)
  "lfs.*.access": oneOf("basic", "none", "negotiate"),
};

/** `remote.<n>.url` / `pushurl`, `branch.<b>.remote|pushremote` and `remote.pushdefault` are handled specially (see `generateConfig`). */
const URL_VARIABLES = new Set(["url", "pushurl"]);

export interface Generated {
  /** The text of the generated `config` file. */
  text: string;
  /** What the generated file contains, as key/value rows (for the delta after the command). */
  kept: FileEntry[];
  /** Repository-local keys that were left out, as they were spelled. */
  dropped: string[];
  /** `remote.<n>.url|pushurl` as kept, canonical text (the pin). */
  remoteUrls: string;
  /** Every remote URL that was kept (for the operator allow-list). */
  urls: string[];
}

const ESC = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t");
const SECTION = /^[a-z][a-z0-9-]*$/i;

function emit(section: string, sub: string | null, variable: string, value: string | null): string {
  const head = sub === null ? `[${section}]` : `[${section} "${ESC(sub)}"]`;
  return value === null ? `${head}\n\t${variable}\n` : `${head}\n\t${variable} = "${ESC(value)}"\n`;
}

/**
 * Pure: build the generated repository config from the real one. `bare` decides `core.bare`.
 * Nothing is copied that is not on the allow-list; a value that fails its validator is dropped, not repaired.
 */
export function generateConfig(entries: readonly FileEntry[], bare: boolean): Generated {
  const kept: FileEntry[] = [];
  const dropped: string[] = [];
  const out: string[] = [];
  const parsed: Array<{ e: FileEntry; p: ParsedKey }> = [];
  for (const e of entries) {
    const p = parseKey(e.key);
    if (p) parsed.push({ e, p });
    else dropped.push(e.key);
  }
  const keep = (e: FileEntry, p: ParsedKey, value: string | null): void => {
    if (!SECTION.test(p.section) || !SECTION.test(p.variable)) {
      dropped.push(e.key);
      return;
    }
    if (p.sub !== null && /[\n\0]/.test(p.sub)) {
      dropped.push(e.key);
      return;
    }
    out.push(emit(p.section, p.sub, p.variable, value));
    kept.push({ key: e.key, value });
  };

  // remotes that exist (have a URL that survived validation): branch.*.remote may only name one of these
  const remoteNames = new Set<string>();
  for (const { e, p } of parsed) {
    if (p.section === "remote" && p.sub !== null && URL_VARIABLES.has(p.variable) && text(e.value) !== null) {
      remoteNames.add(p.sub);
    }
  }

  let version = "0";
  let extensions = false;
  for (const { e, p } of parsed) {
    const id = p.sub === null ? `${p.section}.${p.variable}` : `${p.section}.*.${p.variable}`;
    if (p.sub === null && p.section === "core" && p.variable === "repositoryformatversion") {
      if (e.value === "0" || e.value === "1") version = e.value;
      continue;
    }
    if (p.sub === null && p.section === "core" && p.variable === "bare") continue; // derived from where the repository was found
    if (p.sub !== null && p.section === "remote" && URL_VARIABLES.has(p.variable)) {
      const v = text(e.value);
      if (v === null || v === "") dropped.push(e.key);
      else keep(e, p, v);
      continue;
    }
    if (p.sub !== null && p.section === "branch" && (p.variable === "remote" || p.variable === "pushremote")) {
      const v = text(e.value);
      if (v !== null && (v === "." || remoteNames.has(v))) keep(e, p, v);
      else dropped.push(e.key);
      continue;
    }
    if (p.sub === null && p.section === "remote" && p.variable === "pushdefault") {
      const v = text(e.value);
      if (v !== null && remoteNames.has(v)) keep(e, p, v);
      else dropped.push(e.key);
      continue;
    }
    const validator = (p.sub === null ? ALLOWED_PLAIN : ALLOWED_SUB)[id];
    if (!validator) {
      dropped.push(e.key);
      continue;
    }
    const v = validator(e.value);
    if (v === null) {
      dropped.push(e.key);
      continue;
    }
    if (p.section === "extensions") extensions = true;
    keep(e, p, v);
  }
  const head = [
    emit("core", null, "repositoryformatversion", extensions ? "1" : version),
    emit("core", null, "bare", bare ? "true" : "false"),
  ];
  const urlRows = kept
    .filter((k) => {
      const p = parseKey(k.key);
      return p !== null && p.section === "remote" && p.sub !== null && URL_VARIABLES.has(p.variable);
    })
    .map((k) => `${k.key}\0${k.value ?? ""}`)
    .sort();
  return {
    text: head.join("") + out.join(""),
    kept,
    dropped,
    remoteUrls: urlRows.join("\u0001"),
    urls: kept
      .filter((k) => {
        const p = parseKey(k.key);
        return p !== null && p.section === "remote" && p.sub !== null && URL_VARIABLES.has(p.variable);
      })
      .map((k) => k.value ?? ""),
  };
}

/**
 * Pure: the changes a command made to the generated config, as (key, value) rows to remove and to add.
 * Multi-valued keys are compared as multisets; order is not meaningful.
 */
export function configDelta(
  before: readonly FileEntry[],
  after: readonly FileEntry[],
): { remove: FileEntry[]; add: FileEntry[] } {
  const keyOf = (e: FileEntry) => `${e.key}\0${e.value ?? ""}`;
  const count = (list: readonly FileEntry[]) => {
    const m = new Map<string, number>();
    for (const e of list) m.set(keyOf(e), (m.get(keyOf(e)) ?? 0) + 1);
    return m;
  };
  const missingFrom = (list: readonly FileEntry[], other: Map<string, number>): FileEntry[] => {
    const left = new Map(other);
    const rows: FileEntry[] = [];
    for (const e of list) {
      const n = left.get(keyOf(e)) ?? 0;
      if (n > 0) left.set(keyOf(e), n - 1);
      else rows.push(e);
    }
    return rows;
  };
  return { remove: missingFrom(before, count(after)), add: missingFrom(after, count(before)) };
}

/** Does this spelling look like something that runs a command or steers the network? (Only for the "ignored" notice.) */
const LOOKS_DANGEROUS =
  /(^|\.)(clean|smudge|process|textconv|driver|command|cmd|helper|hookspath|fsmonitor|sshcommand|gitproxy|askpass|uploadpack|receivepack|vcs|proxy|insteadof|pushinsteadof|partialclone|promisor|attributesfile|alternaterefscommand|editor|program|update|include|path|worktree|url)$/i;

// ─── finding the repository (no git process) ─────────────────────────────────────────────────────────────────────

export interface RepoLayout {
  /** The per-worktree git directory (real). */
  gitDir: string;
  /** The common git directory (real); equals `gitDir` for a main worktree or a bare repository. */
  commonDir: string;
  /** The work tree, or null for a bare repository. */
  workTree: string | null;
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

function looksLikeGitDir(d: string): boolean {
  if (!exists(join(d, "HEAD"))) return false;
  if (isFile(join(d, "commondir"))) return true;
  return isDir(join(d, "objects")) && isDir(join(d, "refs"));
}

/** Mirrors git's own search (`.git` directory, `.git` file, or the directory itself being a git directory) without running git. */
export function discoverRepo(
  start: string,
  devOf: (path: string) => number = (path) => statSync(path).dev,
): RepoLayout | null | "invalid" {
  let dir: string;
  let dev: number;
  try {
    dir = realpathSync(resolve(start));
    dev = devOf(dir);
  } catch {
    return null;
  }
  for (let depth = 0; depth < 4096; depth++) {
    const dot = join(dir, ".git");
    if (isDir(dot)) {
      // like git: a `.git` directory that is not a repository is skipped and the search goes on upward
      const here = finishLayout(dot, dir);
      if (here) return here;
    } else if (isFile(dot)) {
      // a `.git` FILE that is malformed or points nowhere is fatal for git, so it is refused here too
      let gitDir: string | null = null;
      try {
        const m = /^gitdir:[ \t]*([^\r\n]+)/.exec(readFileSync(dot, "utf8").slice(0, 4096));
        if (m) gitDir = resolve(dir, (m[1] as string).trim());
      } catch {
        /* unreadable */
      }
      return (gitDir !== null ? finishLayout(gitDir, dir) : null) ?? "invalid";
    }
    if (looksLikeGitDir(dir)) {
      const bare = finishLayout(dir, null);
      if (bare) return bare;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    // like git, do not cross a filesystem boundary while looking for a repository
    try {
      if (devOf(parent) !== dev) return null;
    } catch {
      return null;
    }
    dir = parent;
  }
  return null;
}

function finishLayout(gitDirIn: string, workTree: string | null): RepoLayout | null {
  try {
    const gitDir = realpathSync(gitDirIn);
    if (!looksLikeGitDir(gitDir)) return null;
    let commonDir = gitDir;
    const cd = join(gitDir, "commondir");
    if (isFile(cd)) commonDir = realpathSync(resolve(gitDir, readFileSync(cd, "utf8").trim()));
    if (!isDir(join(commonDir, "objects"))) return null;
    return { gitDir, commonDir, workTree: workTree === null ? null : realpathSync(workTree) };
  } catch {
    return null;
  }
}

// ─── subcommands ─────────────────────────────────────────────────────────────────────────────────────────────────

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
/** Network subcommands: refused while the remote URLs differ from the pin or the operator's allow-list. */
const NETWORK_SUBCOMMANDS = new Set(["fetch", "pull", "push", "ls-remote", "clone", "submodule", "lfs"]);
const SUBMODULE_NETWORK_VERBS = new Set(["update", "add", "sync", "set-url", "foreach"]);
/** `git remote <verb>`: only these verbs contact the remote (add / set-url / rename / remove / -v are local edits, and how Pi repairs a pin). */
const REMOTE_NETWORK_VERBS = new Set(["update", "prune", "show", "set-head"]);

/** Does this invocation contact a remote? */
export function contactsNetwork(args: readonly string[], at: number): boolean {
  const sub = args[at];
  if (sub === undefined) return false;
  if (NETWORK_SUBCOMMANDS.has(sub)) return true;
  if (sub !== "remote") return false;
  const verb = args.slice(at + 1).find((a) => !a.startsWith("-"));
  return verb !== undefined && REMOTE_NETWORK_VERBS.has(verb);
}

/** `--git-dir` / `--work-tree` among git's own options would redirect the repository away from the one that was inspected. */
export function redirectsRepository(args: readonly string[], at: number): boolean {
  for (let i = 0; i < at; i++) {
    const a = args[i] ?? "";
    if (a === "--git-dir" || a === "--work-tree" || a.startsWith("--git-dir=") || a.startsWith("--work-tree="))
      return true;
  }
  return false;
}

export function diffing(args: readonly string[], at: number): string[] {
  const sub = args[at];
  return sub && DIFFING.has(sub)
    ? [...args.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...args.slice(at + 1)]
    : [...args];
}

/** `-C <dir>` among git's own leading options moves the repository: read THAT repository's (and worktree's) config. */
function configRoot(args: readonly string[], at: number, cwd: string): string {
  let where = cwd;
  for (let i = 0; i < at; i++)
    if (args[i] === "-C" && args[i + 1] !== undefined) where = resolve(where, args[i + 1] as string);
  return where;
}

/** Commands that make git start a CHILD `git status` inside a tracked nested repository (measured, see the header). */
const FLAG_IGNORING = new Set(["diff-files", "diff-index"]);

/** Does `add` (or another selector) name anything? Appending `:(exclude)` pathspecs to a bare `git add` would stage everything. */
function addHasSelector(rest: readonly string[]): boolean {
  return rest.some(
    (a) => a === "-A" || a === "--all" || a === "-u" || a === "--update" || a === "--" || !a.startsWith("-"),
  );
}

/** Absolute literal pathspecs that exclude nested repositories from `git add`. */
export function excludePathspecs(nested: readonly string[]): string[] {
  return nested.map((p) => `:(exclude,top,literal)${p}`);
}

// ─── running git ─────────────────────────────────────────────────────────────────────────────────────────────────

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
  /** Start git in its own session (no controlling terminal), for unattended timers where nothing may prompt. Async only. */
  detached?: boolean;
}

/** Test seam: runs between the preparation (config snapshot) and the command, so a test can edit the repository exactly there. */
export const testHooks: { afterPlan?: () => void | Promise<void> } = {};

const failed = (stderr: string): SafeGitResult => ({ code: 128, stdout: "", stderr });

function spawnGit(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  opts: {
    cwd?: string;
    timeoutMs: number;
    maxBuffer: number;
    input?: string;
    signal?: AbortSignal;
    detached?: boolean;
  },
): Promise<SafeGitResult> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", [...argv], {
        env,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(opts.detached ? { detached: true } : {}),
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

function runSync(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBuffer: number,
  cwd?: string,
): SafeGitResult {
  const r: SpawnSyncReturns<string> = spawnSync("git", [...argv], {
    env,
    timeout: timeoutMs,
    maxBuffer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(cwd ? { cwd } : {}),
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

/** Variables through which a caller or the ambient environment could inject config or redirect the repository; removed before ours are set. */
export function withoutInjectedConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "GIT_CONFIG_COUNT" || k === "GIT_CONFIG_PARAMETERS" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) continue;
    if (k === "GIT_DIR" || k === "GIT_WORK_TREE" || k === "GIT_COMMON_DIR" || k === "GIT_CEILING_DIRECTORIES") continue;
    out[k] = v;
  }
  return out;
}

// ─── remote pin ──────────────────────────────────────────────────────────────────────────────────────────────────

// Remote URLs as first seen per repository (keyed by the REAL common directory, so a symlinked spelling is the same
// repository): a worker-writable `remote.origin.url` must not redirect Pi's credentials. Reads by Pi never clear it;
// only the delta of Pi's own successful write (`git remote add|set-url|rename|remove`, `git config remote.x.url`)
// moves it. The operator's `pi.allowedRemote` list (global/system git config, operator trust) survives restarts.
const remotePins = new Map<string, string>();
const MAX_PINS = 256;
export function forgetRemotePinsForTests(): void {
  remotePins.clear();
  allowCache = undefined;
  noticed.clear();
}

function setPin(key: string, value: string): void {
  if (!remotePins.has(key) && remotePins.size >= MAX_PINS) remotePins.delete(remotePins.keys().next().value as string);
  remotePins.set(key, value);
}

let allowCache: { at: number; key: string; list: string[] } | undefined;
const ALLOW_TTL_MS = 10_000;

/** The operator's `pi.allowedRemote` entries (system/global scope only), cached for a few seconds. */
function operatorAllowedRemotes(env: NodeJS.ProcessEnv): string[] {
  const key = `${env.HOME ?? ""}\0${env.XDG_CONFIG_HOME ?? ""}\0${env.GIT_CONFIG_GLOBAL ?? ""}\0${env.GIT_CONFIG_SYSTEM ?? ""}`;
  const now = Date.now();
  if (allowCache && allowCache.key === key && now - allowCache.at < ALLOW_TTL_MS) return allowCache.list;
  const r = runSync(["config", "--list", "--show-scope", "--show-origin", "-z"], env, 5_000, configListMax, tmpdir());
  const list =
    r.code === 0 && !r.truncated
      ? parseScopedConfig(r.stdout)
          .filter((e) => TRUSTED_SCOPES.has(e.scope) && e.key.toLowerCase() === "pi.allowedremote" && e.value !== "")
          .map((e) => e.value)
      : [];
  allowCache = { at: now, key, list };
  return list;
}

/** Exact match, or a prefix when the entry ends in `*`. */
export function remoteAllowed(url: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => (a.endsWith("*") ? url.startsWith(a.slice(0, -1)) : url === a));
}

// ─── per-call preparation and completion ─────────────────────────────────────────────────────────────────────────

interface Shadow {
  root: string;
  common: string;
}

interface Prepared {
  refused?: SafeGitResult;
  argv: string[];
  env: NodeJS.ProcessEnv;
  sub: string | undefined;
  layout: RepoLayout | null;
  shadow?: Shadow;
  generated?: Generated;
  pinBefore?: string | undefined;
  trust: GitTrust;
  cleanEnv: NodeJS.ProcessEnv;
}

const SHADOW_SKIP = new Set(["config", "hooks"]);
const DERIVED_KEYS = new Set(["core.repositoryformatversion", "core.bare"]);
const noticed = new Set<string>();

function makeShadow(layout: RepoLayout, configText: string): Shadow {
  const root = mkdtempSync(join(tmpdir(), "pi-safegit-"));
  const common = join(root, ".git");
  mkdirSync(common, { mode: 0o700 });
  try {
    for (const name of readdirSync(layout.commonDir)) {
      if (SHADOW_SKIP.has(name)) continue;
      symlinkSync(join(layout.commonDir, name), join(common, name));
    }
    mkdirSync(join(common, "hooks"));
    writeFileSync(join(common, "config"), configText, { mode: 0o600 });
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  return { root, common };
}

function gitlinksWithRepo(layout: RepoLayout, env: NodeJS.ProcessEnv): string[] | null {
  if (!layout.workTree) return [];
  const r = runSync(["ls-files", "--stage", "-z"], env, 5_000, 16 * 1024 * 1024, layout.workTree);
  if (r.code !== 0 || r.truncated) return null;
  const found: string[] = [];
  for (const rec of r.stdout.split("\0")) {
    const m = /^160000 [0-9a-f]+ \d\t(.+)$/s.exec(rec);
    if (!m) continue;
    const rel = m[1] as string;
    if (exists(join(layout.workTree, rel, ".git"))) found.push(rel);
  }
  return found;
}

function prepare(args: readonly string[], opts: SafeGitOptions): Prepared {
  const trust = opts.trust ?? "strict";
  const cleanEnv = withoutInjectedConfig({ ...safeGitEnv(process.env, trust), ...(opts.env ?? {}) });
  const at = subcommandIndex(args);
  const sub = args[at];
  const where = configRoot(args, at, opts.cwd);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const prefix = [...(trust === "operator" ? OPERATOR_FORCED : SAFE_GIT_CONFIG), "-C", opts.cwd];
  const base: Prepared = { refused: undefined, argv: [], env: cleanEnv, sub, layout: null, trust, cleanEnv };
  const refuse = (why: string): Prepared => ({ ...base, refused: failed(`refused: ${why}`) });
  if (redirectsRepository(args, at))
    return refuse("--git-dir / --work-tree would point git at a repository that was not inspected");

  // URLs that come from the work tree (.gitmodules) rather than from config cannot be allow-listed: no submodule fetching at all
  if (sub === "submodule" && args.slice(at + 1).some((a) => SUBMODULE_NETWORK_VERBS.has(a))) {
    return refuse("submodule update/add/sync use URLs from .gitmodules, which whoever works in the tree controls");
  }
  if (args.some((a) => a === "--recurse-submodules" || a.startsWith("--recurse-submodules=") || a === "--recursive")) {
    return refuse("recursing into submodules would use URLs from .gitmodules and run nested repositories' own config");
  }

  // no repository to defend (git init / clone, or not inside one): nothing local to read, and never an enclosing one
  const found = sub === "init" || sub === "clone" ? null : discoverRepo(where);
  // A `.git` that is there but is not a usable repository is refused: running git without a shadow would let it read it as is.
  if (found === "invalid") return refuse("the repository at this path is not usable (broken .git)");
  const layout = found;
  if (!layout) {
    // Nothing found, so git must not find anything either (an enclosing repository would be read unfiltered).
    const env = { ...cleanEnv };
    try {
      env.GIT_CEILING_DIRECTORIES = dirname(realpathSync(where));
    } catch {
      /* where does not exist: git will say so */
    }
    return { ...base, env, argv: [...prefix, ...diffing(args, at)] };
  }

  // 1. snapshot the repository's own config (one file, no includes, runs nothing)
  const realConfig = join(layout.commonDir, "config");
  let entries: FileEntry[] = [];
  if (exists(realConfig)) {
    const listed = runSync(
      ["config", "--file", realConfig, "--list", "-z"],
      cleanEnv,
      Math.min(5_000, Math.max(1_000, timeoutMs)),
      configListMax,
      tmpdir(),
    );
    // Fail closed: a listing that failed or was cut short (a worker can pad the shared config with junk keys) means
    // the allow-list cannot be applied, and running anyway would hand git the unfiltered file.
    if (listed.code !== 0 || listed.truncated) {
      return refuse(
        listed.truncated ? "the repository config is too large to inspect" : "the repository config is unreadable",
      );
    }
    entries = parseFileConfig(listed.stdout);
  }
  const generated = generateConfig(entries, layout.workTree === null);

  // 2. network refusals: remote URLs must match the pin / the operator's list
  const pinKey = layout.commonDir;
  const pinned = remotePins.get(pinKey);
  if (contactsNetwork(args, at)) {
    if (pinned !== undefined && pinned !== generated.remoteUrls) {
      return refuse("this repository's remote URLs changed since Pi first used it");
    }
    if (trust === "operator") {
      const allowed = operatorAllowedRemotes(cleanEnv);
      const bad = allowed.length > 0 ? generated.urls.find((u) => !remoteAllowed(u, allowed)) : undefined;
      if (bad !== undefined)
        return refuse("a remote URL of this repository is not in the operator's pi.allowedRemote list");
    }
    // LFS reads `.lfsconfig` from the work tree (lfs.url / pushurl): a worker-controlled endpoint would receive credentials
    if (sub === "lfs" && layout.workTree && exists(join(layout.workTree, ".lfsconfig"))) {
      return refuse("the work tree has a .lfsconfig, which can point git-lfs at another server");
    }
  }

  // 3. the shadow
  let shadow: Shadow;
  try {
    shadow = makeShadow(layout, generated.text);
  } catch (e) {
    return refuse(
      `could not prepare an isolated git view (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`,
    );
  }
  const env: NodeJS.ProcessEnv = { ...cleanEnv, GIT_DIR: layout.gitDir, GIT_COMMON_DIR: shadow.common };
  if (layout.workTree) env.GIT_WORK_TREE = layout.workTree;
  if (layout.workTree && exists(join(layout.workTree, ".lfsconfig"))) env.GIT_LFS_SKIP_SMUDGE = "1";

  // 4. nested repositories
  let argv = diffing(args, at);
  if (sub !== undefined && (FLAG_IGNORING.has(sub) || sub === "add" || sub === "describe")) {
    if (FLAG_IGNORING.has(sub)) {
      argv = [...argv.slice(0, at + 1), "--ignore-submodules=all", ...argv.slice(at + 1)];
    } else {
      const nested = gitlinksWithRepo(layout, env);
      if (nested === null) {
        rmSync(shadow.root, { recursive: true, force: true });
        return refuse("the index cannot be inspected for nested repositories");
      }
      if (nested.length > 0) {
        const rest = args.slice(at + 1);
        if (
          sub === "describe" &&
          rest.some((a) => a === "--dirty" || a.startsWith("--dirty=") || a === "--broken" || a.startsWith("--broken="))
        ) {
          rmSync(shadow.root, { recursive: true, force: true });
          return refuse(`describe --dirty would run the configuration of the nested repository at ${nested[0]}`);
        }
        if (sub === "add") {
          if (rest.some((a) => a === "--pathspec-from-file" || a.startsWith("--pathspec-from-file="))) {
            rmSync(shadow.root, { recursive: true, force: true });
            return refuse(`add --pathspec-from-file cannot exclude the nested repository at ${nested[0]}`);
          }
          if (addHasSelector(rest))
            argv = [...argv, ...(rest.includes("--") ? [] : ["--"]), ...excludePathspecs(nested)];
        }
      }
    }
  }
  return {
    ...base,
    env,
    layout,
    shadow,
    generated,
    pinBefore: pinned,
    // with GIT_COMMON_DIR set git no longer learns `core.bare` from the config it reads, so a bare repository is declared
    argv: [...(layout.workTree === null ? ["--bare"] : []), ...prefix, ...argv],
  };
}

function notifyIgnored(layout: RepoLayout, generated: Generated): void {
  const bad = generated.dropped.filter((k) => LOOKS_DANGEROUS.test(k));
  if (bad.length === 0) return;
  const id = `${layout.commonDir}\0${bad.slice().sort().join("\0")}`;
  if (noticed.has(id)) return;
  if (noticed.size >= 256) noticed.clear();
  noticed.add(id);
  emitTelemetry({
    level: "info",
    key: "git-repo-config-ignored",
    text: `git: ignoring ${bad.length} repository-local config key(s) in ${basename(dirname(layout.commonDir)) || layout.commonDir} that could run a command or redirect the network: ${tidyStderr(bad.slice(0, 6).join(", "), 160, 1)}`,
  });
}

function moveBack(from: string, to: string): void {
  const st = lstatSync(from);
  if (st.isDirectory()) {
    cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
    return;
  }
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const tmp = `${to}.pi-safegit-${process.pid}`;
    copyFileSync(from, tmp);
    renameSync(tmp, to);
  }
}

/**
 * Whatever git left in the shadow as a regular file or directory instead of a symlink (a file it created because it
 * did not exist yet, such as `shallow`) belongs in the real common directory. Refs, packed-refs and the index are not
 * among them: git takes those from the real per-worktree directory (and its `commondir` file), not from the shadow.
 */
function writeBack(p: Prepared): string | null {
  const layout = p.layout as RepoLayout;
  const shadow = p.shadow as Shadow;
  for (const name of readdirSync(shadow.common)) {
    if (SHADOW_SKIP.has(name) || name.endsWith(".lock")) continue;
    const from = join(shadow.common, name);
    if (lstatSync(from).isSymbolicLink()) continue;
    moveBack(from, join(layout.commonDir, name));
  }
  return null;
}

/** A worktree's `.git` file written by `git worktree add` names the shadow directory; point it at the real one. */
function fixWorktreeLinks(p: Prepared): void {
  const layout = p.layout as RepoLayout;
  const shadow = p.shadow as Shadow;
  const dir = join(layout.commonDir, "worktrees");
  let names: string[];
  try {
    names = readdirSync(dir).slice(0, 4096);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const pointer = readFileSync(join(dir, name, "gitdir"), "utf8").trim();
      if (!pointer.endsWith("/.git") || !isFile(pointer)) continue;
      const body = readFileSync(pointer, "utf8");
      if (!body.includes(shadow.root)) continue;
      writeFileSync(pointer, body.split(shadow.common).join(layout.commonDir));
    } catch {
      /* a stale or foreign entry: leave it alone */
    }
  }
}

function mapOut(s: string, p: Prepared): string {
  const layout = p.layout as RepoLayout;
  const shadow = p.shadow as Shadow;
  if (!s.includes(shadow.root)) return s;
  let out = s.split(shadow.common).join(layout.commonDir);
  if (basename(layout.commonDir) === ".git") out = out.split(shadow.root).join(dirname(layout.commonDir));
  return out;
}

const gitConfigFile = (file: string, args: readonly string[], env: NodeJS.ProcessEnv): SafeGitResult =>
  runSync(["config", "--file", file, ...args], env, 5_000, configListMax, tmpdir());

/** Replay what the command wrote to the (generated) config onto the real one. Returns what changed, or null when nothing did. */
function replayConfig(p: Prepared): { after: FileEntry[]; remove: FileEntry[]; add: FileEntry[] } | null {
  const layout = p.layout as RepoLayout;
  const shadow = p.shadow as Shadow;
  const generated = p.generated as Generated;
  const path = join(shadow.common, "config");
  let now: string;
  try {
    now = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (now === generated.text) return null;
  const listed = gitConfigFile(path, ["--list", "-z"], p.cleanEnv);
  if (listed.code !== 0 || listed.truncated) {
    emitTelemetry({
      level: "error",
      key: "git-config-writeback-failed",
      text: "git: the config written by a command could not be read back; its config changes were not applied to the repository.",
    });
    return null;
  }
  // the two derived keys (see generateConfig) are never replayed: where the repository lives is not config
  const after = parseFileConfig(listed.stdout).filter((e) => !DERIVED_KEYS.has(e.key.toLowerCase()));
  const real = join(layout.commonDir, "config");
  const { remove, add } = configDelta(generated.kept, after);
  for (const e of remove) {
    gitConfigFile(real, ["--fixed-value", "--unset", e.key, e.value ?? ""], p.cleanEnv);
  }
  for (const e of add) {
    gitConfigFile(real, ["--add", e.key, e.value ?? "true"], p.cleanEnv);
  }
  return { after, remove, add };
}

const isUrlRow = (e: FileEntry): boolean => {
  const k = parseKey(e.key);
  return k !== null && k.section === "remote" && k.sub !== null && URL_VARIABLES.has(k.variable);
};
const pinRow = (e: FileEntry): string => `${e.key}\0${e.value ?? ""}`;

/** Apply Pi's own URL edits to a pin: only what the command changed, never what a worker left lying around. */
export function applyPinDelta(pin: string, remove: readonly FileEntry[], add: readonly FileEntry[]): string {
  const rows = pin === "" ? [] : pin.split("\u0001");
  for (const e of remove.filter(isUrlRow)) {
    const i = rows.indexOf(pinRow(e));
    if (i >= 0) rows.splice(i, 1);
  }
  for (const e of add.filter(isUrlRow)) rows.push(pinRow(e));
  return rows.sort().join("\u0001");
}

function complete(p: Prepared, result: SafeGitResult): SafeGitResult {
  if (!p.shadow || !p.layout || !p.generated) return result;
  const layout = p.layout;
  const shadow = p.shadow;
  let out = result;
  try {
    let problem: string | null = null;
    try {
      problem = writeBack(p);
    } catch (e) {
      problem = `moving the command's files back into the repository failed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
    }
    let changed: ReturnType<typeof replayConfig> = null;
    try {
      changed = replayConfig(p);
      if (p.sub === "worktree") fixWorktreeLinks(p);
    } catch (e) {
      problem ??= `finishing the command's repository changes failed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
    }
    // Pi's own edit of a remote URL moves the pin by exactly what the command changed; a read, or a worker's edit, never does
    const current = remotePins.get(layout.commonDir);
    const base = current ?? (p.generated as Generated).remoteUrls;
    const next = changed ? applyPinDelta(base, changed.remove, changed.add) : base;
    // nothing to pin until the repository has a remote: adding the first one is how a remote is normally set up
    if (current === undefined ? next !== "" : next !== current) setPin(layout.commonDir, next);
    notifyIgnored(layout, p.generated as Generated);
    out = {
      ...result,
      stdout: mapOut(result.stdout, p),
      stderr: mapOut(result.stderr, p),
    };
    if (problem) {
      emitTelemetry({ level: "error", key: "git-writeback-failed", text: `git ${p.sub ?? ""}: ${problem}.` });
      out = {
        ...out,
        code: out.code === 0 ? 128 : out.code,
        stderr: [out.stderr, `warning: ${problem}`].filter(Boolean).join("\n"),
      };
    }
  } finally {
    rmSync(shadow.root, { recursive: true, force: true });
  }
  return out;
}

export async function safeGit(args: readonly string[], opts: SafeGitOptions): Promise<SafeGitResult> {
  const p = prepare(args, opts);
  if (p.refused) return p.refused;
  try {
    await testHooks.afterPlan?.();
    const result = await spawnGit(p.argv, p.env, {
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.detached ? { detached: true } : {}),
    });
    return complete(p, result);
  } catch (e) {
    if (p.shadow) rmSync(p.shadow.root, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Synchronous twin of `safeGit` for the few callers that cannot be async (version/commit probes in the update host).
 * Same environment, allow-list, refusals and write-back. It blocks the event loop for as long as git runs, so callers
 * must pass a small `timeoutMs`.
 */
export function safeGitSync(args: readonly string[], opts: SafeGitOptions): SafeGitResult {
  const p = prepare(args, opts);
  if (p.refused) return p.refused;
  try {
    void testHooks.afterPlan?.();
    const result = runSync(p.argv, p.env, opts.timeoutMs ?? 60_000, opts.maxBuffer ?? 16 * 1024 * 1024);
    return complete(p, result);
  } catch (e) {
    if (p.shadow) rmSync(p.shadow.root, { recursive: true, force: true });
    throw e;
  }
}

/** The argv prefix (before the subcommand) for one invocation: the forced command-line settings and `-C`. For display and tests. */
export async function safeGitPrefix(cwd: string, trust: GitTrust = "strict"): Promise<string[]> {
  return [...(trust === "operator" ? OPERATOR_FORCED : SAFE_GIT_CONFIG), "-C", cwd];
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
