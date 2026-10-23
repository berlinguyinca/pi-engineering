/**
 * GitHub client port + the `gh`-CLI-backed implementation (T05).
 *
 * OPTIONAL ADAPTER: {@link createGithubClient} returns `null` unless GitHub is explicitly
 * configured, and every consumer treats `null` as "feature inert". Pi core never calls this.
 *
 * Safety of the gh runner:
 *  - argv only (`execFile`, no shell); the executable is a configured path or `gh`.
 *  - Every value that reaches argv is built from a validated {@link GithubRef} (host/owner/repo
 *    charsets, integer number) or a search term restricted to `[A-Za-z0-9 _.-]`. Untrusted
 *    issue text is only ever READ from stdout, never written into argv.
 *  - The API path always starts with `repos/` or `search/`, so it can never parse as a flag; the
 *    search query travels as the value of `-f q=...`, so a leading `-` is data.
 *  - Timeout, stdout cap, `GH_PROMPT_DISABLED`, no pager, no update check.
 */
import { execFile } from "node:child_process";
import type { RestCheckRun } from "../merge/checkRunIngest.ts";
import { type GithubRef, type RefConfig, type RepoKey, normaliseRepo, parseGithubRef, refKey } from "./refs.ts";
import { boundBody, boundTitle, parseableBody } from "./sanitize.ts";

export type GithubErrorKind = "not_found" | "rate_limited" | "auth" | "transient" | "unsupported" | "invalid";

