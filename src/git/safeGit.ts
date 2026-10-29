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
 *  3. writes a GENERATED config into a private shadow common directory (under the Pi state directory, 0700, see
 *     safeGitState.ts) that contains only the keys on an explicit allow-list, each value validated, and symlinks to
 *     everything else in the real common directory (objects, refs, packed-refs, logs, worktrees ...), with an EMPTY
 *     `hooks` directory and an empty, generated `info/attributes` (attributes are cut off at the source, see
 *     safeGitAttrs.ts; the shadow is read-only while git runs unless the command may write config, and verified
 *     afterwards),
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
 * Before any of that, Pi refuses the call when a symbolic link or special file sits where git expects a plain file
 * (safeGitTree.ts), when the work tree now names another repository than the one Pi saw it use, when a local-path or
 * helper remote is not on the operator's `pi.allowedRemote` list, and when the repository belongs to another user.
 *
 * Limits (documented, not hidden): see docs/architecture.md. A worker that runs as the same user and can write Pi's
 * private state directory or the operator's home directory is outside what this module can enforce (it needs a worker
 * sandbox); the shadow directory is removed after each call and is not a security boundary of its own.
 */
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
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
import { generateLfsAttributes } from "./safeGitAttrs.ts";
import {
  forgetPinsForTests,
  makeShadowRoot,
  markShadowDone,
  pinStore,
  removeShadow,
  sweepOnce,
} from "./safeGitState.ts";
import { UNBOUNDED_SCAN, scanRepoTreeDetailed } from "./safeGitTree.ts";

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

/** The empty tree: git knows it without the object being present. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
  // `file` (a local path or file:// remote) is NOT allowed by default: a local remote is another repository whose hooks
  // `receive-pack` / `upload-pack` would run, so it is enabled per call, and only for a URL on the operator's allow-list.
  if (trust === "strict") env.GIT_ALLOW_PROTOCOL = "https:ssh";
  else if (env.GIT_ALLOW_PROTOCOL === undefined) env.GIT_ALLOW_PROTOCOL = "https:http:ssh:git";
  env.GIT_ATTR_NOSYSTEM = "1";
  // no attribute from the work tree, the index or a tree applies (see safeGitAttrs.ts): no driver can be selected
  env.GIT_ATTR_SOURCE = EMPTY_TREE;
  env.GIT_EDITOR = "true";
  env.GIT_SEQUENCE_EDITOR = "true";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  return env;
}

const FORCED_SETTINGS = [
  "core.hooksPath=/dev/null",
  "core.attributesFile=/dev/null",
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
const STRICT_ONLY_SETTINGS = ["core.sshCommand=ssh", "credential.helper="] as const;
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
  /**
   * The common git directory the caller knows this call belongs to. When the repository found from `cwd` has a
   * different one (a worktree's `.git` file rewritten to name another repository), the call is refused.
   */
  expectCommonDir?: string;
}

/** Test seam: runs between the preparation (config snapshot) and the command, so a test can edit the repository exactly there. */
export const testHooks: {
  afterPlan?: () => void | Promise<void>;
  /** Tests only: treat local-path / file:// remotes as allow-listed (the test repositories use local bare remotes). */
  localTransports?: boolean;
  /** Tests only: make the write-back after a command fail (the rollback path). */
  failWriteBack?: boolean;
  /** Tests only: fail AFTER the files were moved back (a partial write-back). */
  failWriteBackAfter?: boolean;
  /** Tests only: the text `git --version` is taken to print (null: ask git). */
  gitVersion?: string;
  /** Tests only: runs right after the shadow exists, before Pi's own internal git calls (nested-repo check) use it. */
  afterShadow?: (shadowRoot: string) => void;
  /** Tests only: the user id the ownership check compares against (a repository cannot be chowned without privileges). */
  uid?: number;
  /**
   * Tests only: called each time the repository's own config is listed FROM GIT.
   * That listing is the per-call cost the cache removes, so counting it is how the
   * cache is pinned: once per changed config, not once per call.
   */
  onConfigList?: () => void;
  /** Tests only: called with the argv of every git child Pi starts (async or sync), so a test can count spawns. */
  onSpawn?: (argv: readonly string[]) => void;
} = {};

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
    testHooks.onSpawn?.(argv);
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
  testHooks.onSpawn?.(argv);
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
// moves it. Pins are PERSISTED (pins.json in the private state directory, atomic, 0600), so a restart does not
// forget them; `resetSafeGitPins()` is the operator's way to start again. The operator's `pi.allowedRemote` list
// (global/system git config) is enforced in both trust modes. A work tree is also remembered against the repository
// Pi saw it use, so rewriting a worktree's `.git` file to name another repository is refused.
export { dropPinCacheForTests, listSafeGitPins, resetSafeGitPins, stateHooks } from "./safeGitState.ts";

export function forgetRemotePinsForTests(): void {
  forgetPinsForTests();
  allowCache = undefined;
  localConfigCache.clear();
  noticed.clear();
}

/**
 * The repository's own config, as git listed it the last time this process looked
 * at it. Keyed by path; invalidated when the file's stamp changes or when Pi's own
 * write-back edits it.
 *
 * Reading that file costs one `git` process per call — measured at ~10 ms, which
 * doubled the fixed cost of every `safeGit` call and, because the listing runs
 * through `runSync`, blocked the event loop even from async callers. The read is
 * the same read every time for an unchanged config, so it is the one worth
 * caching. Staleness here is not cosmetic: the listing decides what the generated
 * shadow config contains, so the stamp has to be trusted.
 *
 * The stamp is inode + size + mtime, the same basis `operatorConfigStamp` uses for
 * the operator's own config. Residual window: a rewrite that preserves inode and
 * size within the filesystem's mtime resolution would not be noticed. Writes this
 * module makes are invalidated explicitly rather than left to the stamp, so that
 * window only applies to a process editing `.git/config` behind Pi's back.
 */
const localConfigCache = new Map<string, { stamp: string; entries: FileEntry[] }>();
/** Repositories remembered at once; dozens of missions touch a handful of repos. */
const LOCAL_CONFIG_CACHE_LIMIT = 32;

function configFileStamp(path: string): string | undefined {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return undefined; // unreadable: git will say so, and nothing is cached
  }
}

function rememberLocalConfig(path: string, stamp: string, entries: FileEntry[]): void {
  if (!localConfigCache.has(path) && localConfigCache.size >= LOCAL_CONFIG_CACHE_LIMIT) {
    const oldest = localConfigCache.keys().next();
    if (!oldest.done) localConfigCache.delete(oldest.value);
  }
  localConfigCache.set(path, { stamp, entries });
}

