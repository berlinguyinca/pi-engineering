import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { GitRepo } from "../git/GitRepo.ts";
import { type RequestAnalysis, analyzeRequest } from "./pathIntent.ts";
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
 * `acme/widgets-gateway`) plus bare path-like tokens (e.g.
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
async function looksLikeMissingFilesystemPath(
  path: string,
): Promise<{ real: boolean; ancestor: string; nearMiss: boolean }> {
  const { ancestor, missingSegment } = await nearestExisting(path);
  const siblings = await readdir(ancestor).catch(() => [] as string[]);
  const lower = missingSegment.toLowerCase();
  const nearMiss = siblings.some(
    (sibling) =>
      sibling.toLowerCase() === lower || (missingSegment.length >= 5 && withinOneEdit(sibling.toLowerCase(), lower)),
  );
  if (ancestor !== parse(ancestor).root) return { real: true, ancestor, nearMiss };
  return { real: nearMiss, ancestor, nearMiss };
}

interface AuthorityPlan {
  writable: string[];
  readOnly: string[];
}

/** Taint that does not exclude a path: collateral from a restriction about something else, or a source. */
const COLLATERAL_TAINT = new Set(["strong-sentence", "from-path", "weak-reference"]);

/** Appended to every scope refusal: over-refusals are a one-line fix. */
export const SCOPE_DIRECTIVE_HINT =
  'State scope explicitly with directive lines, e.g. "writable: /path/to/repo" and "read-only: /other/path" (docs/usage.md, "Workspace scope").';

function scopeError(message: string): WorkspaceScopeError {
  return new WorkspaceScopeError(`${message} ${SCOPE_DIRECTIVE_HINT}`);
}

/**
 * Turn the request analysis into write and read roots. Fail-safe:
 *
 * - only write-eligible paths (directive, or directed in an unrestricted
 *   sentence) can be writable; a path that is read-only anywhere, under any
 *   lexical or symlink alias, is never writable, nor is anything inside it; a
 *   writable root containing a read-only path is refused (no carve-outs);
 * - a protected path that would be writable is refused; a token that cannot
 *   be resolved is refused when a mutation is aimed at it; a missing path the
 *   user plainly meant is refused unless it lies inside a repository, which
 *   is then the target;
 * - once the request names any path-like token, or restricts the launch
 *   directory ("do not modify anything here"), the launch directory is never
 *   substituted: nothing writable means a refusal.
 */
async function planAuthority(analysis: RequestAnalysis, launchCwd: string): Promise<AuthorityPlan> {
  if (analysis.directiveConflict) {
    throw scopeError(`${analysis.directiveConflict} is named both writable and read-only.`);
  }
  // The launch directory stays the default target only while every named path
  // is an input or scratch location outside any repository, or lies inside
  // the launch repository and is not excluded. Another repository, an
  // excluded launch directory, an unresolvable token or a restriction on
  // "anything here" rules the default out.
  let blocksFallback = analysis.launchRestricted;
  const launchGit = await GitRepo.open(launchCwd).catch(() => null);
  const launchRoot = launchGit ? await realpath(launchGit.root).catch(() => launchGit.root) : null;
  const repositoryRootOf = async (directory: string): Promise<string | null> => {
    const git = await GitRepo.open(directory).catch(() => null);
    return git ? await realpath(git.root).catch(() => git.root) : null;
  };
  interface Resolved {
    index: number;
    path: string;
    canonical: string;
    isFile: boolean;
    repository: boolean;
    eligible: boolean;
  }
  const resolved: Resolved[] = [];
  const unresolvable: string[] = [];
  const missing: string[] = [];
  for (const [index, mention] of analysis.mentions.entries()) {
    const eligible = analysis.writeEligible(index);
    if (mention.glob) continue; // a pattern, never a target
    if (mention.outsideLaunch && !(await lstat(mention.outsideLaunch).catch(() => null))) continue;
    if (!mention.path) {
      blocksFallback = true;
      if (analysis.mutationLed[index]) unresolvable.push(mention.raw);
      continue;
    }
    const protectedTarget = protectedReason(mention.path);
    if (protectedTarget) {
      // A mutation aimed straight at a protected path refuses the request; a
      // protected path that is merely mentioned in a brief is just never granted.
      if (eligible && analysis.mutationLed[index]) {
        throw scopeError(`Refusing protected ${protectedTarget}: ${mention.path}.`);
      }
      continue;
    }
    try {
      const stat = await lstat(mention.path);
      const isFile = stat.isFile();
      const canonical = await realpath(mention.path).catch(() => mention.path!);
      const directory = isFile ? dirname(mention.path) : mention.path;
      const repositoryRoot = await repositoryRootOf(directory);
      const repository = repositoryRoot !== null;
      const dependency = /[\\/](?:node_modules|\.venv|venv|vendor|target|dist|build)(?:[\\/]|$)/.test(canonical);
      if (repositoryRoot && repositoryRoot !== launchRoot && !dependency) blocksFallback = true;
      // An exclusion at or around the launch repository rules the default out
      // (it could not be carved out of a writable launch root). Collateral
      // taint from a restriction about something else, or a path used as a
      // source, does not.
      const exclusion = analysis.taintReasons[index]?.some((reason) => !COLLATERAL_TAINT.has(reason));
      if (
        analysis.blocksWrite(index) &&
        exclusion &&
        launchRoot &&
        (isWithin(canonical, launchRoot) || isWithin(launchRoot, canonical))
      ) {
        blocksFallback = true;
      }
      // An input outside any repository (a file, or a directory no verb is
      // aimed at, like "the ZIP is in ~/Downloads") is read, never a target.
      const inputFile = !repository && (isFile || !analysis.mutationLed[index]);
      resolved.push({ index, path: mention.path, canonical, isFile, repository, eligible: eligible && !inputFile });
    } catch {
      const { real, ancestor, nearMiss } = await looksLikeMissingFilesystemPath(mention.path);
      // Not under any existing directory and no near-miss of one: an HTTP
      // route, an identifier or prose ("/OPENAI_API_KEY", "/season"), never a target.
      if (!real) continue;
      if (!eligible) continue;
      const inRepository =
        real && !protectedReason(ancestor) && Boolean(await GitRepo.open(ancestor).catch(() => null));
      if (!inRepository) {
        // A missing file outside any repository is a gone input ("the spec
        // ZIP in ~/Downloads"); a missing directory is a target typo.
        // Only a verb aimed straight at it makes it a target ("fix ~/repo-typo");
        // a new directory under the temp dir is a scratch output unless it is
        // a near-miss of an existing one.
        const scratch = isWithin(await realpath(tmpdir()).catch(() => tmpdir()), ancestor) && !nearMiss;
        if (analysis.mutationLed[index] && !scratch && !/\.[A-Za-z0-9]{1,8}$/.test(basename(mention.path))) {
          missing.push(mention.path);
        }
        continue;
      }
      // A new path inside an existing repository ("create the docs in /repo/docs")
      // makes that directory the target — only when a verb is aimed at it, it
      // adds at most two levels, and it is no dependency directory.
      const newDepth = relative(ancestor, mention.path).split(sep).length;
      const dependencyPath = /[\\/](?:node_modules|\.venv|venv|vendor|target|dist|build)(?:[\\/]|$)/.test(mention.path);
      if (!analysis.mutationLed[index] || newDepth > 2 || dependencyPath) continue;
      const canonical = await realpath(ancestor).catch(() => ancestor);
      resolved.push({ index, path: ancestor, canonical, isFile: false, repository: true, eligible });
    }
  }
  const refuseUnlessWritable: Array<() => WorkspaceScopeError> = [];
  if (unresolvable.length > 0) {
    refuseUnlessWritable.push(() =>
      scopeError(
        `Path ${unresolvable.join(", ")} cannot be resolved (variables, other drives, other users' homes and paths outside the launch directory are not expanded); write it as an absolute path.`,
      ),
    );
  }
  if (missing.length > 0) {
    refuseUnlessWritable.push(() =>
      scopeError(
        `Workspace target does not exist: ${missing.join(", ")}. Check the path (or clone the repository first); the launch directory is never used in its place.`,
      ),
    );
  }

  const readOnlyCanonical = resolved
    .filter((entry) => analysis.blocksWrite(entry.index))
    .map((entry) => entry.canonical);
  const writable: string[] = [];
  const unbound: string[] = [];
  for (const entry of resolved.filter((candidate) => candidate.eligible)) {
    if (readOnlyCanonical.some((excluded) => isWithin(excluded, entry.canonical))) continue;
    const inner = readOnlyCanonical.find((excluded) => isWithin(entry.canonical, excluded));
    if (inner) {
      throw scopeError(
        `Refusing ${entry.path}: the request keeps ${inner} inside it read-only, and a writable workspace cannot carve out a read-only subpath.`,
      );
    }
    if (!entry.repository) {
      unbound.push(entry.path);
      continue;
    }
    writable.push(entry.isFile ? dirname(entry.path) : entry.path);
  }

  const readOnly: string[] = [];
  for (const entry of resolved) {
    if (writable.some((root) => isWithin(resolve(root), entry.canonical)) && !analysis.tainted[entry.index]) continue;
    if (unbound.includes(entry.path)) continue;
    readOnly.push(entry.path);
  }

  if (writable.length === 0) {
    // A protected, missing or unresolvable target is fatal only when it is
    // the only target: in a multi-repository brief it is just not granted.
    const first = refuseUnlessWritable[0];
    if (first) throw first();
    if (unbound.length > 0) {
      throw scopeError(`No writable workspace: the named target ${unbound.join(", ")} is not inside a Git repository.`);
    }
    if (blocksFallback) {
      throw scopeError(
        "No writable workspace: no named path is clearly the target (restriction words such as not, keep, leave, only, review, from make the paths in their sentence read-only), and the launch directory is never used in place of named or restricted paths.",
      );
    }
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
    const { writable, readOnly } = await planAuthority(analyzeRequest(request, launchCwd), launchCwd);
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