export class GithubClientError extends Error {
  readonly kind: GithubErrorKind;
  readonly retryAfterMs?: number;
  constructor(kind: GithubErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "GithubClientError";
    this.kind = kind;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export type ItemState = "open" | "closed";

/** An issue as observed. `title`/`body` are BOUNDED and REDACTED untrusted text. */
export interface GhIssue {
  ref: GithubRef & { kind: "issue" | "pr" };
  title: string;
  /** Bounded + redacted: for storage and display only. */
  body: string;
  /** Full body for PARSING (never stored); `bodyTruncated` when even that was cut (fail closed). */
  parseBody: string;
  bodyTruncated: boolean;
  state: ItemState;
  stateReason?: string;
  url: string;
  labels: string[];
  /** True when the number is really a PR (GitHub's issue endpoint covers both). */
  isPullRequest: boolean;
}

export interface GhPullRequest {
  ref: GithubRef & { kind: "pr" };
  title: string;
  body: string;
  parseBody: string;
  bodyTruncated: boolean;
  state: "open" | "closed" | "merged";
  headSha: string;
  headRef: string;
  baseRef: string;
  url: string;
}

export interface GhIssueSummary {
  ref: GithubRef & { kind: "issue" | "pr" };
  title: string;
  state: ItemState;
}

export interface GhDependencies {
  blockedBy: GithubRef[];
  subIssues: GithubRef[];
}

export interface GithubClient {
  readonly id: string;
  getIssue(ref: GithubRef): Promise<GhIssue>;
  getPullRequest(ref: GithubRef): Promise<GhPullRequest>;
  searchIssues(repo: RepoKey, terms: string, limit: number): Promise<GhIssueSummary[]>;
  /** Native issue dependency / sub-issue relations; absent when the server cannot answer. */
  listDependencies?(ref: GithubRef): Promise<GhDependencies>;
  listCheckRuns?(ref: GithubRef, sha: string): Promise<RestCheckRun[]>;
  /** T13: an OPEN pull request from `branch` of the same repository, or null. */
  findOpenPullRequestByHead?(repo: RepoKey, branch: string): Promise<GhPullRequest | null>;
  /** T13: open a pull request (draft by default at the caller). Never merges, never closes. */
  createPullRequest?(input: CreatePullRequestInput): Promise<GhPullRequest>;
}

export interface CreatePullRequestInput {
  repo: RepoKey;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

/** A branch name safe to hand to the API: the shape Git allows for ordinary branches, nothing option-like. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\-]*(?:\/[A-Za-z0-9][A-Za-z0-9._\-]*)*$/;

export interface GithubConfig {
  enabled?: boolean;
  /** Accepted hosts; default ["github.com"]. */
  hosts?: string[];
  defaultRepo?: string;
  ghPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export function refConfigOf(config: GithubConfig | undefined): RefConfig {
  return {
    ...(config?.hosts ? { hosts: config.hosts } : {}),
    ...(config?.defaultRepo ? { defaultRepo: config.defaultRepo } : {}),
  };
}

export interface GhRunResult {
  stdout: string;
  stderr: string;
  code: number;
}
export interface GhRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}
export type GhRunner = (argv: readonly string[], options: GhRunOptions) => Promise<GhRunResult>;

/**
 * Environment for `gh`: the caller's environment (gh needs its token, HOME and proxy settings) minus every `GIT_*`
 * variable, so a variable set for some other tool (GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF, GIT_CONFIG_*) cannot make a
 * git subprocess of gh run something unexpected. Only `gh api` is used here and it never reads repository config.
 */
export function ghEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (!k.toUpperCase().startsWith("GIT_")) env[k] = v;
  return { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", NO_COLOR: "1" };
}

export function execGh(ghPath: string): GhRunner {
  return (argv, options) =>
    new Promise((resolve, reject) => {
      execFile(
        ghPath,
        [...argv],
        {
          timeout: options.timeoutMs,
          maxBuffer: options.maxOutputBytes,
          windowsHide: true,
          env: ghEnv(),
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
          const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          if (e.code === "ENOENT") return reject(new GithubClientError("unsupported", "gh executable not found"));
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
            return reject(new GithubClientError("invalid", "gh output exceeded the size cap"));
          if (e.killed) return reject(new GithubClientError("transient", "gh timed out"));
          resolve({ stdout: String(stdout), stderr: String(stderr), code: typeof e.code === "number" ? e.code : 1 });
        },
      );
    });
}

/** Map a failed gh invocation to a typed error. 404 is definitive; timeouts / 5xx are transient. */
export function classifyGhFailure(result: GhRunResult): GithubClientError {
  const text = `${result.stderr}\n${result.stdout}`.slice(0, 4000).toLowerCase();
  const retry = /retry-after[:\s]+(\d+)/.exec(text);
  const retryAfterMs = retry ? Number(retry[1]) * 1000 : undefined;
  if (/rate limit|secondary rate|http 429|abuse detection/.test(text))
    return new GithubClientError("rate_limited", "GitHub rate limit", retryAfterMs);
  if (/http 404|not found|could not resolve to/.test(text)) return new GithubClientError("not_found", "not found");
  if (/http 40[13]|bad credentials|authentication|gh auth login/.test(text))
    return new GithubClientError("auth", "GitHub authentication failed");
  if (/http 5\d\d|timeout|timed out|connection|unreachable/.test(text))
    return new GithubClientError("transient", "GitHub unavailable");
  return new GithubClientError("transient", `gh exited ${result.code}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class GhCliClient implements GithubClient {
  readonly id = "gh-cli";
  private readonly run: GhRunner;
  private readonly refConfig: RefConfig;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(config: GithubConfig, run?: GhRunner) {
    this.refConfig = refConfigOf(config);
    this.run = run ?? execGh(config.ghPath ?? "gh");
    this.timeoutMs = Math.min(Math.max(config.timeoutMs ?? 20_000, 1000), 120_000);
    this.maxOutputBytes = Math.min(Math.max(config.maxOutputBytes ?? 2 * 1024 * 1024, 4096), 16 * 1024 * 1024);
  }

  private repoOf(ref: RepoKey): RepoKey {
    const repo = normaliseRepo(ref.host, ref.owner, ref.repo, this.refConfig);
    if (!repo) throw new GithubClientError("invalid", "repo not accepted");
    return repo;
  }

  private async api(host: string, path: string, extra: readonly string[] = []): Promise<unknown> {
    if (!/^(repos|search)\//.test(path) || /[\s]/.test(path)) throw new GithubClientError("invalid", "bad api path");
    const argv = ["api", "--hostname", host, ...extra, path];
    const result = await this.run(argv, { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes });
    if (result.code !== 0) throw classifyGhFailure(result);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new GithubClientError("transient", "gh returned non-JSON output");
    }
  }

  /** All pages of a list endpoint (`--paginate --slurp`, 100 per page), flattened one level. A cut-off listing is an error, never a short list. */
  private async apiPages(host: string, path: string, itemsKey?: string): Promise<unknown[]> {
    const pages = await this.api(host, path, ["--paginate", "--slurp", "-X", "GET", "-F", "per_page=100"]);
    if (!Array.isArray(pages)) throw new GithubClientError("transient", "unexpected paginated payload");
    const out: unknown[] = [];
    for (const page of pages) {
      const list = itemsKey ? asRecord(page)[itemsKey] : page;
      if (Array.isArray(list)) out.push(...list);
      if (out.length > 2000) throw new GithubClientError("invalid", "listing too large");
    }
    return out;
  }

  private numberPath(ref: GithubRef, tail: string): { repo: RepoKey; path: string } {
    const repo = this.repoOf(ref);
    if (!Number.isSafeInteger(ref.number) || ref.number < 1) throw new GithubClientError("invalid", "bad number");
    return { repo, path: `repos/${repo.owner}/${repo.repo}/${tail.replace("{n}", String(ref.number))}` };
  }

  async getIssue(ref: GithubRef): Promise<GhIssue> {
    const { repo, path } = this.numberPath(ref, "issues/{n}");
    const raw = asRecord(await this.api(repo.host, path));
    const state = raw.state === "closed" ? "closed" : raw.state === "open" ? "open" : undefined;
    if (!state || raw.number !== ref.number) throw new GithubClientError("transient", "unexpected issue payload");
    const isPullRequest = raw.pull_request !== undefined && raw.pull_request !== null;
    const labels = Array.isArray(raw.labels)
      ? raw.labels.slice(0, 50).map((l) => boundTitle(asRecord(l).name ?? l))
      : [];
    return {
      ref: { ...repo, number: ref.number, kind: isPullRequest ? "pr" : "issue" },
      title: boundTitle(raw.title),
      body: boundBody(raw.body).text,
      parseBody: parseableBody(raw.body).text,
      bodyTruncated: parseableBody(raw.body).truncated,
      state,
      ...(typeof raw.state_reason === "string" ? { stateReason: boundTitle(raw.state_reason) } : {}),
      url: str(raw.html_url).slice(0, 500),
      labels,
      isPullRequest,
    };
  }

  async getPullRequest(ref: GithubRef): Promise<GhPullRequest> {
    const { repo, path } = this.numberPath(ref, "pulls/{n}");
    const raw = asRecord(await this.api(repo.host, path));
    const head = asRecord(raw.head);
    const base = asRecord(raw.base);
    const headSha = str(head.sha);
    if (!/^[0-9a-f]{7,64}$/i.test(headSha) || raw.number !== ref.number)
      throw new GithubClientError("transient", "unexpected pull request payload");
    const state = raw.merged === true || raw.merged_at ? "merged" : raw.state === "closed" ? "closed" : "open";
    return {
      ref: { ...repo, number: ref.number, kind: "pr" },
      title: boundTitle(raw.title),
      body: boundBody(raw.body).text,
      parseBody: parseableBody(raw.body).text,
      bodyTruncated: parseableBody(raw.body).truncated,
      state,
      headSha: headSha.toLowerCase(),
      headRef: boundTitle(head.ref).slice(0, 255),
      baseRef: boundTitle(base.ref).slice(0, 255),
      url: str(raw.html_url).slice(0, 500),
    };
  }

  async findOpenPullRequestByHead(repoIn: RepoKey, branch: string): Promise<GhPullRequest | null> {
    const repo = this.repoOf(repoIn);
    if (!SAFE_BRANCH.test(branch) || branch.length > 200) throw new GithubClientError("invalid", "bad branch");
    const raw = await this.api(repo.host, `repos/${repo.owner}/${repo.repo}/pulls`, [
      "-X",
      "GET",
      "-f",
      `head=${repo.owner}:${branch}`,
      "-f",
      "state=open",
      "-F",
      "per_page=5",
    ]);
    if (!Array.isArray(raw)) throw new GithubClientError("transient", "unexpected pull request list");
    for (const item of raw) {
      const r = asRecord(item);
      const head = asRecord(r.head);
      const headRepo = asRecord(head.repo);
      // only a branch of THIS repository: a fork's branch of the same name is somebody else's work
      if (head.ref !== branch || str(headRepo.full_name).toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase())
        continue;
      if (typeof r.number !== "number") continue;
      return this.getPullRequest({ ...repo, number: r.number, kind: "pr" });
    }
    return null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GhPullRequest> {
    const repo = this.repoOf(input.repo);
    if (!SAFE_BRANCH.test(input.head) || !SAFE_BRANCH.test(input.base))
      throw new GithubClientError("invalid", "bad branch");
    const raw = asRecord(
      await this.api(repo.host, `repos/${repo.owner}/${repo.repo}/pulls`, [
        "-X",
        "POST",
        "-f",
        `title=${boundTitle(input.title)}`,
        "-f",
        `head=${input.head}`,
        "-f",
        `base=${input.base}`,
        "-f",
        `body=${boundBody(input.body).text}`,
        "-F",
        `draft=${input.draft ? "true" : "false"}`,
      ]),
    );
    if (typeof raw.number !== "number") throw new GithubClientError("transient", "unexpected pull request payload");
    return this.getPullRequest({ ...repo, number: raw.number, kind: "pr" });
  }

  async searchIssues(repoIn: RepoKey, terms: string, limit: number): Promise<GhIssueSummary[]> {
    const repo = this.repoOf(repoIn);
    const safe = terms
      .replace(/[^A-Za-z0-9 _.-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    if (!safe) return [];
    const perPage = Math.min(Math.max(Math.trunc(limit) || 1, 1), 30);
    const q = `repo:${repo.owner}/${repo.repo} is:issue is:open ${safe}`;
    const raw = asRecord(
      await this.api(repo.host, "search/issues", ["-X", "GET", "-f", `q=${q}`, "-F", `per_page=${perPage}`]),
    );
    const out: GhIssueSummary[] = [];
    for (const item of Array.isArray(raw.items) ? raw.items.slice(0, perPage) : []) {
      const r = asRecord(item);
      const n = typeof r.number === "number" ? r.number : 0;
      const parsed = parseGithubRef(`${repo.host}/${repo.owner}/${repo.repo}#${n}`, this.refConfig);
      if (!parsed.ok) continue;
      out.push({
        ref: { ...parsed.ref, kind: r.pull_request ? "pr" : "issue" },
        title: boundTitle(r.title),
        state: r.state === "closed" ? "closed" : "open",
      });
    }
    return out;
  }

  async listDependencies(ref: GithubRef): Promise<GhDependencies> {
    const read = async (tail: string): Promise<GithubRef[]> => {
      const { repo, path } = this.numberPath(ref, tail);
      let raw: unknown[];
      try {
        raw = await this.apiPages(repo.host, path);
      } catch (error) {
        // The relation endpoints do not exist on older GHES: that is "unsupported", not "issue missing".
        if (error instanceof GithubClientError && error.kind === "not_found")
          throw new GithubClientError("unsupported", "dependency endpoint unavailable");
        throw error;
      }
      const refs: GithubRef[] = [];
      for (const item of raw) {
        const r = asRecord(item);
        const url = str(r.html_url);
        const parsed = parseGithubRef(url, this.refConfig);
        if (parsed.ok) refs.push(parsed.ref);
      }
      return refs;
    };
    return {
      blockedBy: await read("issues/{n}/dependencies/blocked_by"),
      subIssues: await read("issues/{n}/sub_issues"),
    };
  }

  async listCheckRuns(ref: GithubRef, sha: string): Promise<RestCheckRun[]> {
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new GithubClientError("invalid", "bad sha");
    const { repo } = this.numberPath(ref, "issues/{n}");
    const items = await this.apiPages(
      repo.host,
      `repos/${repo.owner}/${repo.repo}/commits/${sha.toLowerCase()}/check-runs`,
      "check_runs",
    );
    const out: RestCheckRun[] = [];
    for (const item of items) {
      const r = asRecord(item);
      if (typeof r.name !== "string") continue;
      out.push({
        name: boundTitle(r.name),
        head_sha: str(r.head_sha),
        status: str(r.status),
        conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
        html_url: str(r.html_url).slice(0, 500),
      });
    }
    return out;
  }
}

/** The client for a configuration; `null` (feature inert) unless GitHub is explicitly enabled. */
export function createGithubClient(config: GithubConfig | undefined, run?: GhRunner): GithubClient | null {
  if (!config || config.enabled !== true) return null;
  return new GhCliClient(config, run);
}

export { refKey };