/** Pi wrote to a repository config; whatever was listed before is no longer current. */
function forgetLocalConfig(path: string): void {
  localConfigCache.delete(path);
}

/** What the operator's own (system and global) git config says that safeGit needs. Cached for a few seconds. */
export interface OperatorConfig {
  allowedRemotes: string[];
  safeDirectories: string[];
  /** The operator's config defines `filter.lfs` (git-lfs installed globally). */
  hasLfsFilter: boolean;
  lfsUrl?: string;
  lfsPushUrl?: string;
  lfsLocksUrl?: string;
}

let allowCache: { at: number; key: string; cfg: OperatorConfig } | undefined;
const ALLOW_TTL_MS = 10_000;

/** mtime+size of the operator's own config files, so an edit is seen at once instead of after the cache expires. */
function operatorConfigStamp(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? "";
  const files = [
    env.GIT_CONFIG_GLOBAL,
    home ? join(home, ".gitconfig") : undefined,
    env.XDG_CONFIG_HOME
      ? join(env.XDG_CONFIG_HOME, "git", "config")
      : home
        ? join(home, ".config", "git", "config")
        : undefined,
    env.GIT_CONFIG_SYSTEM ?? (env.GIT_CONFIG_NOSYSTEM ? undefined : "/etc/gitconfig"),
  ];
  return files
    .map((f) => {
      if (!f) return "-";
      try {
        const st = statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return "absent";
      }
    })
    .join(",");
}

/**
 * Memo of the tracked-attributes-files listing (ls-files) for the LFS scan, one spawn per safeGit call otherwise.
 *
 * Why it is safe: the list is a function of the index alone, and the index is stamped (mtime in ns, inode, size) in the
 * key. Git replaces the index through a lock file renamed over it, so every `add`/`rm`/`checkout`/`reset` yields a new
 * inode and mtime and the entry stops matching. Only the list is remembered: `generateLfsAttributes` still reads each
 * `.gitattributes` file's content from disk on every call, so an edit to a tracked or untracked attributes file takes
 * effect at once. The TTL bounds the one residual case (an index rewritten in place within the same timestamp tick).
 * `PI_ENG_LFS_SCAN_MEMO=0` turns it off.
 */
const LFS_LIST_TTL_MS = 5_000;
const LFS_LIST_MEMO_MAX = 64;
const lfsListMemo = new Map<string, { at: number; files: string[] }>();

function lfsListStamp(gitDir: string, workTree: string): string | undefined {
  if (process.env.PI_ENG_LFS_SCAN_MEMO === "0") return undefined;
  try {
    const st = statSync(join(gitDir, "index"), { bigint: true });
    return `${workTree}\0${gitDir}\0${st.mtimeNs}:${st.ino}:${st.size}`;
  } catch {
    return undefined;
  }
}

function rememberLfsList(stamp: string, files: string[]): void {
  if (lfsListMemo.size >= LFS_LIST_MEMO_MAX) lfsListMemo.delete(lfsListMemo.keys().next().value as string);
  lfsListMemo.set(stamp, { at: Date.now(), files });
}

function operatorConfig(env: NodeJS.ProcessEnv): OperatorConfig {
  const key = `${env.HOME ?? ""}\0${env.XDG_CONFIG_HOME ?? ""}\0${env.GIT_CONFIG_GLOBAL ?? ""}\0${env.GIT_CONFIG_SYSTEM ?? ""}\0${env.GIT_CONFIG_NOSYSTEM ?? ""}\0${operatorConfigStamp(env)}`;
  const now = Date.now();
  if (allowCache && allowCache.key === key && now - allowCache.at < ALLOW_TTL_MS) return allowCache.cfg;
  const r = runSync(["config", "--list", "--show-scope", "--show-origin", "-z"], env, 5_000, configListMax, tmpdir());
  const cfg: OperatorConfig = { allowedRemotes: [], safeDirectories: [], hasLfsFilter: false };
  if (r.code === 0 && !r.truncated) {
    for (const e of parseScopedConfig(r.stdout)) {
      if (!TRUSTED_SCOPES.has(e.scope)) continue;
      const k = e.key.toLowerCase();
      if (k === "pi.allowedremote" && e.value !== "") cfg.allowedRemotes.push(e.value);
      else if (k === "safe.directory" && e.value !== "") cfg.safeDirectories.push(e.value);
      else if (k === "filter.lfs.clean" || k === "filter.lfs.smudge" || k === "filter.lfs.process")
        cfg.hasLfsFilter = true;
      else if (k === "lfs.url") cfg.lfsUrl = e.value;
      else if (k === "lfs.pushurl") cfg.lfsPushUrl = e.value;
      else if (k === "lfs.locksurl") cfg.lfsLocksUrl = e.value;
    }
  }
  allowCache = { at: now, key, cfg };
  return cfg;
}

/** Exact match, or a prefix when the entry ends in `*`. */
export function remoteAllowed(url: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => (a.endsWith("*") ? url.startsWith(a.slice(0, -1)) : url === a));
}

export type UrlClass = "net" | "local" | "ext";

/**
 * What a remote URL (or a URL-like argument) is: `ext` for `<helper>::<address>` (never run), `net` for https/http/ssh/git
 * and scp-like `user@host:path`, and `local` for everything else (`file://`, absolute or relative paths). A local
 * remote is another repository: `push` runs ITS hooks as the user, `fetch` runs its `upload-pack` config.
 */
export function urlClass(u: string): UrlClass {
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(u)) return "ext";
  if (/^(https?|ssh|git|git\+ssh|ssh\+git):\/\//i.test(u)) return "net";
  if (/^file:\/\//i.test(u)) return "local";
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(u) || /^[A-Za-z0-9._-]+:(?!\/\/)[^/\\]/.test(u)) return "net";
  return "local";
}

/** Positional arguments of a network command that name a repository by path or helper rather than by remote name. */
const PATHISH = /^(\/|\.\.?\/|~|file:)|::|^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** `host:path` and `user@host:path` (scp-like): a URL in disguise. A refspec such as `main:main` looks the same, so only the repository argument is tested for it. */
const SCP_LIKE = /^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:(?!\/\/)/;
const REPOSITORY_FIRST = new Set(["fetch", "pull", "push", "ls-remote", "clone"]);
export function urlArguments(args: readonly string[], at: number, remoteNames: ReadonlySet<string>): string[] {
  let positional = args.slice(at + 1).filter((a) => !a.startsWith("-"));
  // `git clone <repository> [<directory>]`: the directory is where the clone goes, not a remote
  if (args[at] === "clone" && positional.length >= 2) positional = positional.slice(0, -1);
  const out = positional.filter((a) => !remoteNames.has(a) && PATHISH.test(a));
  const first = positional[0];
  if (REPOSITORY_FIRST.has(args[at] ?? "") && first !== undefined && !remoteNames.has(first)) {
    if (SCP_LIKE.test(first) && !out.includes(first)) out.push(first);
  }
  return out;
}

