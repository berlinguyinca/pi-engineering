import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { GitRepo } from "../git/GitRepo.ts";
import { type PathIntent, classifyPathIntents } from "./pathIntent.ts";
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

/** System and credential locations that are never a workspace, whatever the request says. */
const PROTECTED_SYSTEM_ROOTS = ["/etc", "/root", "/boot", "/sys", "/proc", "/dev"];
const PROTECTED_HOME_ROOTS: Array<[string, string]> = [
  [".pi", "Pi/Codex configuration directory"],
  [".codex", "Pi/Codex configuration directory"],
  [".claude", "agent configuration directory"],
  [".ssh", "credential directory"],
  [".gnupg", "credential directory"],
  [".aws", "credential directory"],
  [join(".config", "gcloud"), "credential directory"],
];

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
  for (const [relativeRoot, reason] of PROTECTED_HOME_ROOTS) {
    if (isWithin(join(home, relativeRoot), absolute)) return reason;
  }
  for (const systemRoot of PROTECTED_SYSTEM_ROOTS) {
    if (isWithin(systemRoot, absolute)) return "system directory";
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

/** Damerau-Levenshtein distance at most one (one edit or one adjacent transposition). */
function withinOneEdit(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  while (i < left.length && i < right.length && left[i] === right[i]) i++;
  const tail = (a: string, b: string) => a.slice(i + 1) === b.slice(i + 1);
  if (left.length === right.length) {
    return (
      tail(left, right) ||
      (left[i] === right[i + 1] && left[i + 1] === right[i] && left.slice(i + 2) === right.slice(i + 2))
    );
  }
  return left.length > right.length ? left.slice(i + 1) === right.slice(i) : left.slice(i) === right.slice(i + 1);
}

/** The deepest existing ancestor of a missing path, and the first missing segment below it. */
async function nearestExisting(path: string): Promise<{ ancestor: string; missingSegment: string }> {
  let current = resolve(path);
  let missingSegment = basename(current);
  while (true) {
    const parent = dirname(current);
    try {
      await lstat(parent);
      return { ancestor: parent, missingSegment: basename(current) };
    } catch {
      if (parent === current) return { ancestor: parent, missingSegment };
      missingSegment = basename(current);
      current = parent;
    }
  }
}

/**
 * Whether a missing path is a filesystem path the user meant (a typo, a
 * repository not cloned yet) rather than prose such as an API route
 * ("/api/v1/users"): it lives under an existing directory other than the
 * filesystem root, or its first missing segment is a near-miss of an existing
 * sibling ("/TMP/…", "/hmoe/…").
 */
async function looksLikeMissingFilesystemPath(path: string): Promise<{ real: boolean; ancestor: string }> {
  const { ancestor, missingSegment } = await nearestExisting(path);
  if (ancestor !== parse(ancestor).root) return { real: true, ancestor };
  const siblings = await readdir(ancestor).catch(() => [] as string[]);
  const lower = missingSegment.toLowerCase();
  const real = siblings.some(
    (sibling) =>
      sibling.toLowerCase() === lower || (missingSegment.length >= 5 && withinOneEdit(sibling.toLowerCase(), lower)),
  );
  return { real, ancestor };
}

interface AuthorityPlan {
  writable: string[];
  readOnly: string[];
}

/**
 * Turn classified path intents into write and read roots, fail-safe:
 *
 * - an excluded path, its ancestors' grants and its descendants never become
 *   writable; a writable root that would contain an excluded path is refused
 *   (the manifest cannot express a deny-list inside a writable root);
 * - a path is writable only on a positive grant, or as the single neutral
 *   repository of a request without one; everything else named is read-only;
 * - a protected path aimed at by a mutation is refused, and a missing path the
 *   user plainly meant (see looksLikeMissingFilesystemPath) is refused unless
 *   it lies inside a repository, which is then the target;
 * - once the request names an excluded path, a repository, or a missing
 *   filesystem path, the launch directory is never substituted: if nothing is
 *   writable the request is refused. Only plain input files and directories
 *   outside any repository ("analyze /tmp/crash.log") leave the launch
 *   fallback open.
 */
async function planAuthority(intents: PathIntent[]): Promise<AuthorityPlan> {
  interface Entry {
    path: string;
    canonical: string;
    role: PathIntent["role"];
    excluded: boolean;
    hard: boolean;
    isFile: boolean;
    exists: boolean;
    repository: boolean;
  }
  const entries = new Map<string, Entry>();
  const rank = { positive: 2, neutral: 1, reference: 0 } as const;
  for (const intent of intents) {
    const lexical = resolve(intent.mention.path);
    const entry = entries.get(lexical);
    if (!entry) {
      entries.set(lexical, {
        path: lexical,
        canonical: lexical,
        role: intent.role,
        excluded: intent.excluded,
        hard: intent.hardExcluded,
        isFile: false,
        exists: false,
        repository: false,
      });
      continue;
    }
    entry.excluded ||= intent.excluded;
    entry.hard ||= intent.hardExcluded;
    if (rank[intent.role] > rank[entry.role]) entry.role = intent.role;
  }

  let blocksFallback = false;
  const missing: string[] = [];
  for (const entry of entries.values()) {
    const protectedTarget = protectedReason(entry.path);
    if (protectedTarget) {
      // Refused only when a mutation is aimed at it ('fix /etc/nginx',
      // 'Modify files in "/"'); as prose it is never a workspace.
      if (entry.role === "positive" && !entry.excluded) {
        throw new WorkspaceScopeError(`Refusing protected ${protectedTarget}: ${entry.path}`);
      }
      entries.delete(entry.path);
      continue;
    }
    try {
      const stat = await lstat(entry.path);
      entry.exists = true;
      entry.isFile = stat.isFile();
      entry.canonical = await realpath(entry.path).catch(() => entry.path);
      const directory = entry.isFile ? dirname(entry.path) : entry.path;
      entry.repository = Boolean(await GitRepo.open(directory).catch(() => null));
    } catch {
      const { real, ancestor } = await looksLikeMissingFilesystemPath(entry.path);
      if (!real) {
        entries.delete(entry.path);
        continue;
      }
      blocksFallback = true;
      const inRepository = !protectedReason(ancestor) && Boolean(await GitRepo.open(ancestor).catch(() => null));
      if (entry.excluded || entry.role === "reference") {
        entry.canonical = await realpath(ancestor).catch(() => ancestor);
        continue;
      }
      if (!inRepository) {
        missing.push(entry.path);
        entries.delete(entry.path);
        continue;
      }
      // A new path inside an existing repository: that directory is the target.
      entry.exists = true;
      entry.path = ancestor;
      entry.canonical = await realpath(ancestor).catch(() => ancestor);
      entry.repository = true;
      entry.role = "positive";
    }
  }
  if (missing.length > 0) {
    throw new WorkspaceScopeError(
      `Workspace target does not exist: ${missing.join(", ")}. Check the path (or clone the repository first); the launch directory is never used in its place.`,
    );
  }

  const all = [...entries.values()].filter((entry) => entry.exists);
  const excluded = all.filter((entry) => entry.excluded);
  if (excluded.length > 0) blocksFallback = true;
  let positives = all.filter((entry) => !entry.excluded && entry.role === "positive");
  if (positives.length === 0) {
    const neutralRepos = all.filter((entry) => !entry.excluded && entry.role === "neutral" && entry.repository);
    if (new Set(neutralRepos.map((entry) => entry.canonical)).size === 1) positives = neutralRepos;
  }
  const writable: string[] = [];
  const unbound: string[] = [];
  for (const entry of positives) {
    const covering = excluded.find((exclusion) => isWithin(exclusion.canonical, entry.canonical));
    if (covering) {
      blocksFallback = true;
      continue;
    }
    const inner = excluded.find(
      (exclusion) => exclusion.canonical !== entry.canonical && isWithin(entry.canonical, exclusion.canonical),
    );
    if (inner) {
      throw new WorkspaceScopeError(
        `Refusing ${entry.path}: the request excludes ${inner.path} inside it, and a writable workspace cannot carve out an excluded subpath. Name a target that does not contain the excluded path.`,
      );
    }
    if (!entry.repository) {
      unbound.push(entry.path);
      blocksFallback = true;
      continue;
    }
    writable.push(entry.isFile ? dirname(entry.path) : entry.path);
  }

  const readOnly: string[] = [];
  for (const entry of all) {
    if (writable.some((root) => isWithin(root, entry.canonical)) && !entry.excluded) continue;
    if (entry.hard) continue;
    if (positives.includes(entry) && !entry.excluded && !entry.repository) continue;
    // A repository named but not granted (reference, ambiguous neutral) is a
    // deliberate scope statement; an input outside any repository is not.
    if (entry.repository) blocksFallback = true;
    readOnly.push(entry.path);
  }

  if (writable.length === 0 && (blocksFallback || unbound.length > 0)) {
    const reason =
      unbound.length > 0
        ? `the named target ${unbound.join(", ")} is not inside a Git repository`
        : "every named path is excluded, read-only, or ambiguous";
    throw new WorkspaceScopeError(
      `No writable workspace: ${reason}. Name the repository to modify explicitly (e.g. "implement the change in /path/to/repo"); the launch directory is never used in place of a named path.`,
    );
  }
  return { writable, readOnly };
}

function repoIdFor(root: string): string {
  return `repo-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

/** Resolve repository authority only from the user's request or launch cwd. */
export class WorkspaceManifestResolver {
  async resolve(request: string, launchCwd: string): Promise<ResolvedWorkspace> {
    // Named paths decide authority (src/orchestration/pathIntent.ts,
    // planAuthority); the launch cwd is only a fallback for requests that name
    // nothing binding. resolveRepository (legacy explicit repository argument)
    // keeps failing loudly.
    const { writable, readOnly } = await planAuthority(classifyPathIntents(request, launchCwd));
    let candidates: Array<{ path: string; source: AuthorizedRoot["source"] }> = writable.map((path) => ({
      path,
      source: "explicit_user_path" as const,
    }));
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
      if (resolved.authorizedRoots.some((root) => isWithin(root.canonicalPath, canonical))) continue;
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
