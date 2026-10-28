/**
 * Git facts for a session event: which worktree an agent works in, what commit it is on, and the repository's origin.
 *
 * The control plane links a session to architecture snapshots and CI only by an exact repository and full commit
 * (never by cwd or branch), and to a worktree by the same `worktree_id` Pi already derives for isolation. Without these
 * fields nothing a Pi agent does can be correlated. Best-effort: any failure yields `null`, never an exception, and the
 * answer is cached briefly so a burst of lifecycle events costs one probe.
 */
import { safeGit } from "../../git/safeGit.ts";
import { resolveWorktreeIdentity } from "../isolation/WorktreeIdentity.ts";

export interface SessionGitFacts {
  worktreeId: string;
  /** Full lowercase commit id of HEAD; absent on an unborn branch or when git could not say. */
  commitSha?: string;
  /** `remote.origin.url` as configured (the control plane canonicalizes it); absent when there is no origin. */
  repoUrl?: string;
}

const TTL_MS = 30_000;
const MAX_ENTRIES = 64;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const cache = new Map<string, { at: number; facts: SessionGitFacts | null }>();

async function probe(dir: string): Promise<SessionGitFacts | null> {
  const identity = await resolveWorktreeIdentity(dir);
  if (identity.kind !== "git") return null; // a plain directory has no commit to correlate
  const facts: SessionGitFacts = { worktreeId: identity.worktreeId };
  const head = await safeGit(["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: identity.worktreeRoot,
    timeoutMs: 5_000,
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  const sha = head.code === 0 ? head.stdout.trim().toLowerCase() : "";
  if (FULL_SHA.test(sha)) facts.commitSha = sha;
  const origin = await safeGit(["config", "--local", "--get", "remote.origin.url"], {
    cwd: identity.worktreeRoot,
    timeoutMs: 5_000,
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  const url = origin.code === 0 ? origin.stdout.trim() : "";
  if (url && url.length <= 500) facts.repoUrl = url;
  return facts;
}

/** Facts for the directory an agent works in, or null. Cached for 30 s per directory; never throws. */
export async function sessionGitFacts(
  dir: string | undefined | null,
  now: () => number = Date.now,
): Promise<SessionGitFacts | null> {
  if (!dir) return null;
  const hit = cache.get(dir);
  if (hit && now() - hit.at < TTL_MS) return hit.facts;
  let facts: SessionGitFacts | null = null;
  try {
    facts = await probe(dir);
  } catch {
    facts = null;
  }
  cache.delete(dir);
  cache.set(dir, { at: now(), facts });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  return facts;
}

/** Test seam: forget everything cached. */
export function resetSessionGitFactsCache(): void {
  cache.clear();
}