// ─── git version and the empty tree ──────────────────────────────────────────────────────────────────────────────

/** `GIT_ATTR_SOURCE` (what cuts attributes off at the source) exists from git 2.40; with an older git the cut-off would silently not happen. */
const MIN_GIT = [2, 40] as const;
let gitVersionCache: string | undefined;
export function gitVersionProblem(): string | null {
  if (gitVersionCache === undefined && testHooks.gitVersion === undefined) {
    gitVersionCache = runSync(["--version"], { PATH: process.env.PATH ?? "" }, 5_000, 4096).stdout;
  }
  const text = testHooks.gitVersion ?? gitVersionCache ?? "";
  const m = /git version (\d+)\.(\d+)/.exec(text);
  if (!m) return "the git version could not be determined, and Pi needs git 2.40 or newer";
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) {
    return `git ${major}.${minor} is older than ${MIN_GIT[0]}.${MIN_GIT[1]}: it has no GIT_ATTR_SOURCE, so Pi could not stop a repository's attributes from selecting a filter or diff driver. Upgrade git`;
  }
  return null;
}

const emptyTrees = new Map<string, string>();
/** The empty tree's id in the repository's own hash format (sha1 or sha256), asked of git instead of assumed. */
function emptyTreeFor(format: string, env: NodeJS.ProcessEnv): string | null {
  const known = emptyTrees.get(format);
  if (known) return known;
  const r = runSync(["hash-object", "-t", "tree", "/dev/null"], env, 5_000, 4096);
  const id = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id)) return null;
  emptyTrees.set(format, id);
  return id;
}

// ─── per-call preparation and completion ─────────────────────────────────────────────────────────────────────────

