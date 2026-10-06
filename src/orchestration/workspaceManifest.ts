import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { GitRepo } from "../git/GitRepo.ts";
import type { AuthorizedRoot, RepositoryBinding, WorkspaceManifest } from "./types.ts";

export class WorkspaceScopeError extends Error {
  readonly category = "WORKSPACE_SCOPE_MISMATCH" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceScopeError";
  }
}

export interface ResolvedWorkspace {
  authorizedRoots: AuthorizedRoot[];
  repositories: RepositoryBinding[];
  dependencyEdges: WorkspaceManifest["dependencyEdges"];
  primaryRepoId: string;
}

const TRAILING_PROSE = /[,:;!?]+$/;

function stripUnquotedPunctuation(candidate: string): string {
  let stripped = candidate.replace(TRAILING_PROSE, "");
  while (stripped.endsWith(".") && !stripped.endsWith("/.")) stripped = stripped.slice(0, -1);
  return stripped;
}

interface PathMention {
  path: string;
  start: number;
  end: number;
}

function explicitPathMentions(request: string): PathMention[] {
  const mentions: PathMention[] = [];
  const quotedRanges: Array<{ start: number; end: number }> = [];
  for (const match of request.matchAll(/(["'`])(\/.*?)\1/gs)) {
    const candidate = match[2] ?? "";
    const end = match.index + match[0].length;
    if (isAbsolute(candidate)) mentions.push({ path: candidate, start: match.index, end });
    quotedRanges.push({ start: match.index, end });
  }
  for (const match of request.matchAll(/(?<![/:])\/[A-Za-z0-9._~][^\s"'`<>()[\]{}]*/g)) {
    if (quotedRanges.some((range) => match.index >= range.start && match.index < range.end)) continue;
    const candidate = stripUnquotedPunctuation(match[0]);
    if (candidate.length > 1 && isAbsolute(candidate)) {
      // The span ends at the path itself so trailing prose punctuation (", ")
      // stays available as a clause boundary.
      mentions.push({ path: candidate, start: match.index, end: match.index + candidate.length });
    }
  }
  return mentions.sort((left, right) => left.start - right.start);
}

/** Sentence boundaries: a mention's intent never reaches past these. */
const SENTENCE_BOUNDARY = /[.;!?](?=\s|$)|\n/g;
/** Clause boundaries inside a sentence: each path is classified only within its own clause. */
const CLAUSE_BOUNDARY = /[,:()]|\s(?:and|but|while|whereas|then)\s/gi;
/** Text between two mentions that only joins them into one list ("X, Y and Z"). */
const LIST_CONNECTOR = /^\s*(?:,\s*)?(?:(?:and|or|nor|&)\s+)?$/i;

/**
 * Canonical form of prose for intent matching: compatibility-normalized
 * (full-width letters), invisible characters removed, typographic quotes
 * folded, so look-alike text cannot hide a negation or a read-only marker.
 */
function normalizeProse(text: string): string {
  return text.normalize("NFKC").replace(/[­​-‏⁠-⁤﻿]/g, "").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

// A negation only removes authority when it directs a verb at the path ("do
// not touch X", "never modify X"); "do not stop until X passes" or "don't just
// read X" still name X as the target.
const NEGATED_VERB =
  /\b(?:do not|don't|dont|never|must not|should not|shall not|may not|cannot|can't)\s+(?:ever\s+)?(touch|use|modify|edit|change|alter|mutate|delete|remove|write (?:to|into|in)|commit (?:to|into|in)|push to)\s+(?:(?:anything|files?|code)\s+(?:in|under|inside|within)\s+)?(?:the\s+(?:repo(?:sitory)?|directory|folder|checkout)\s+(?:at\s+)?)?["'`]?$/i;
const AVOIDED_VERB =
  /\b(?:avoid|without)\s+(touching|using|modifying|editing|changing|altering|mutating|deleting|writing to)\s+(?:(?:anything|files?|code)\s+(?:in|under|inside|within)\s+)?["'`]?$/i;
/** Negated verbs that withdraw all authority; any other negated verb still permits reading. */
const TOUCH_ONLY = /^(?:touch|touching|use|using)$/i;
const READ_ONLY =
  /\bread[- ]?only\b|\bfor reference\b|\breference only\b|\bas (?:a )?reference\b|\buntouched\b|\bunmodified\b|\boff[- ]limits\b|\b(?:must|should|shall|may|is|are)\s+not\s+(?:be\s+)?(?:modified|changed|touched|edited|written|altered)\b/i;
const MUTATION_INTO =
  /\b(?:modify|edit|change|write|delete|remove|create|refactor|implement|fix|update|rewrite)\b(?:\s+[\w'-]+){0,3}\s+(?:in|into|inside|within|under)\s*["'`]?$/i;

type MentionIntent = "write" | "read" | "ignore";

interface ClassifiedMention extends PathMention {
  intent: MentionIntent;
  /** The mention's own lead-in text, used to detect a directed mutation into a protected path. */
  before: string;
}

function boundariesOutside(text: string, pattern: RegExp, skip: PathMention[]): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].length;
    if (skip.some((range) => match.index < range.end && end > range.start)) continue;
    found.push({ start: match.index, end });
  }
  return found;
}

/**
 * Classify what the request asks of each mentioned path, looking only at the
 * path's own clause. Consecutive mentions joined only by a list connector
 * ("X, Y and Z") share one intent. Between two mention groups, the text up to
 * the last clause boundary belongs to the earlier group and the rest to the
 * later one, so "Use X as read-only reference and implement in Y" reads X as
 * read-only and Y as the target. Ambiguity resolves toward read-only: a wrong
 * read-only verdict fails closed (no writable target), a wrong write does not.
 */
function classifyMentions(request: string, mentions: PathMention[]): ClassifiedMention[] {
  const sentenceBreaks = boundariesOutside(request, SENTENCE_BOUNDARY, mentions);
  const clauseBreaks = boundariesOutside(request, CLAUSE_BOUNDARY, mentions);
  const sentenceOf = (index: number) => sentenceBreaks.filter((range) => range.start < index).length;

  const groups: PathMention[][] = [];
  for (const mention of mentions) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    if (
      group &&
      last &&
      sentenceOf(last.start) === sentenceOf(mention.start) &&
      LIST_CONNECTOR.test(request.slice(last.end, mention.start))
    ) {
      group.push(mention);
    } else {
      groups.push([mention]);
    }
  }

  const classified: ClassifiedMention[] = [];
  groups.forEach((group, index) => {
    const first = group[0]!;
    const last = group.at(-1)!;
    const sentenceStart = sentenceBreaks.filter((range) => range.end <= first.start).at(-1)?.end ?? 0;
    const sentenceEnd = sentenceBreaks.find((range) => range.start >= last.end)?.start ?? request.length;
    const previous = groups[index - 1]?.at(-1);
    const next = groups[index + 1]?.[0];

    // Lead-in: from the last clause boundary before the group, never earlier
    // than the sentence start or the previous group.
    const leadFloor = Math.max(sentenceStart, previous?.end ?? 0);
    const leadStart =
      clauseBreaks.filter((range) => range.start >= leadFloor && range.end <= first.start).at(-1)?.end ?? leadFloor;
    // Tail: up to the last clause boundary before the next group in this
    // sentence; for the sentence's last group, to the end of the sentence.
    const nextInSentence = next && next.start < sentenceEnd ? next : undefined;
    const tailEnd = nextInSentence
      ? (clauseBreaks.filter((range) => range.start >= last.end && range.end <= nextInSentence.start).at(-1)?.start ??
        nextInSentence.start)
      : sentenceEnd;

    const before = normalizeProse(request.slice(leadStart, first.start));
    const after = normalizeProse(request.slice(last.end, tailEnd));
    let intent: MentionIntent = "write";
    const negated = NEGATED_VERB.exec(before) ?? AVOIDED_VERB.exec(before);
    if (negated) intent = TOUCH_ONLY.test(negated[1] ?? "") ? "ignore" : "read";
    else if (READ_ONLY.test(`${before} ${after}`)) intent = "read";
    else if (/^\s*(?:too|as well|also)\b/i.test(after) && classified.at(-1)?.intent === "read") intent = "read";
    for (const mention of group) classified.push({ ...mention, intent, before });
  });
  return classified;
}

/**
 * Extract candidate repository names from the request: the tail of every
 * `x/y` reference (e.g. `inferweave/inferweave`,
 * `metabolomics-us/inferweave-gateway`) plus bare path-like tokens (e.g.
 * `inferweave-gateway`). URLs are excluded by refusing tokens preceded by a
 * path character. Extraction alone grants nothing: every candidate is still
 * filtered by the immediate-child-git-checkout check in
 * resolveChildRepoCandidates, so prose tokens, API paths, and package names
 * that do not name a child checkout are inert.
 */
function requestRepoReferenceNames(request: string): string[] {
  const names = new Set<string>();
  for (const match of request.matchAll(/(?<![\w.@/-])([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
    names.add(match[2]!);
  }
  for (const match of request.matchAll(/(?<![\w./@-])([A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9_-])/g)) {
    names.add(match[1]!);
  }
  return [...names];
}

function isWithin(parent: string, child: string): boolean {
  const canonicalParent = resolve(parent);
  const canonicalChild = resolve(child);
  return canonicalChild === canonicalParent || canonicalChild.startsWith(`${canonicalParent}${sep}`);
}

function protectedReason(candidate: string): string | null {
  const absolute = resolve(candidate);
  const filesystemRoot = parse(absolute).root;
  if (absolute === filesystemRoot) return "filesystem root";
  const home = resolve(homedir());
  if (absolute === home) return "home directory";
  // Pi-managed git checkouts live under <home>/.pi/agent/git/<host>/<owner>/<repo>.
  // Those are the operator's working repositories — this runtime is installed
  // there — not Pi configuration, so they must remain resolvable as workspaces;
  // everything else under .pi/.codex stays protected.
  const agentGitRoot = join(home, ".pi", "agent", "git");
  if (isWithin(agentGitRoot, absolute)) return null;
  for (const configRoot of [join(home, ".pi"), join(home, ".codex")]) {
    if (isWithin(configRoot, absolute)) return "Pi/Codex configuration directory";
  }
  return null;
}

async function canonicalExistingDirectory(candidate: string, source: AuthorizedRoot["source"]): Promise<string> {
  const absolute = resolve(candidate);
  const protectedTarget = protectedReason(absolute);
  if (protectedTarget) throw new WorkspaceScopeError(`Refusing protected ${protectedTarget}: ${absolute}`);

  let stat;
  try {
    stat = await lstat(absolute);
  } catch {
    throw new WorkspaceScopeError(`Workspace target does not exist or has an unauthorized parent: ${absolute}`);
  }
  if (!stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new WorkspaceScopeError(`Workspace target is not a directory: ${absolute}`);
  }
  const canonical = await realpath(absolute);
  if (source === "explicit_user_path" && canonical !== absolute) {
    throw new WorkspaceScopeError(`Explicit workspace path crosses a symlink boundary: ${absolute} -> ${canonical}`);
  }
  const canonicalProtected = protectedReason(canonical);
  if (canonicalProtected) throw new WorkspaceScopeError(`Refusing protected ${canonicalProtected}: ${canonical}`);
  return canonical;
}

function repoIdFor(root: string): string {
  return `repo-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

/** Resolve repository authority only from the user's request or launch cwd. */
export class WorkspaceManifestResolver {
  async resolve(request: string, launchCwd: string): Promise<ResolvedWorkspace> {
    // A path extracted from prose is a candidate, never an obligation: a
    // nonexistent path (an API route such as /v1/events) and a protected
    // directory mentioned as prose ('mount the app at "/"') are ignored, as is
    // a path the request withdraws ("do not touch X"). Every other named path
    // is classified within its own clause: read-only paths become read roots,
    // the rest must bind to a Git repository. Once the request names a path,
    // the launch cwd is never a silent substitute for it: if nothing named is
    // writable the mission is refused.
    // resolveRepository (legacy explicit repository argument) keeps failing loudly.
    const existing: string[] = [];
    const readOnly: string[] = [];
    const unbound: string[] = [];
    let named = 0;
    for (const mention of classifyMentions(request, explicitPathMentions(request))) {
      if (mention.intent === "ignore") continue;
      let path = mention.path;
      try {
        // Symlinks are accepted here via lstat; the downstream
        // symlink-boundary check still applies.
        const stat = await lstat(path);
        if (stat.isFile()) path = dirname(path);
        else if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      // A protected target (filesystem root, home, Pi/Codex config) is only
      // refused when the request directs mutation INTO it ('Modify files in
      // "/"'); mentioned anywhere else it is prose and never becomes writable.
      if (protectedReason(path)) {
        if (mention.intent === "write" && MUTATION_INTO.test(mention.before)) existing.push(path);
        continue;
      }
      named += 1;
      if (mention.intent === "read") {
        readOnly.push(path);
        continue;
      }
      if (!(await GitRepo.open(path).catch(() => null))) {
        unbound.push(path);
        continue;
      }
      existing.push(path);
    }
    if (named > 0 && existing.length === 0) {
      const reason =
        unbound.length > 0
          ? `the named target ${unbound.join(", ")} is not inside a Git repository`
          : "every named path is read-only or excluded";
      throw new WorkspaceScopeError(
        `No writable workspace: ${reason}. Name the repository to modify explicitly (e.g. "implement the change in /path/to/repo"); the launch directory is never used in place of a named path.`,
      );
    }
    let candidates: Array<{ path: string; source: AuthorizedRoot["source"] }> =
      existing.length > 0 ? existing.map((path) => ({ path, source: "explicit_user_path" as const })) : [];
    if (candidates.length === 0) {
      // Workspace-parent mode: launching from a directory that is itself not a
      // git checkout (e.g. a projects root containing many checkouts) is a
      // first-class workflow. The launch cwd cannot be authorized directly, so
      // bind the repositories the request explicitly names (as `owner/repo` or
      // `repo` prose references) when they exist as immediate child git
      // checkouts of the launch cwd. This keeps authority consented — only
      // repositories the request itself names are authorized, never the parent.
      const launchGit = await GitRepo.open(launchCwd).catch(() => null);
      if (!launchGit) {
        const childRepos = await this.resolveChildRepoCandidates(request, launchCwd);
        if (childRepos.length > 0) candidates = childRepos;
      }
    }
    if (candidates.length === 0) candidates = [{ path: launchCwd, source: "launch_cwd" as const }];
    const resolved = await this.resolveCandidates(candidates, launchCwd);
    for (const path of readOnly) {
      const canonical = await realpath(path).catch(() => null);
      if (!canonical || protectedReason(canonical)) continue;
      if (resolved.authorizedRoots.some((root) => root.canonicalPath === canonical)) continue;
      resolved.authorizedRoots.push({ canonicalPath: canonical, source: "explicit_user_path", access: "read" });
    }
    return resolved;
  }

  /**
   * Resolve `owner/repo`-style references from the request to immediate child
   * git checkouts of the launch cwd. A reference only binds when the named
   * directory exists directly under the launch cwd and is itself a git
   * repository rooted exactly there — prose tokens, API paths, and URLs never
   * widen authority.
   */
  private async resolveChildRepoCandidates(
    request: string,
    launchCwd: string,
  ): Promise<Array<{ path: string; source: AuthorizedRoot["source"] }>> {
    const parent = resolve(launchCwd);
    const candidates: Array<{ path: string; source: AuthorizedRoot["source"] }> = [];
    const seen = new Set<string>();
    for (const name of requestRepoReferenceNames(request)) {
      const path = resolve(parent, name);
      if (dirname(path) !== parent || seen.has(path)) continue;
      seen.add(path);
      const git = await GitRepo.open(path).catch(() => null);
      if (git && resolve(git.root) === path) candidates.push({ path, source: "request_repo_reference" });
    }
    return candidates;
  }

  /** Resolve a legacy repository argument through the same authority checks as request-derived roots. */
  async resolveRepository(repository: string): Promise<ResolvedWorkspace> {
    return this.resolveCandidates([{ path: repository, source: "explicit_user_path" }], repository);
  }

  private async resolveCandidates(
    candidates: Array<{ path: string; source: AuthorizedRoot["source"] }>,
    context: string,
  ): Promise<ResolvedWorkspace> {
    const roots = new Map<string, AuthorizedRoot>();
    const repositories = new Map<string, RepositoryBinding>();

    for (const candidate of candidates) {
      const canonical = await canonicalExistingDirectory(candidate.path, candidate.source);
      const git = await GitRepo.open(canonical);
      if (!git) throw new WorkspaceScopeError(`Authorized workspace is not inside a Git repository: ${canonical}`);
      const repoRoot = await realpath(git.root);
      const repoProtected = protectedReason(repoRoot);
      if (repoProtected) throw new WorkspaceScopeError(`Refusing protected ${repoProtected}: ${repoRoot}`);
      if (candidate.source === "explicit_user_path" && !isWithin(repoRoot, canonical)) {
        throw new WorkspaceScopeError(`Explicit path resolved outside its repository binding: ${canonical}`);
      }
      const repoId = repoIdFor(repoRoot);
      roots.set(canonical, { canonicalPath: canonical, source: candidate.source, access: "write" });
      const writableDomain = canonical === repoRoot ? "**" : `${relative(repoRoot, canonical).split(sep).join("/")}/**`;
      const existing = repositories.get(repoId);
      if (!existing) {
        repositories.set(repoId, {
          repoId,
          canonicalRoot: repoRoot,
          baseRef: (await git.currentBranch()) ?? "HEAD",
          baseSha: await git.headCommit(),
          writableDomains: [writableDomain],
        });
      } else if (!existing.writableDomains.includes(writableDomain)) {
        existing.writableDomains.push(writableDomain);
      }
    }

    const orderedRepositories = [...repositories.values()];
    const primary = orderedRepositories[0];
    if (!primary) throw new WorkspaceScopeError(`No authorized Git repository resolved from ${dirname(context)}`);
    return {
      authorizedRoots: [...roots.values()],
      repositories: orderedRepositories,
      dependencyEdges: [],
      primaryRepoId: primary.repoId,
    };
  }
}

export function createWorkspaceManifest(
  resolved: ResolvedWorkspace,
  missionId: string,
  generation = 1,
): WorkspaceManifest {
  const body = {
    missionId,
    generation,
    authorizedRoots: resolved.authorizedRoots,
    repositories: resolved.repositories,
    dependencyEdges: resolved.dependencyEdges,
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return {
    manifestId: `WM-${hash.slice(0, 16)}`,
    ...body,
    hash,
    createdAt: new Date().toISOString(),
  };
}
