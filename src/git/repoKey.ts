import { GitRepo, openTtlMs } from "./GitRepo.ts";

/**
 * Resolved repository keys by cwd, for advisory and periodic callers (the footer, the presence poll).
 *
 * `resolve` uses the short-lived `GitRepo.open` cache, so a poll costs no git children between expiries. A cwd that is
 * not (or no longer) a repository has no remembered key: the fallback-to-cwd answer is returned but never stored.
 */
export class RepoKeyResolver {
  private readonly keys = new Map<string, string>();

  /** The key resolved earlier for this cwd, if any. Never does IO. */
  cached(cwd: string): string | undefined {
    return this.keys.get(cwd);
  }

  async resolve(cwd: string): Promise<string> {
    const repo = await GitRepo.open(cwd, undefined, { cacheMs: openTtlMs() }).catch(() => null);
    if (!repo) {
      this.keys.delete(cwd);
      return cwd;
    }
    this.keys.set(cwd, repo.root);
    return repo.root;
  }

  /**
   * The entry of `entries` for this cwd's repository. The remembered key is tried first (no git); when it no longer
   * names an entry (the repository moved, or the key was never right) the key is resolved afresh.
   */
  async lookup<T>(cwd: string, entries: ReadonlyMap<string, T>): Promise<T | undefined> {
    const remembered = this.cached(cwd);
    const hit = remembered === undefined ? undefined : entries.get(remembered);
    if (hit !== undefined) return hit;
    return entries.get(await this.resolve(cwd));
  }
}