interface Shadow {
  root: string;
  /** Names in the shadow that are private COPIES of a real file (read-only commands only): never written back. */
  copies: ReadonlySet<string>;
  common: string;
  /** The generated global attributes file (git-lfs lines only). */
  attributes: string;
  /** What was written to the attributes file (compared after the command). */
  attributesText: string;
  /** `git` may legitimately write to the shadow's config/info (config, remote, branch, push ...): the directory stays writable. */
  writer: boolean;
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

const SHADOW_SKIP = new Set(["config", "hooks", "info"]);
const DERIVED_KEYS = new Set(["core.repositoryformatversion", "core.bare"]);
const noticed = new Set<string>();

/**
 * Subcommands that may write the repository config (or `info/`): everything else gets a shadow directory that is
 * read-only while git runs, so a command that has no business creating files in it cannot.
 */
const CONFIG_WRITERS = new Set([
  "config",
  "remote",
  "branch",
  "push",
  "pull",
  "fetch",
  "checkout",
  "switch",
  "worktree",
  "lfs",
  "submodule",
  "clone",
  "init",
  "maintenance",
  "sparse-checkout",
  "gc",
  "repack",
  "bisect",
  "rebase",
]);

/**
 * Commands that read `shallow` and `info/grafts` but never write them. For these the shadow holds private COPIES,
 * read once with O_NOFOLLOW: git then never opens the shared path, so a link planted (or flipped in) after Pi's own
 * look cannot make it quote a line of some other file in an error message. `packed-refs`, the refs themselves, the
 * index and the per-worktree files are read from the real git directory (git takes them from GIT_DIR, which cannot
 * be moved into the shadow without moving the index and refs with it), so for those only the last look, the
 * withholding of quoted lines and a sandbox remain.
 */
const READS_ONLY_SHARED_FILES = new Set([
  "log",
  "show",
  "diff",
  "diff-tree",
  "diff-files",
  "diff-index",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "cat-file",
  "for-each-ref",
  "show-ref",
  "describe",
  "blame",
  "merge-base",
  "name-rev",
  "grep",
  "shortlog",
  "status",
  "add",
  "commit",
  "restore",
  "reflog",
]);
const COPY_LIMIT = 256 * 1024 * 1024;

/** Read a plain, single-name file without following a link; null when it does not exist. Throws when it is not plain. */
export function readPlainFile(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error(`${path} is a symbolic link`);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    if (st.nlink > 1) throw new Error(`${path} has more than one hard link`);
    if (st.size > COPY_LIMIT) throw new Error(`${path} is too large to copy`);
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function makeShadow(
  layout: RepoLayout,
  configText: string,
  writer: boolean,
  attributesFor: (common: string) => string,
  readOnlyCommand = false,
): Shadow {
  sweepOnce();
  const root = makeShadowRoot();
  const common = join(root, ".git");
  const copies = new Set<string>();
  try {
    mkdirSync(common, { mode: 0o700 });
    for (const name of readdirSync(layout.commonDir)) {
      if (SHADOW_SKIP.has(name)) continue;
      if (readOnlyCommand && name === "shallow") {
        const body = readPlainFile(join(layout.commonDir, name));
        if (body !== null) {
          writeFileSync(join(common, name), body, { mode: 0o400 });
          copies.add(name);
          continue;
        }
      }
      symlinkSync(join(layout.commonDir, name), join(common, name));
    }
    mkdirSync(join(common, "hooks"), { mode: 0o700 });
    // `info` is Pi's own directory: its `attributes` is empty (the repository's would select drivers); the rest links back
    mkdirSync(join(common, "info"), { mode: 0o700 });
    writeFileSync(join(common, "info", "attributes"), "", { mode: 0o400 });
    let infoNames: string[] = [];
    try {
      infoNames = readdirSync(join(layout.commonDir, "info"));
    } catch {
      /* no info directory */
    }
    for (const name of infoNames) {
      if (name === "attributes") continue;
      if (readOnlyCommand && name === "grafts") {
        const body = readPlainFile(join(layout.commonDir, "info", name));
        if (body !== null) {
          writeFileSync(join(common, "info", name), body, { mode: 0o400 });
          copies.add("info/grafts");
          continue;
        }
      }
      symlinkSync(join(layout.commonDir, "info", name), join(common, "info", name));
    }
    writeFileSync(join(common, "config"), configText, { mode: 0o400 });
    const attributes = join(root, "attributes");
    const attributesText = attributesFor(common);
    writeFileSync(attributes, attributesText, { mode: 0o400 });
    if (!writer) {
      chmodSync(join(common, "info"), 0o500);
      chmodSync(join(common, "hooks"), 0o500);
      chmodSync(common, 0o500);
    }
    return { root, copies, common, attributes, attributesText, writer };
  } catch (e) {
    markShadowDone(root);
    removeShadow(root);
    throw e;
  }
}

/** Drop a shadow directory (also when it was made read-only). */
function dropShadow(shadow: Shadow): void {
  markShadowDone(shadow.root);
  removeShadow(shadow.root);
}

function gitlinksWithRepo(layout: RepoLayout, env: NodeJS.ProcessEnv): string[] | null {
  if (!layout.workTree) return [];
  // the same forced settings as the command itself: even an internal ls-files must not start an fsmonitor or hook
  const r = runSync([...OPERATOR_FORCED, "ls-files", "--stage", "-z"], env, 5_000, 16 * 1024 * 1024, layout.workTree);
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

const CHECKOUT_SUBCOMMANDS = new Set([
  "checkout",
  "switch",
  "merge",
  "pull",
  "reset",
  "stash",
  "rebase",
  "cherry-pick",
  "revert",
  "worktree",
  "clone",
  "restore",
  "am",
  "apply",
  "read-tree",
  "checkout-index",
  "sparse-checkout",
  "submodule",
  "bisect",
]);

/** Commands that write files into the work tree run git-lfs's smudge filter, which contacts a server; never from Pi. */
function skipSmudge(env: NodeJS.ProcessEnv, sub: string | undefined): void {
  if (sub !== undefined && CHECKOUT_SUBCOMMANDS.has(sub)) env.GIT_LFS_SKIP_SMUDGE = "1";
}

/** `file` is added to the transports only when a local remote was allow-listed; an operator-chosen GIT_ALLOW_PROTOCOL is theirs. */
function applyProtocols(env: NodeJS.ProcessEnv, trust: GitTrust, local: boolean): void {
  if (!local) return;
  if (trust === "operator" && process.env.GIT_ALLOW_PROTOCOL !== undefined) return;
  const have = (env.GIT_ALLOW_PROTOCOL ?? "").split(":").filter(Boolean);
  if (!have.includes("file")) env.GIT_ALLOW_PROTOCOL = [...have, "file"].join(":");
}

const shorten = (u: string): string => (u.length > 120 ? `${u.slice(0, 117)}...` : u);

/** Local-path and helper remotes need the operator's allow-list; with a list, every remote URL must be on it. */
function checkTransports(
  urls: readonly string[],
  argUrls: readonly string[],
  cfg: OperatorConfig,
): { why: string; local: boolean } {
  let local = false;
  for (const u of [...urls, ...argUrls]) {
    const cls = urlClass(u);
    if (cls === "ext") {
      return {
        why: `the remote ${shorten(u)} uses a helper transport (<helper>::<address>), which Pi never runs`,
        local,
      };
    }
    if (cls === "local") {
      if (testHooks.localTransports || remoteAllowed(u, cfg.allowedRemotes)) {
        local = true;
        continue;
      }
      return {
        why: `the remote ${shorten(u)} is a local path or file:// URL: fetching or pushing there would run that repository's own hooks and configuration. List it with: git config --global --add pi.allowedRemote '<url>' (the operator's pi.allowedRemote)`,
        local,
      };
    }
    if (cfg.allowedRemotes.length > 0 && !remoteAllowed(u, cfg.allowedRemotes)) {
      return { why: "a remote URL of this repository is not in the operator's pi.allowedRemote list", local };
    }
  }
  return { why: "", local };
}

/** The LFS endpoint git-lfs derives from an https remote (`<url>.git/info/lfs`); empty for anything else. */
function lfsEndpoint(url: string): string {
  if (!/^https?:\/\//i.test(url)) return "";
  const u = url.replace(/\/+$/, "");
  return u.endsWith("/info/lfs") ? u : `${u}${u.endsWith(".git") ? "" : ".git"}/info/lfs`;
}

/**
 * `lfs.url` / `lfs.pushurl` / `lfs.locksurl` on the command line beat `.lfsconfig` (measured with git-lfs 3.4): whatever a
 * `.lfsconfig` that arrives during a checkout says, credentials go only to the endpoint of the repository's own remote
 * (or to the operator's own configured endpoint). An empty value makes git-lfs fail with "missing protocol" instead of
 * contacting anything.
 */
function lfsForced(cfg: OperatorConfig, kept: readonly FileEntry[], trust: GitTrust): string[] {
  const urls = new Map<string, { url?: string; pushurl?: string }>();
  for (const k of kept) {
    const p = parseKey(k.key);
    if (!p || p.section !== "remote" || p.sub === null || !URL_VARIABLES.has(p.variable)) continue;
    const e = urls.get(p.sub) ?? {};
    if (p.variable === "url") e.url = k.value ?? "";
    else e.pushurl = k.value ?? "";
    urls.set(p.sub, e);
  }
  const names = [...urls.keys()].sort();
  const name = urls.has("origin") ? "origin" : names[0];
  const r = name === undefined ? {} : (urls.get(name) as { url?: string; pushurl?: string });
  const base = lfsEndpoint(r.url ?? r.pushurl ?? "");
  const push = lfsEndpoint(r.pushurl ?? r.url ?? "");
  const own = trust === "operator";
  const url = own && cfg.lfsUrl !== undefined ? cfg.lfsUrl : base;
  const pushurl = own && cfg.lfsPushUrl !== undefined ? cfg.lfsPushUrl : push;
  const locks = own && cfg.lfsLocksUrl !== undefined ? cfg.lfsLocksUrl : base ? `${base}/locks` : "";
  return pairs([`lfs.url=${url}`, `lfs.pushurl=${pushurl}`, `lfs.locksurl=${locks}`]);
}

/** git skips its `safe.directory` ownership check when GIT_DIR is given explicitly, so Pi does the check. */
export function unsafeOwner(
  layout: RepoLayout,
  cfg: OperatorConfig,
  me: number | null | undefined = typeof process.getuid === "function" ? process.getuid() : null,
): string | null {
  if (me === null || me === undefined) return null;
  for (const path of [layout.workTree, layout.commonDir]) {
    if (path === null) continue;
    let uid: number;
    try {
      uid = lstatSync(path).uid;
    } catch {
      continue;
    }
    if (uid === me) continue;
    const listed = (d: string): boolean => d === "*" || d === path || d === layout.workTree || d === layout.commonDir;
    if (cfg.safeDirectories.some(listed)) continue;
    return `${path} is owned by another user; add it to safe.directory in your own git config to use it`;
  }
  return null;
}

/**
 * Symbolic links, hard links and special files in the shared git directories (see safeGitTree.ts). A repository with
 * more loose refs/logs than the scan can verify is refused with the way out; `pack-refs` and `gc` are exactly that way
 * out, so they alone are let through when the ONLY problem is the amount.
 */
function scanProblemFor(layout: RepoLayout, sub: string | undefined): string | null {
  let scan: ReturnType<typeof scanRepoTreeDetailed>;
  try {
    scan = scanRepoTreeDetailed(layout);
  } catch (e) {
    return `the repository could not be inspected (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
  }
  if (!scan.reason) return null;
  if (scan.overLimit) {
    if (sub === "pack-refs" || sub === "gc") {
      // the way out of a too-large tree: let through only when EVERY entry checks out (padding the tree so the budget
      // runs out before a planted link is reached must not open the door)
      try {
        const full = scanRepoTreeDetailed(layout, UNBOUNDED_SCAN);
        return full.reason ? `the repository's git directory contains ${full.reason}` : null;
      } catch (e) {
        return `the repository could not be inspected (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
      }
    }
    return `the repository's git directory has more loose refs or log files than Pi can verify (${scan.reason}). Run \`git pack-refs --all\` (or \`git gc\`) through Pi, which is let through for exactly this reason, or from a shell in ${layout.commonDir}, and retry`;
  }
  return `the repository's git directory contains ${scan.reason}`;
}

/**
 * Settings the caller may not override with its own leading `-c key=value` (it would come AFTER Pi's forced
 * settings, and the last `-c` wins): everything that selects a program, a transport, a credential, an endpoint, an
 * attribute file, a repository location or an include.
 */
const PROTECTED_KEY =
  /^(core\.(hookspath|fsmonitor|attributesfile|sshcommand|worktree|bare|pager|editor|gitproxy|askpass|excludesfile|alternaterefscommand|untrackedcache)|protocol\.|credential|url\.|include|alias\.|filter\.|diff\.|merge\.|gpg\.|lfs\.|uploadpack\.|receive\.|safe\.|submodule\.|fetch\.|push\.|gc\.|maintenance\.|http\.|remote\.|sequence\.|tag\.gpgsign|commit\.gpgsign|log\.showsignature|status\.submodulesummary|difftool|mergetool|pager\.|man\.|web\.|browser\.|help\.|trailer\.|ssh\.|pi\.|extensions\.|init\.templatedir|transfer\.|fsck\.|pack\.|index\.|checkout\.|worktree\.|sparsecheckout|core\.sparsecheckout)/i;

/** `<program>`-taking options of the network commands: they name a program that runs on the other side or locally. */
const PROGRAM_OPTIONS = /^(--upload-pack|--receive-pack|--exec|--ssh-command|--config-env|--exec-path)(=|$)/;

/** Why a caller-supplied option is refused, or null. */
export function refusedOption(args: readonly string[], at: number): string | null {
  for (let i = 0; i < at; i++) {
    const a = args[i] ?? "";
    if (a === "-c") {
      const kv = args[i + 1] ?? "";
      const key = kv.split("=")[0] ?? "";
      if (PROTECTED_KEY.test(key))
        return `-c ${key} would override a setting Pi forces (or selects a program, endpoint or include)`;
      i++;
    } else if (a.startsWith("-c") && a.length > 2 && !a.startsWith("--")) {
      const key = a.slice(2).split("=")[0] ?? "";
      if (PROTECTED_KEY.test(key))
        return `-c ${key} would override a setting Pi forces (or selects a program, endpoint or include)`;
    } else if (/^--(config-env|exec-path)(=|$)/.test(a)) {
      return `${a.split("=")[0]} is not allowed`;
    }
  }
  for (let i = at + 1; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") break;
    if (PROGRAM_OPTIONS.test(a)) return `${a.split("=")[0]} names a program git would run`;
    if (args[at] === "clone" && (a === "-u" || /^-[A-Za-z]*u/.test(a)))
      return "-u (--upload-pack) names a program git would run";
  }
  return null;
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
  const badOption = refusedOption(args, at);
  if (badOption) return refuse(badOption);
  const oldGit = gitVersionProblem();
  if (oldGit) return refuse(oldGit);

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
  const network = contactsNetwork(args, at);
  // one place that knows the operator's own config, in BOTH modes (strict ignores it for git, not for Pi's own checks)
  const opCfg = operatorConfig(withoutInjectedConfig(safeGitEnv(process.env, "operator")));
  if (!layout) {
    // Nothing found, so git must not find anything either (an enclosing repository would be read unfiltered).
    const env = { ...cleanEnv };
    try {
      env.GIT_CEILING_DIRECTORIES = dirname(realpathSync(where));
    } catch {
      /* where does not exist: git will say so */
    }
    let why = "";
    let local = false;
    if (network) {
      const r = checkTransports([], urlArguments(args, at, new Set()), opCfg);
      why = r.why;
      local = r.local;
    }
    if (why) return refuse(why);
    applyProtocols(env, trust, local);
    skipSmudge(env, sub);
    return { ...base, env, argv: [...prefix, ...lfsForced(opCfg, [], trust), ...diffing(args, at)] };
  }

  // 0. is this the repository the caller (and Pi, last time) saw at this path?
  try {
    if (opts.expectCommonDir !== undefined) {
      let expected = opts.expectCommonDir;
      try {
        expected = realpathSync(expected);
      } catch {
        /* compare as given */
      }
      if (expected !== layout.commonDir) {
        return refuse(`this work tree now belongs to another repository (${layout.commonDir}, expected ${expected})`);
      }
    }
    if (layout.workTree !== null) {
      const known = pinStore.getRepo(layout.workTree);
      if (known === undefined) pinStore.setRepo(layout.workTree, layout.commonDir);
      else if (known !== layout.commonDir) {
        return refuse(
          `the work tree ${layout.workTree} belonged to the repository ${known} and now names ${layout.commonDir} (a rewritten .git file?). If this is intended, run: pi-engineering git-pins reset ${layout.workTree}`,
        );
      }
    }
  } catch (e) {
    return refuse(`the remembered repository state could not be used (${(e as Error).message})`);
  }

  // 0b. ownership: git skips its own `safe.directory` check when GIT_DIR is explicit, so it is enforced here
  const unsafe = unsafeOwner(layout, opCfg, testHooks.uid);
  if (unsafe) return refuse(unsafe);

  // 0c. symbolic links, hard links and special files where git expects plain files or directories
  const scanProblem = scanProblemFor(layout, sub);
  if (scanProblem) return refuse(scanProblem);

  // 1. snapshot the repository's own config (one file, no includes, runs nothing)
  const realConfig = join(layout.commonDir, "config");
  let entries: FileEntry[] = [];
  if (exists(realConfig)) {
    const stamp = configFileStamp(realConfig);
    const remembered = stamp === undefined ? undefined : localConfigCache.get(realConfig);
    if (remembered && remembered.stamp === stamp) {
      entries = remembered.entries;
    } else {
      testHooks.onConfigList?.();
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
        // A refusal is never cached: the next call must see the file as it is now.
        localConfigCache.delete(realConfig);
        return refuse(
          listed.truncated ? "the repository config is too large to inspect" : "the repository config is unreadable",
        );
      }
      entries = parseFileConfig(listed.stdout);
      if (stamp !== undefined) rememberLocalConfig(realConfig, stamp, entries);
    }
  }
  const generated = generateConfig(entries, layout.workTree === null);

  // 2. network refusals: remote URLs must match the pin, the operator's list, and not be a local path / helper
  let pinned: string | undefined;
  try {
    pinned = pinStore.getPin(layout.commonDir);
  } catch (e) {
    return refuse((e as Error).message);
  }
  let localTransport = false;
  if (network) {
    if (pinned !== undefined && pinned !== generated.remoteUrls) {
      return refuse(
        `this repository's remote URLs changed since Pi first used it. If this is intended, run: pi-engineering git-pins reset ${layout.commonDir}`,
      );
    }
    const remoteNames = new Set(
      generated.kept
        .map((k) => parseKey(k.key))
        .filter((k): k is ParsedKey => k !== null && k.section === "remote" && k.sub !== null)
        .map((k) => k.sub as string),
    );
    const r = checkTransports(generated.urls, urlArguments(args, at, remoteNames), opCfg);
    if (r.why) return refuse(r.why);
    localTransport = r.local;
    // LFS reads `.lfsconfig` from the work tree (lfs.url / pushurl): a worker-controlled endpoint would receive credentials
    if (sub === "lfs" && layout.workTree && exists(join(layout.workTree, ".lfsconfig"))) {
      return refuse("the work tree has a .lfsconfig, which can point git-lfs at another server");
    }
  }

  // 3. the shadow (and, in operator mode with git-lfs, the generated attributes: read by Pi through the shadow itself)
  let shadow: Shadow;
  let lfsInfo: ReturnType<typeof generateLfsAttributes> | undefined;
  // the repository's own LFS patterns, read by Pi through the shadow (the root file even while untracked, git applies it
  // at once; nested ones once they are tracked)
  const scanLfs = (common: string): ReturnType<typeof generateLfsAttributes> | undefined => {
    if (!layout.workTree) return undefined;
    const gitEnv: NodeJS.ProcessEnv = {
      ...cleanEnv,
      GIT_DIR: layout.gitDir,
      GIT_COMMON_DIR: common,
      GIT_WORK_TREE: layout.workTree,
    };
    const stamp = lfsListStamp(layout.gitDir, layout.workTree);
    const memo = stamp === undefined ? undefined : lfsListMemo.get(stamp);
    let tracked: string[];
    if (memo && Date.now() - memo.at < LFS_LIST_TTL_MS) {
      tracked = memo.files;
    } else {
      const listed = runSync(
        [...OPERATOR_FORCED, "ls-files", "-z", "--", ".gitattributes", "*/.gitattributes"],
        gitEnv,
        5_000,
        16 * 1024 * 1024,
        layout.workTree,
      );
      if (listed.code !== 0 || listed.truncated) {
        if (stamp !== undefined) lfsListMemo.delete(stamp);
        return { text: "", patterns: 0, uncertain: ["the list of tracked .gitattributes files could not be read"] };
      }
      tracked = listed.stdout.split("\0").filter(Boolean);
      if (stamp !== undefined) rememberLfsList(stamp, tracked);
    }
    // The file CONTENTS are read afresh on every call; only the (spawned) list of which files are tracked is remembered.
    return generateLfsAttributes(layout.workTree, [".gitattributes", ...tracked]);
  };
  try {
    // git creates `logs/` in the common directory on the first branch update; the shadow may be read-only, so it exists first
    if (!exists(join(layout.commonDir, "logs"))) mkdirSync(join(layout.commonDir, "logs"), { recursive: true });
    shadow = makeShadow(
      layout,
      generated.text,
      CONFIG_WRITERS.has(sub ?? ""),
      (common) => {
        if (trust !== "operator" || !opCfg.hasLfsFilter || !layout.workTree) return "";
        lfsInfo = scanLfs(common);
        return lfsInfo?.text ?? "";
      },
      READS_ONLY_SHARED_FILES.has(sub ?? ""),
    );
  } catch (e) {
    return refuse(
      `could not prepare an isolated git view (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`,
    );
  }
  testHooks.afterShadow?.(shadow.root);
  // hooks are off, so `git lfs push` (the pre-push hook) never runs: pointers would reach the remote without their
  // objects. Checked in both modes: strict has no lfs filter, but a pointer file committed by hand is just as broken.
  if (network && sub === "push") {
    const info = lfsInfo ?? scanLfs(shadow.common);
    if (info && (info.patterns > 0 || info.uncertain.length > 0)) {
      dropShadow(shadow);
      return refuse(
        info.patterns > 0
          ? "this repository tracks files with git-lfs, and Pi runs git without hooks, so `git lfs push` would not run and the remote would receive pointer files without their objects. Push it yourself (git push) from a shell, or untrack the LFS patterns"
          : `Pi cannot tell whether this repository tracks files with git-lfs (${info.uncertain[0]}), and a push without hooks would send pointer files without their objects. Push it yourself (git push) from a shell`,
      );
    }
  }
  const env: NodeJS.ProcessEnv = { ...cleanEnv, GIT_DIR: layout.gitDir, GIT_COMMON_DIR: shadow.common };
  // the empty tree of THIS repository's hash format (a sha256 repository has a different one)
  const format = generated.kept.find((k) => k.key.toLowerCase() === "extensions.objectformat")?.value ?? "sha1";
  const tree = emptyTreeFor(format.toLowerCase(), env);
  if (!tree) {
    dropShadow(shadow);
    return refuse("the empty tree of this repository could not be determined");
  }
  env.GIT_ATTR_SOURCE = tree;
  if (layout.workTree) env.GIT_WORK_TREE = layout.workTree;
  if (layout.workTree && exists(join(layout.workTree, ".lfsconfig"))) env.GIT_LFS_SKIP_SMUDGE = "1";
  skipSmudge(env, sub);
  applyProtocols(env, trust, localTransport);

  // 4. nested repositories
  let argv = diffing(args, at);
  if (sub !== undefined && (FLAG_IGNORING.has(sub) || sub === "add" || sub === "describe")) {
    if (FLAG_IGNORING.has(sub)) {
      argv = [...argv.slice(0, at + 1), "--ignore-submodules=all", ...argv.slice(at + 1)];
    } else {
      const nested = gitlinksWithRepo(layout, env);
      if (nested === null) {
        dropShadow(shadow);
        return refuse("the index cannot be inspected for nested repositories");
      }
      if (nested.length > 0) {
        const rest = args.slice(at + 1);
        if (
          sub === "describe" &&
          rest.some((a) => a === "--dirty" || a.startsWith("--dirty=") || a === "--broken" || a.startsWith("--broken="))
        ) {
          dropShadow(shadow);
          return refuse(`describe --dirty would run the configuration of the nested repository at ${nested[0]}`);
        }
        if (sub === "add") {
          if (rest.some((a) => a === "--pathspec-from-file" || a.startsWith("--pathspec-from-file="))) {
            dropShadow(shadow);
            return refuse(`add --pathspec-from-file cannot exclude the nested repository at ${nested[0]}`);
          }
          if (addHasSelector(rest))
            argv = [...argv, ...(rest.includes("--") ? [] : ["--"]), ...excludePathspecs(nested)];
        }
      }
    }
  }
  // the last look before git starts: after the shadow and Pi's own internal git calls, so the window a planted link
  // has to be flipped in is as short as Pi can make it (it is not closed: see docs/architecture.md, "what remains")
  const lastLook = scanProblemFor(layout, sub);
  if (lastLook) {
    dropShadow(shadow);
    return refuse(lastLook);
  }
  return {
    ...base,
    env,
    layout,
    shadow,
    generated,
    pinBefore: pinned,
    // with GIT_COMMON_DIR set git no longer learns `core.bare` from the config it reads, so a bare repository is declared
    argv: [
      ...(layout.workTree === null ? ["--bare"] : []),
      ...prefix,
      "-c",
      `core.attributesFile=${shadow.attributes}`,
      ...lfsForced(opCfg, generated.kept, trust),
      ...argv,
    ],
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
    if (SHADOW_SKIP.has(name) || name.endsWith(".lock") || shadow.copies.has(name)) continue;
    const from = join(shadow.common, name);
    if (lstatSync(from).isSymbolicLink()) continue;
    moveBack(from, join(layout.commonDir, name));
  }
  // files git created in `info/` (the symlinks and the generated empty `attributes` stay behind)
  const infoReal = join(layout.commonDir, "info");
  for (const name of readdirSync(join(shadow.common, "info"))) {
    if (name === "attributes" || name.endsWith(".lock") || shadow.copies.has(`info/${name}`)) continue;
    const from = join(shadow.common, "info", name);
    if (lstatSync(from).isSymbolicLink()) continue;
    mkdirSync(infoReal, { recursive: true });
    moveBack(from, join(infoReal, name));
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
      // Pi created this work tree: remember which repository it belongs to, so a later rewrite of its `.git` file is noticed
      try {
        pinStore.setRepo(realpathSync(dirname(pointer)), layout.commonDir);
      } catch {
        /* the first call that finds it records it */
      }
    } catch {
      /* a stale or foreign entry: leave it alone */
    }
  }
}

/**
 * `git worktree add` ran inside the shadow, so the new work tree's `.git` file names the shadow's directory. When Pi
 * could not move the result back and repair that link, the work tree would stay behind pointing at a directory that
 * is about to be removed: it is rolled back (the work tree this very call created, and its admin directory) and the
 * caller gets the failure. The branch the command may have created is left alone.
 */
function rollbackWorktrees(p: Prepared): number {
  const layout = p.layout as RepoLayout;
  const shadow = p.shadow as Shadow;
  // the new admin directory is in the real repository (moved back) or still in the shadow (not moved yet)
  const places = [join(layout.commonDir, "worktrees"), join(shadow.common, "worktrees")];
  const done = new Set<string>();
  let removed = 0;
  for (const dir of places) {
    let names: string[];
    try {
      if (lstatSync(dir).isSymbolicLink()) continue;
      names = readdirSync(dir).slice(0, 4096);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const pointer = readFileSync(join(dir, name, "gitdir"), "utf8").trim();
        if (!pointer.endsWith("/.git")) continue;
        const st = lstatSync(pointer);
        if (!st.isFile() || !readFileSync(pointer, "utf8").includes(shadow.root)) continue;
        const tree = dirname(pointer);
        if (!done.has(tree)) {
          rmSync(tree, { recursive: true, force: true });
          done.add(tree);
          removed++;
        }
        for (const d of places) rmSync(join(d, name), { recursive: true, force: true });
      } catch {
        /* not one of ours */
      }
    }
  }
  return removed;
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
  // Only what is on the allow-list is replayed (the same generator that wrote the file reads it back): a key git was
  // never meant to write there is reported and NOT copied. The two derived keys are never replayed either.
  const written = parseFileConfig(listed.stdout).filter((e) => !DERIVED_KEYS.has(e.key.toLowerCase()));
  const readBack = generateConfig(written, layout.workTree === null);
  const unexpected = readBack.dropped.filter((k) => !DERIVED_KEYS.has(k.toLowerCase()));
  if (unexpected.length > 0) {
    emitTelemetry({
      level: "error",
      key: "git-shadow-config-unexpected",
      text: `git ${p.sub ?? ""}: the command left key(s) in the generated config that are not allowed and were not copied to the repository: ${tidyStderr(unexpected.slice(0, 6).join(", "), 160, 1)}`,
    });
  }
  const after = readBack.kept;
  const real = join(layout.commonDir, "config");
  const { remove, add } = configDelta(generated.kept, after);
  for (const e of remove) {
    gitConfigFile(real, ["--fixed-value", "--unset", e.key, e.value ?? ""], p.cleanEnv);
  }
  for (const e of add) {
    gitConfigFile(real, ["--add", e.key, e.value ?? "true"], p.cleanEnv);
  }
  // Pi edited the repository config. The listing cached for it is stale whatever
  // the filesystem stamp says, so it is dropped rather than waited out.
  if (remove.length > 0 || add.length > 0) forgetLocalConfig(real);
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

/** Tidy what a command printed: no line longer than a screenful and no more than 64 KiB of stderr reaches the caller. */
const STDERR_LINE = 1024;
const STDERR_TOTAL = 64 * 1024;
export function limitStderr(stderr: string): string {
  if (stderr.length <= STDERR_LINE && stderr.length <= STDERR_TOTAL) return stderr;
  const lines = stderr
    .split("\n")
    .map((l) => (l.length > STDERR_LINE ? `${l.slice(0, STDERR_LINE)} ...[line truncated]` : l));
  const joined = lines.join("\n");
  return joined.length > STDERR_TOTAL ? `${joined.slice(0, STDERR_TOTAL)}\n...[stderr truncated]` : joined;
}
/**
 * git quotes the offending LINE of a malformed shared file in its error (`unexpected line in .git/packed-refs: <line>`,
 * `bad shallow line: <line>`, `bad graft data: <line>`). If the file is a link a worker planted, that line is a line of
 * some other file. Pi never relays the quoted part; the name of the problem stays.
 */
const QUOTING_MESSAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(unexpected line in [^:\n]*): (?!<)[^\n]*/g, "$1: <line withheld>"],
  [/(bad shallow line): (?!<)[^\n]*/g, "$1: <line withheld>"],
  [/(bad graft data): (?!<)[^\n]*/g, "$1: <line withheld>"],
  [
    /((?:bad|invalid|malformed|corrupt|broken|unknown|garbage|unexpected)[^\n:]{0,40}\b(?:line|data|entry|content|record)s?\b[^\n:]{0,60}): (?!<)[^\n]*/gi,
    "$1: <content withheld>",
  ],
];
export function withholdQuotedContent(stderr: string): string {
  let out = stderr;
  for (const [re, to] of QUOTING_MESSAGES) out = out.replace(re, to);
  return out;
}
const clamp = (r: SafeGitResult): SafeGitResult => {
  const text = withholdQuotedContent(r.stderr);
  return text.length > STDERR_LINE || text !== r.stderr ? { ...r, stderr: limitStderr(text) } : r;
};

