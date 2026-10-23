/**
 * Issue discovery and explicit linkage (T05).
 *
 * A LINK needs an explicit reference: a ref written in the mission goal, a task, a strict
 * branch name (`issue-12`, `gh-12`), the closing-keyword lines of a PR body, or an
 * operator / AutoSpec mapping. Anything found by search or by a weak branch shape
 * (`12-slug`) is only a SUGGESTION with a reason; it becomes a link through
 * {@link confirmSuggestion} (an operator act), never by itself.
 *
 * Inert without a client: `client === null` returns `{ status: "disabled" }` and touches nothing.
 * Every issue title/body that comes back is already bounded and redacted by the client.
 */
import { type GithubClient, GithubClientError } from "./client.ts";
import {
  type GithubRef,
  type RefConfig,
  type RepoKey,
  canonicalId,
  defaultRepoOf,
  extractGithubRefs,
  parseGithubRef,
  refKey,
} from "./refs.ts";
import { boundTitle } from "./sanitize.ts";
import {
  type GithubLinkRecord,
  type GithubLinkSuggestion,
  type LinkProvenance,
  type LinkSubject,
  linkIdFor,
  suggestionIdFor,
} from "./types.ts";

/** The slice of MissionStore the layer writes through (so a fake is trivial). */
export interface GithubLinkStore {
  recordGithubLink(record: GithubLinkRecord): GithubLinkRecord;
  suggestGithubLink(suggestion: GithubLinkSuggestion): GithubLinkSuggestion | undefined;
  resolveGithubSuggestion(
    suggestionId: string,
    resolution: "confirmed" | "dismissed",
    actor?: "user" | "system",
  ): boolean;
  getGithubSuggestion(suggestionId: string): GithubLinkSuggestion | undefined;
  listGithubLinks(missionId?: string): GithubLinkRecord[];
}

export interface DiscoveryTask {
  id: string;
  title?: string;
  description?: string;
  branch?: string;
}

export interface OperatorMapping {
  subject: LinkSubject;
  /** Any form {@link parseGithubRef} accepts. */
  ref: string;
  provenance?: "operator" | "autospec";
}

export interface DiscoveryInput {
  missionId: string;
  goal: string;
  tasks?: readonly DiscoveryTask[];
  /** Mission branch, if any. */
  branch?: string;
  mappings?: readonly OperatorMapping[];
  /** Repos to search for suggestions; default: the configured default repo. */
  searchRepos?: readonly RepoKey[];
  searchLimit?: number;
}

export interface DiscoveryResult {
  status: "disabled" | "ok";
  linked: GithubLinkRecord[];
  suggested: GithubLinkSuggestion[];
  /** Written references that could not be linked (missing issue, ambiguous, not accepted). */
  unresolved: Array<{ text: string; subject: LinkSubject; reason: string }>;
  errors: Array<{ kind: string; message: string; target?: string }>;
}

const MAX_SUGGESTIONS = 10;
const STOP = new Set(
  "this that with from have will make need needs into when then than should could would about their there which also only just more most some such each other over under after before using used issue issues task tasks mission goal please implement add fix update create build".split(
    " ",
  ),
);

export interface BranchRef {
  ref: GithubRef;
  strength: "explicit" | "weak";
}

/** Strict branch shapes on the LAST path segment. `issue-12`/`gh-12` are explicit; `12-slug` is weak. */
export function branchIssueRef(branch: string, cfg: RefConfig): BranchRef | undefined {
  if (typeof branch !== "string" || branch.length > 255) return undefined;
  const last = branch.split("/").pop() ?? "";
  const repo = defaultRepoOf(cfg);
  if (!repo) return undefined;
  const prefixed = /^(?:issue|gh)-([1-9][0-9]{0,8})(?:-[a-z0-9._-]+)?$/i.exec(last);
  const weak = /^([1-9][0-9]{0,5})-[a-z0-9][a-z0-9._-]*$/i.exec(last);
  const m = prefixed ?? weak;
  if (!m) return undefined;
  const parsed = parseGithubRef(`${repo.host}/${repo.owner}/${repo.repo}#${m[1]}`, cfg);
  return parsed.ok ? { ref: parsed.ref, strength: prefixed ? "explicit" : "weak" } : undefined;
}

