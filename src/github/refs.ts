/**
 * Canonical GitHub issue / PR references (T05).
 *
 * Parses every realistic written form of a reference into one repo-qualified
 * identity and serialises it exactly as the lineage contract names nodes:
 * `issue:github.com/<owner>/<repo>#<n>` and `pr:github.com/<owner>/<repo>#<n>`.
 *
 * Rules (each one is tested):
 *  - Pure and optional: nothing here touches the network; Pi never needs GitHub.
 *  - ASCII only. Fullwidth `＃`, Cyrillic lookalikes, zero-width and bidi
 *    characters are rejected, never normalised into a match.
 *  - Host, owner and repo are lowercased (GitHub treats them case-insensitively),
 *    so `Org/Repo#1` and `org/repo#1` are one node.
 *  - A bare `#12` needs a configured default repo; it is never guessed.
 *  - `#12` / `o/r#12` share one numbering for issues and PRs, so a text ref has
 *    kind `unknown` until a `/issues/` or `/pull/` URL or a client lookup decides.
 *    {@link canonicalId} refuses an unknown kind instead of defaulting to `issue:`.
 *  - Hosts come from configuration (default: github.com only). Unknown host => reject.
 *  - Numbers are positive integers without leading zeros, at most 2^31-1.
 */

export type RefKind = "issue" | "pr";

export interface RepoKey {
  host: string;
  owner: string;
  repo: string;
}

export interface GithubRef extends RepoKey {
  number: number;
  /** `unknown` until a URL form or a client lookup decides. */
  kind: RefKind | "unknown";
}

export interface RefConfig {
  /** Accepted hosts (lowercase). Default `["github.com"]`; GHES hosts are added by configuration. */
  hosts?: readonly string[];
  /** Repo a bare `#12` resolves against: "owner/repo" (host github.com or the first configured host) or a RepoKey. */
  defaultRepo?: string | RepoKey;
}

export type RefParse = { ok: true; ref: GithubRef } | { ok: false; reason: string };

export const MAX_ISSUE_NUMBER = 2_147_483_647;
export const MAX_REF_INPUT_CHARS = 2048;
export const MAX_SCAN_CHARS = 64 * 1024;
export const MAX_SCAN_REFS = 200;
const MAX_LINEAGE_ID_CHARS = 200;

const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const REPO_RE = /^[a-z0-9._-]{1,100}$/;
const NUMBER_RE = /^[1-9][0-9]{0,9}$/;
const NON_ASCII_OR_CONTROL = /[^ -~]/;

function hostsOf(cfg: RefConfig): string[] {
  const hosts = (cfg.hosts?.length ? cfg.hosts : ["github.com"]).map((h) => h.trim().toLowerCase());
  return hosts.filter((h) => HOST_RE.test(h));
}

/** Validate and lowercase a repo identity; undefined when it is not a safe GitHub repo. */
export function normaliseRepo(host: string, owner: string, repo: string, cfg: RefConfig = {}): RepoKey | undefined {
  const h = host.toLowerCase();
  const o = owner.toLowerCase();
  const r = repo.toLowerCase();
  if (!hostsOf(cfg).includes(h)) return undefined;
  if (!OWNER_RE.test(o) || !REPO_RE.test(r)) return undefined;
  if (r === "." || r === ".." || r.endsWith(".git")) return undefined;
  return { host: h, owner: o, repo: r };
}

