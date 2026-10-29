import { GitRepo, openTtlMs } from "./GitRepo.ts";

/**
 * Resolved repository keys by cwd, for advisory and periodic callers (the footer, the presence poll).
 *
 * `resolve` uses the short-lived `GitRepo.open` cache, so a poll costs no git children between expiries. A cwd that is
 * not a repository resolves to the cwd itself (the runtime is keyed that way); that answer is remembered in a separate
 * short-lived "known non-repository" map, never in the repository cache, so a `git init` shows up within the TTL.
 * Callers that decide something from the answer pass `{ fresh: true }` and always ask git.
 */
export class RepoKeyResolver {
  private readonly keys = new Map<string, string>();
  private readonly nonRepos = new Map<string, number>();

  private nonRepoFresh(cwd: string): boolean {
    const at = this.nonRepos.get(cwd);
    return at !== undefined && Date.now() - at < openTtlMs();
  }

  /** The key resolved earlier for this cwd (the cwd itself for a recently seen non-repository). Never does IO. */
  cached(cwd: string): string | undefined {
    return this.keys.get(cwd) ?? (this.nonRepoFresh(cwd) ? cwd : undefined);
  }

  async resolve(cwd: string, opts: { fresh?: boolean } = {}): Promise<string> {
    if (!opts.fresh && this.nonRepoFresh(cwd)) return cwd;
    const repo = await GitRepo.open(cwd, undefined, opts.fresh ? {} : { cacheMs: openTtlMs() }).catch(() => null);
    if (!repo) {
      this.keys.delete(cwd);
      this.nonRepos.set(cwd, Date.now());
      return cwd;
    }
    this.nonRepos.delete(cwd);
    this.keys.set(cwd, repo.root);
    return repo.root;
  }

  /**
   * The entry of `entries` for this cwd's repository. With no entries there is nothing to find and git is not asked.
   * The remembered key is tried first (no git); when it no longer names an entry (the repository moved, or the key was
   * never right) the key is resolved afresh.
   */
  async lookup<T>(cwd: string, entries: ReadonlyMap<string, T>): Promise<T | undefined> {
    if (entries.size === 0) return undefined;
    const remembered = this.cached(cwd);
    const hit = remembered === undefined ? undefined : entries.get(remembered);
    if (hit !== undefined) return hit;
    return entries.get(await this.resolve(cwd));
  }
}