/** References introduced by closing keywords (`Closes #1, fixes o/r#2`) in a PR body. */
export function closingRefs(body: string, cfg: RefConfig, opts: { truncated?: boolean } = {}): GithubRef[] {
  const out = new Map<string, GithubRef>();
  let source = typeof body === "string" ? body : "";
  // A cut body ends in a possibly partial token (`#12345` -> `#1`): never read the last line.
  if (opts.truncated) source = source.includes("\n") ? source.slice(0, source.lastIndexOf("\n")) : "";
  const text = source
    .slice(0, 1024 * 1024)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  // keyword, then only the references directly following it ("Closes #1, #2 and o/r#3"); prose ends the list.
  const re =
    /(?<![A-Za-z0-9_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \t]*:?[ \t]*((?:(?:https:\/\/\S+|[A-Za-z0-9._/-]*#[0-9]+)[ \t]*(?:,|\band\b|&)?[ \t]*)+)/gi;
  for (const m of text.matchAll(re)) {
    for (const ref of extractGithubRefs(m[1] ?? "", cfg)) out.set(refKey(ref), ref);
  }
  return [...out.values()];
}

function keywords(goal: string): string {
  const words = goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^[0-9]+$/.test(w));
  return [...new Set(words)].slice(0, 8).join(" ");
}

export async function discoverGithubLinks(
  client: GithubClient | null,
  store: GithubLinkStore,
  cfg: RefConfig,
  input: DiscoveryInput,
  now: () => string = () => new Date().toISOString(),
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { status: "disabled", linked: [], suggested: [], unresolved: [], errors: [] };
  if (!client) return result;
  result.status = "ok";

  const candidates: Array<{
    subject: LinkSubject;
    ref: GithubRef;
    provenance: LinkProvenance;
    source: string;
  }> = [];
  const missionSubject: LinkSubject = { kind: "mission", id: input.missionId };
  const take = (subject: LinkSubject, text: string | undefined, source: string): void => {
    for (const ref of extractGithubRefs(text ?? "", cfg))
      candidates.push({ subject, ref, provenance: "explicit_ref", source });
  };
  take(missionSubject, input.goal, "goal");
  for (const task of input.tasks ?? []) {
    const subject: LinkSubject = { kind: "task", id: task.id };
    take(subject, task.title, `task:${task.id}:title`);
    take(subject, task.description, `task:${task.id}:description`);
  }
  const weakBranches: Array<{ subject: LinkSubject; ref: GithubRef; source: string }> = [];
  const branches: Array<[LinkSubject, string | undefined]> = [
    [missionSubject, input.branch],
    ...(input.tasks ?? []).map((t): [LinkSubject, string | undefined] => [{ kind: "task", id: t.id }, t.branch]),
  ];
  for (const [subject, branch] of branches) {
    const found = branch ? branchIssueRef(branch, cfg) : undefined;
    if (!found) continue;
    if (found.strength === "explicit")
      candidates.push({ subject, ref: found.ref, provenance: "explicit_ref", source: "branch" });
    else weakBranches.push({ subject, ref: found.ref, source: "branch" });
  }
  for (const mapping of input.mappings ?? []) {
    const parsed = parseGithubRef(mapping.ref, cfg);
    if (!parsed.ok) {
      result.unresolved.push({
        text: boundTitle(mapping.ref).slice(0, 80),
        subject: mapping.subject,
        reason: parsed.reason,
      });
      continue;
    }
    candidates.push({
      subject: mapping.subject,
      ref: parsed.ref,
      provenance: mapping.provenance ?? "operator",
      source: "operator",
    });
  }

  const linkedKeys = new Set<string>();
  const seen = new Set<string>();
  for (const c of candidates) {
    const dedupe = `${c.subject.kind}:${c.subject.id}|${refKey(c.ref)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const link = await linkExistingRef(
      client,
      store,
      input.missionId,
      c.subject,
      c.ref,
      c.provenance,
      c.source,
      now,
      result,
    );
    if (link) {
      result.linked.push(link);
      linkedKeys.add(refKey(c.ref));
    }
  }

  const suggest = async (subject: LinkSubject, ref: GithubRef, reason: string): Promise<void> => {
    if (linkedKeys.has(refKey(ref)) || result.suggested.length >= MAX_SUGGESTIONS) return;
    try {
      const item = await client.getIssue(ref);
      if (item.state !== "open") return;
      const target = canonicalId(item.ref);
      if (!target) return;
      const stored = store.suggestGithubLink({
        suggestionId: suggestionIdFor(input.missionId, subject, target),
        missionId: input.missionId,
        subject,
        target,
        targetKind: item.ref.kind,
        reason,
        title: item.title,
        state: "pending",
        recordedAt: now(),
      });
      if (stored) result.suggested.push(stored);
    } catch (error) {
      noteError(result, error, refKey(ref));
    }
  };
  for (const w of weakBranches)
    await suggest(w.subject, w.ref, "branch name starts with an issue-like number (not an explicit reference)");

  const repos = input.searchRepos ?? [defaultRepoOf(cfg)].filter((r): r is RepoKey => r !== undefined);
  const terms = keywords(input.goal);
  if (terms) {
    for (const repo of repos) {
      try {
        const hits = await client.searchIssues(repo, terms, input.searchLimit ?? 5);
        for (const hit of hits) {
          if (hit.state !== "open" || linkedKeys.has(refKey(hit.ref))) continue;
          const target = canonicalId(hit.ref);
          if (!target || result.suggested.length >= MAX_SUGGESTIONS) continue;
          const stored = store.suggestGithubLink({
            suggestionId: suggestionIdFor(input.missionId, missionSubject, target),
            missionId: input.missionId,
            subject: missionSubject,
            target,
            targetKind: hit.ref.kind,
            reason: `search match in ${repo.owner}/${repo.repo} for "${terms}" (needs confirmation)`,
            title: hit.title,
            state: "pending",
            recordedAt: now(),
          });
          if (stored) result.suggested.push(stored);
        }
      } catch (error) {
        noteError(result, error, `${repo.owner}/${repo.repo}`);
      }
    }
  }
  return result;
}

function noteError(result: DiscoveryResult, error: unknown, target: string): void {
  result.errors.push({
    kind: error instanceof GithubClientError ? error.kind : "error",
    message: boundTitle(error instanceof Error ? error.message : String(error)),
    target,
  });
}

/** Look the reference up (decides issue vs PR, proves it exists), then record the link. */
export async function linkExistingRef(
  client: GithubClient,
  store: GithubLinkStore,
  missionId: string,
  subject: LinkSubject,
  ref: GithubRef,
  provenance: LinkProvenance,
  source: string,
  now: () => string,
  result?: DiscoveryResult,
  viaPr?: string,
): Promise<GithubLinkRecord | undefined> {
  try {
    const item = await client.getIssue(ref);
    if (ref.kind !== "unknown" && ref.kind !== item.ref.kind) {
      result?.unresolved.push({
        text: refKey(ref),
        subject,
        reason: `URL says ${ref.kind} but GitHub says ${item.ref.kind}`,
      });
      return undefined;
    }
    const target = canonicalId(item.ref);
    if (!target) return undefined;
    return store.recordGithubLink({
      linkId: linkIdFor(missionId, subject, target),
      missionId,
      subject,
      target,
      targetKind: item.ref.kind,
      provenance,
      source,
      ...(viaPr ? { viaPr } : {}),
      observed: { state: item.state, title: item.title, observedAt: now() },
      status: "active",
      recordedAt: now(),
    });
  } catch (error) {
    if (result) {
      if (error instanceof GithubClientError && error.kind === "not_found")
        result.unresolved.push({ text: refKey(ref), subject, reason: "no such issue or PR" });
      else noteError(result, error, refKey(ref));
    }
    return undefined;
  }
}

/** Operator act: turn a pending suggestion into a link (after re-checking it still exists). */
export async function confirmSuggestion(
  client: GithubClient | null,
  store: GithubLinkStore,
  cfg: RefConfig,
  suggestionId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<GithubLinkRecord | undefined> {
  if (!client) return undefined;
  const s = store.getGithubSuggestion(suggestionId);
  if (!s || s.state !== "pending") return undefined;
  const m = /^(?:issue|pr):(.+)$/.exec(s.target);
  const parsed = m
    ? parseGithubRef(`https://${(m[1] as string).replace("#", `/${s.targetKind === "pr" ? "pull" : "issues"}/`)}`, cfg)
    : undefined;
  if (!parsed?.ok) return undefined;
  const link = await linkExistingRef(
    client,
    store,
    s.missionId,
    s.subject,
    parsed.ref,
    "confirmed_suggestion",
    `suggestion:${s.suggestionId}`,
    now,
  );
  if (link) store.resolveGithubSuggestion(suggestionId, "confirmed", "user");
  return link;
}

export function dismissSuggestion(store: GithubLinkStore, suggestionId: string): boolean {
  return store.resolveGithubSuggestion(suggestionId, "dismissed", "user");
}