function parseNumber(text: string): number | undefined {
  if (!NUMBER_RE.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= MAX_ISSUE_NUMBER ? n : undefined;
}

/** Resolve `cfg.defaultRepo` to a validated RepoKey. */
export function defaultRepoOf(cfg: RefConfig): RepoKey | undefined {
  const d = cfg.defaultRepo;
  if (!d) return undefined;
  if (typeof d !== "string") return normaliseRepo(d.host, d.owner, d.repo, cfg);
  const m = /^(?:([A-Za-z0-9.-]+)\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(d.trim());
  if (!m) return undefined;
  return normaliseRepo(m[1] ?? hostsOf(cfg)[0] ?? "github.com", m[2] as string, m[3] as string, cfg);
}

/**
 * Parse ONE reference. The whole input must be the reference (surrounding ASCII
 * whitespace is allowed); trailing junk is a rejection, not a partial match.
 */
export function parseGithubRef(input: string, cfg: RefConfig = {}): RefParse {
  if (typeof input !== "string") return { ok: false, reason: "not a string" };
  if (input.length > MAX_REF_INPUT_CHARS) return { ok: false, reason: "input too long" };
  const text = input.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (NON_ASCII_OR_CONTROL.test(text)) return { ok: false, reason: "non-ASCII or control character" };

  const url = /^https:\/\/([^/?#@\s:]+)\/([^/?#\s]+)\/([^/?#\s]+)\/(issues|pull)\/([^/?#\s]+)\/?(?:[?#]\S*)?$/.exec(
    text,
  );
  if (url) {
    const repo = normaliseRepo(url[1] as string, url[2] as string, url[3] as string, cfg);
    if (!repo) return { ok: false, reason: "host, owner or repo not accepted" };
    const number = parseNumber(url[5] as string);
    if (number === undefined) return { ok: false, reason: "invalid issue number" };
    return { ok: true, ref: { ...repo, number, kind: url[4] === "pull" ? "pr" : "issue" } };
  }
  if (/^https?:\/\//i.test(text)) return { ok: false, reason: "unsupported URL form (https issues/pull only)" };

  const qualified = /^(?:([a-z0-9.-]+)\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#([0-9]+)$/i.exec(text);
  if (qualified) {
    const repo = normaliseRepo(
      qualified[1] ?? hostsOf(cfg)[0] ?? "github.com",
      qualified[2] as string,
      qualified[3] as string,
      cfg,
    );
    if (!repo) return { ok: false, reason: "host, owner or repo not accepted" };
    const number = parseNumber(qualified[4] as string);
    if (number === undefined) return { ok: false, reason: "invalid issue number" };
    return { ok: true, ref: { ...repo, number, kind: "unknown" } };
  }

  const bare = /^#([0-9]+)$/.exec(text);
  if (bare) {
    const repo = defaultRepoOf(cfg);
    if (!repo) return { ok: false, reason: "bare #N needs a configured default repo" };
    const number = parseNumber(bare[1] as string);
    if (number === undefined) return { ok: false, reason: "invalid issue number" };
    return { ok: true, ref: { ...repo, number, kind: "unknown" } };
  }
  return { ok: false, reason: "unrecognised reference form" };
}

/** Same ref with its kind decided (by a lookup). A conflicting known kind is refused. */
export function withKind(ref: GithubRef, kind: RefKind): GithubRef | undefined {
  if (ref.kind !== "unknown" && ref.kind !== kind) return undefined;
  return { ...ref, kind };
}

/** `host/owner/repo#n`, the id part shared by both kinds. */
export function refKey(ref: GithubRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`;
}

/** Canonical lineage node id; undefined for an unknown kind or an id that exceeds the contract bound. */
export function canonicalId(ref: GithubRef): string | undefined {
  if (ref.kind === "unknown") return undefined;
  const key = refKey(ref);
  return key.length > MAX_LINEAGE_ID_CHARS ? undefined : `${ref.kind}:${key}`;
}

/** Inverse of {@link canonicalId}; strict (no host allowlist: ids come from our own durable data, re-checked for shape). */
export function parseCanonicalId(id: string, cfg: RefConfig = {}): GithubRef | undefined {
  const m = /^(issue|pr):([a-z0-9.-]+)\/([a-z0-9-]+)\/([a-z0-9._-]+)#([0-9]+)$/.exec(id);
  if (!m) return undefined;
  const repo = normaliseRepo(m[2] as string, m[3] as string, m[4] as string, cfg);
  const number = parseNumber(m[5] as string);
  if (!repo || number === undefined) return undefined;
  return { ...repo, number, kind: m[1] as RefKind };
}

export function sameRepo(a: RepoKey, b: RepoKey): boolean {
  return a.host === b.host && a.owner === b.owner && a.repo === b.repo;
}

/**
 * Find references inside free text (goal, task, branch, PR body). Bounded (64 KiB, 200 refs),
 * deduplicated by identity (a URL's known kind wins over an unknown one), in order of appearance.
 * Matches only on token boundaries: `abc#12`, `&#123;`, `#12abc` and `a/b/c#1` are not references.
 */
export function extractGithubRefs(text: string, cfg: RefConfig = {}): GithubRef[] {
  if (typeof text !== "string" || !text) return [];
  let scan = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const found = new Map<string, GithubRef>();
  const add = (ref: GithubRef): void => {
    const key = refKey(ref);
    const prev = found.get(key);
    if (!prev) {
      if (found.size < MAX_SCAN_REFS) found.set(key, ref);
    } else if (prev.kind === "unknown" && ref.kind !== "unknown") found.set(key, ref);
  };

  scan = scan.replace(
    /(?<![A-Za-z0-9_@./-])https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/(?:issues|pull)\/[0-9]+(?![0-9A-Za-z_])(?:\/(?![A-Za-z0-9_-]))?(?:[?#][^\s)>\]]*)?/g,
    (match) => {
      const parsed = parseGithubRef(match, cfg);
      if (parsed.ok) add(parsed.ref);
      return " ".repeat(match.length);
    },
  );

  const re = /(?<![A-Za-z0-9_@/.&#-])((?:[a-z0-9.-]+\/)?[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)?#([0-9]+)(?![0-9A-Za-z_])/gi;
  for (const m of scan.matchAll(re)) {
    const parsed = parseGithubRef(`${m[1] ?? ""}#${m[2]}`, cfg);
    if (parsed.ok) add(parsed.ref);
  }
  return [...found.values()];
}
