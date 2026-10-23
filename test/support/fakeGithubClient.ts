import {
  type GhDependencies,
  type GhIssue,
  type GhIssueSummary,
  type GhPullRequest,
  type GithubClient,
  GithubClientError,
  type GithubErrorKind,
} from "../../src/github/client.ts";
import { type GithubRef, type RepoKey, refKey } from "../../src/github/refs.ts";
import { boundBody, parseableBody } from "../../src/github/sanitize.ts";

interface FakeIssue {
  title: string;
  body?: string;
  state: "open" | "closed";
  stateReason?: string;
  pr?: { state: "open" | "closed" | "merged"; headSha: string; body?: string };
  deps?: GhDependencies;
}

/** In-memory GitHub. Keys are `host/owner/repo#n`. */
export class FakeGithubClient implements GithubClient {
  readonly id = "fake";
  readonly items = new Map<string, FakeIssue>();
  readonly searchResults: GhIssueSummary[] = [];
  readonly calls: string[] = [];
  /** key or "*" -> error to throw for that target. */
  readonly failures = new Map<string, GithubClientError>();
  supportsDependencies = true;

  put(key: string, item: FakeIssue): void {
    this.items.set(key, item);
  }
  fail(key: string, kind: GithubErrorKind, retryAfterMs?: number): void {
    this.failures.set(key, new GithubClientError(kind, `fake ${kind}`, retryAfterMs));
  }
  /** Fail the next `times` lookups of `key` with `kind`, then behave normally (a transient 404 that heals). */
  failTimes(key: string, kind: GithubErrorKind, times: number): void {
    this.countedFailures.set(key, { error: new GithubClientError(kind, `fake ${kind}`), left: times });
  }
  private readonly countedFailures = new Map<string, { error: GithubClientError; left: number }>();
  heal(key: string): void {
    this.failures.delete(key);
  }
  private lookup(ref: GithubRef): FakeIssue {
    const key = refKey(ref);
    const failure = this.failures.get(key) ?? this.failures.get("*");
    if (failure) throw failure;
    const counted = this.countedFailures.get(key);
    if (counted && counted.left > 0) {
      counted.left--;
      throw counted.error;
    }
    const item = this.items.get(key);
    if (!item) throw new GithubClientError("not_found", "not found");
    return item;
  }
  async getIssue(ref: GithubRef): Promise<GhIssue> {
    this.calls.push(`issue ${refKey(ref)}`);
    const item = this.lookup(ref);
    return {
      ref: { host: ref.host, owner: ref.owner, repo: ref.repo, number: ref.number, kind: item.pr ? "pr" : "issue" },
      title: item.title,
      body: boundBody(item.body).text,
      parseBody: parseableBody(item.body).text,
      bodyTruncated: parseableBody(item.body).truncated,
      state: item.state,
      ...(item.stateReason ? { stateReason: item.stateReason } : {}),
      url: `https://${ref.host}/${ref.owner}/${ref.repo}/issues/${ref.number}`,
      labels: [],
      isPullRequest: Boolean(item.pr),
    };
  }
  async getPullRequest(ref: GithubRef): Promise<GhPullRequest> {
    this.calls.push(`pr ${refKey(ref)}`);
    const item = this.lookup(ref);
    if (!item.pr) throw new GithubClientError("not_found", "not a pull request");
    return {
      ref: { host: ref.host, owner: ref.owner, repo: ref.repo, number: ref.number, kind: "pr" },
      title: item.title,
      body: boundBody(item.pr.body ?? item.body).text,
      parseBody: parseableBody(item.pr.body ?? item.body).text,
      bodyTruncated: parseableBody(item.pr.body ?? item.body).truncated,
      state: item.pr.state,
      headSha: item.pr.headSha,
      headRef: "feature",
      baseRef: "main",
      url: `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    };
  }
  async searchIssues(repo: RepoKey, terms: string): Promise<GhIssueSummary[]> {
    this.calls.push(`search ${repo.owner}/${repo.repo} ${terms}`);
    const failure = this.failures.get("search");
    if (failure) throw failure;
    return [...this.searchResults];
  }
  async listDependencies(ref: GithubRef): Promise<GhDependencies> {
    if (!this.supportsDependencies) throw new GithubClientError("unsupported", "no dependency endpoint");
    return this.lookup(ref).deps ?? { blockedBy: [], subIssues: [] };
  }
}
