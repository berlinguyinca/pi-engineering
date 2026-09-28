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
  for (const match of request.matchAll(/(?<![/:])\/(?:[^\s"'`<>()[\]{}])*/g)) {
    if (quotedRanges.some((range) => match.index >= range.start && match.index < range.end)) continue;
    const candidate = stripUnquotedPunctuation(match[0]);
    if (candidate.length > 0 && isAbsolute(candidate)) paths.push(candidate);
  }
  return paths;
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
    const explicit = explicitAbsolutePaths(request);
    const candidates =
      explicit.length > 0
        ? explicit.map((path) => ({ path, source: "explicit_user_path" as const }))
        : [{ path: launchCwd, source: "launch_cwd" as const }];
    return this.resolveCandidates(candidates, launchCwd);
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