/**
 * After the command: is the shadow still what Pi made it? The directory is private (see safeGitState.ts), so this is
 * a tripwire for a same-user process that reached it anyway, not a barrier: it cannot undo what git already did,
 * it makes the caller not trust the result and puts a loud line in the telemetry.
 */
export function verifyShadow(shadow: Shadow, layout: RepoLayout, generatedText: string): string | null {
  try {
    const cfg = join(shadow.common, "config");
    const st = lstatSync(cfg);
    if (!st.isFile()) return "the generated config is no longer a regular file";
    if (!shadow.writer && readFileSync(cfg, "utf8") !== generatedText)
      return "the generated config was modified while git ran";
    const attrs = lstatSync(join(shadow.common, "info", "attributes"));
    if (!attrs.isFile() || readFileSync(join(shadow.common, "info", "attributes"), "utf8") !== "") {
      return "the generated info/attributes was modified while git ran";
    }
    const own = lstatSync(shadow.attributes);
    if (!own.isFile() || readFileSync(shadow.attributes, "utf8") !== shadow.attributesText) {
      return "the generated attributes file was modified while git ran";
    }
    if (readdirSync(join(shadow.common, "hooks")).length > 0) return "a hook appeared in the empty hooks directory";
    for (const name of readdirSync(shadow.common)) {
      const full = join(shadow.common, name);
      if (!lstatSync(full).isSymbolicLink()) continue;
      if (readlinkSync(full) !== join(layout.commonDir, name)) return `the link ${name} was repointed while git ran`;
    }
  } catch (e) {
    return `the shadow could not be verified (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
  }
  return null;
}

function complete(p: Prepared, result: SafeGitResult): SafeGitResult {
  if (!p.shadow || !p.layout || !p.generated) return clamp(result);
  const layout = p.layout;
  const shadow = p.shadow;
  let out = result;
  try {
    const tampered = verifyShadow(shadow, layout, p.generated.text);
    if (tampered) {
      emitTelemetry({
        level: "error",
        key: "git-shadow-tampered",
        text: `git ${p.sub ?? ""}: ${tampered}; the result was discarded and nothing was copied back into the repository. Something with access to Pi's private state directory changed it (see docs/architecture.md, git hardening).`,
      });
      return failed(`refused: ${tampered}; the result was discarded`);
    }
    let problem: string | null = null;
    try {
      if (testHooks.failWriteBack) throw Object.assign(new Error("injected"), { code: "EINJECTED" });
      problem = writeBack(p);
      if (testHooks.failWriteBackAfter) throw Object.assign(new Error("injected"), { code: "EINJECTED" });
    } catch (e) {
      problem = `moving the command's files back into the repository failed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
    }
    // a work tree whose files could not be moved back is not repaired, it is rolled back (before the link fix below would hide it)
    let rolledBack = 0;
    if (problem && p.sub === "worktree" && result.code === 0) rolledBack = rollbackWorktrees(p);
    let changed: ReturnType<typeof replayConfig> = null;
    try {
      changed = replayConfig(p);
      if (p.sub === "worktree") fixWorktreeLinks(p);
    } catch (e) {
      problem ??= `finishing the command's repository changes failed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
    }
    // Pi's own edit of a remote URL moves the pin by exactly what the command changed; a read, or a worker's edit, never does
    try {
      const current = pinStore.getPin(layout.commonDir);
      const base = current ?? p.generated.remoteUrls;
      const next = changed ? applyPinDelta(base, changed.remove, changed.add) : base;
      // nothing to pin until the repository has a remote: adding the first one is how a remote is normally set up
      if (current === undefined ? next !== "" : next !== current) pinStore.setPin(layout.commonDir, next);
    } catch (e) {
      problem ??= `the remote pin could not be saved (${(e as Error).message})`;
    }
    if (problem && p.sub === "worktree" && result.code === 0) rolledBack += rollbackWorktrees(p);
    if (rolledBack > 0) problem = `${problem}; the ${rolledBack} work tree(s) this command created were rolled back`;
    notifyIgnored(layout, p.generated);
    out = clamp({
      ...result,
      stdout: mapOut(result.stdout, p),
      stderr: mapOut(result.stderr, p),
    });
    if (problem) {
      emitTelemetry({ level: "error", key: "git-writeback-failed", text: `git ${p.sub ?? ""}: ${problem}.` });
      out = {
        ...out,
        code: out.code === 0 ? 128 : out.code,
        stderr: [out.stderr, `warning: ${problem}`].filter(Boolean).join("\n"),
      };
    }
  } finally {
    dropShadow(shadow);
  }
  return out;
}

/**
 * `prepare` does synchronous work (the repository scan, the config snapshot, the first call's one-time setup of the
 * state directory, the git version and the operator's config), which under load takes tens to hundreds of
 * milliseconds. The async API yields to the event loop first, so that work never runs inside the caller's own turn
 * (a session_start handler, a render): the caller gets its promise back at once.
 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function safeGit(args: readonly string[], opts: SafeGitOptions): Promise<SafeGitResult> {
  await yieldToEventLoop();
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
    if (p.shadow) dropShadow(p.shadow);
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
    if (p.shadow) dropShadow(p.shadow);
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
  "src/integrations/autospec/provider.ts": {
    kind: "git-plumbing",
    why: "cat-file / show of a committed blob; never reads the worktree or index",
  },
  "src/runtime/host/loader.ts": { kind: "git-plumbing", why: "rev-parse --absolute-git-dir" },
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
