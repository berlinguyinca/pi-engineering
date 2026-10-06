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
      mentions.push({ path: candidate, start: match.index, end: match.index + match[0].length });
    }
  }
  return mentions;
}

/** The sentence/clause of `request` containing [start, end): bounded by `.;!?` + space or newlines. */
function clauseAround(request: string, start: number, end: number): { before: string; after: string } {
  const boundary = /[.;!?](?=\s|$)|\n/g;
  let clauseStart = 0;
  let clauseEnd = request.length;
  for (const match of request.matchAll(boundary)) {
    if (match.index < start) clauseStart = match.index + 1;
    else if (match.index >= end) {
      clauseEnd = match.index;
      break;
    }
  }
  return { before: request.slice(clauseStart, start), after: request.slice(end, clauseEnd) };
}

// Imperative negation directly governing the path (at most three words
// between), so "the build does not pass in /repo" still names /repo.
const NEGATION =
  /\b(?:do not|don'?t|never|must not|should not|shall not|avoid|without|except)\s+(?:[\w'-]+\s+){0,3}["'`]?$/i;
const MUTATION_VERB = /\b(?:modify|change|edit|write|mutate|alter|commit)\b/i;
const READ_ONLY = /\bread[- ]?only\b|\bfor reference\b|\breference only\b|\bas (?:a )?reference\b/i;

const MUTATION_INTO =
  /\b(?:modify|edit|change|write|delete|remove|create|refactor|implement|fix|update|rewrite)\b(?:\s+[\w'-]+){0,3}\s+(?:in|into|inside|within|under)\s*["'`]?$/i;

function directsMutationInto(before: string): boolean {
  return MUTATION_INTO.test(before);
}

/**
 * What the request asks of a mentioned path. A path in a negation ("do not
 * touch X") is not authority at all; one described as read-only ("use X as
 * read-only evidence", "do not modify X") may be read but never written.
 */
function mentionIntent(request: string, mention: PathMention): "write" | "read" | "ignore" {
  const { before, after } = clauseAround(request, mention.start, mention.end);
  const clause = `${before} ${after}`;
  if (READ_ONLY.test(clause)) return "read";
  if (NEGATION.test(before)) return MUTATION_VERB.test(before) ? "read" : "ignore";
  return "write";
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
    // Filter request-derived candidates down to existing directories so prose
    // tokens that survive extraction never block resolution. Symlinks are
    // accepted here via lstat; the downstream symlink-boundary check still applies.
    // resolveRepository (legacy explicit repository argument) keeps failing loudly.
    //
    // A path extracted from prose is a candidate, never an obligation: a quoted
    // "/" or a protected directory, a directory outside any Git repository, and
    // a path in a negation ("do not touch X") are ignored rather than refusing
    // the mission. A path described as read-only becomes a read root with no
    // writable repository binding.
    const existing: string[] = [];
    const readOnly: string[] = [];
    for (const mention of explicitPathMentions(request)) {
      const intent = mentionIntent(request, mention);
      if (intent === "ignore") continue;
      const path = mention.path;
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      // A protected target (filesystem root, home, Pi/Codex config) is only
      // refused when the request directs mutation INTO it ('Modify files in
      // "/"'); mentioned anywhere else ('mount the app at "/"') it is prose.
      if (protectedReason(path)) {
        if (directsMutationInto(clauseAround(request, mention.start, mention.end).before)) existing.push(path);
        continue;
      }
      if (intent === "read") {
        readOnly.push(path);
        continue;
      }
      if (!(await GitRepo.open(path).catch(() => null))) continue;
      existing.push(path);
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
