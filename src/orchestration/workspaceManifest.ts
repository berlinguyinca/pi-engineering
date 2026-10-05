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

function explicitAbsolutePaths(request: string): string[] {
  const paths: string[] = [];
  const quotedRanges: Array<{ start: number; end: number }> = [];
  for (const match of request.matchAll(/(["'`])(\/.*?)\1/gs)) {
    const candidate = match[2] ?? "";
    if (isAbsolute(candidate)) paths.push(candidate);
    quotedRanges.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of request.matchAll(/(?<![/:])\/[A-Za-z0-9._~][^\s"'`<>()[\]{}]*/g)) {
    if (quotedRanges.some((range) => match.index >= range.start && match.index < range.end)) continue;
    const candidate = stripUnquotedPunctuation(match[0]);
    if (candidate.length > 1 && isAbsolute(candidate)) paths.push(candidate);
  }
  return paths;
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
  for (const match of request.matchAll(
    /(?<![\w.@/-])([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g,
  )) {
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
    const existing = (
      await Promise.all(
        explicitAbsolutePaths(request).map(async (path) => {
          try {
            const stat = await lstat(path);
            return stat.isDirectory() || stat.isSymbolicLink() ? path : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter((path): path is string => path !== null);
    let candidates: Array<{ path: string; source: AuthorizedRoot["source"] }> =
      existing.length > 0
        ? existing.map((path) => ({ path, source: "explicit_user_path" as const }))
        : [];
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
    return this.resolveCandidates(candidates, launchCwd);
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
