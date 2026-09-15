/**
 * Keeping the loaded extension current.
 *
 * The decision rules live in `versionCheck.ts`; this runs the git commands and
 * decides WHEN to bother. Three constraints shape it:
 *
 *   * **It must never delay a session.** A fetch talks to a network that may be
 *     slow or absent, and an extension that makes Pi feel slow to start will be
 *     removed long before it is ever out of date.
 *   * **It must never fail a session.** No git, no remote, no network, a
 *     checkout that is not a repo at all — every one of those is silence, not
 *     an error. Being unable to check for updates is not a problem the operator
 *     has to act on.
 *   * **Only a strict fast-forward.** `--ff-only` is not a preference; a merge
 *     or rebase performed by a background task is a decision about someone's
 *     work.
 */

import { type RepoObservation, type UpdateAction, decideUpdate, parseStatus } from "./versionCheck.ts";

export interface GitRunner {
  (args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface SelfUpdateOptions {
  /** Repository root holding the extension. */
  cwd: string;
  git: GitRunner;
  /** Apply a safe fast-forward, rather than only reporting it. */
  apply?: boolean;
  /** Skip the network fetch and judge against refs already on disk. */
  offline?: boolean;
}

export interface SelfUpdateResult {
  decision: UpdateAction;
  observation?: RepoObservation;
  /** Whether a fast-forward was actually performed. */
  applied: boolean;
  /** Commit moved to, when applied. */
  head?: string;
  /** Why the check could not run, when it could not. */
  unavailable?: string;
}

/**
 * Check, and optionally apply, an update.
 *
 * Never throws: an unavailable check returns `unavailable` with a `skip`
 * decision, because a session must not fail over its own maintenance.
 */
export async function checkForUpdate(opts: SelfUpdateOptions): Promise<SelfUpdateResult> {
  const unavailable = (reason: string): SelfUpdateResult => ({
    decision: { action: "skip", reason },
    applied: false,
    unavailable: reason,
  });

  try {
    const inside = await opts.git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") return unavailable("not a git checkout");

    if (!opts.offline) {
      // Failure here is normal — offline, no credentials, no remote. Judge
      // against whatever refs are already on disk rather than giving up.
      await opts.git(["fetch", "--quiet", "--no-tags"]).catch(() => undefined);
    }

    const status = await opts.git(["status", "--porcelain=v2", "--branch"]);
    if (status.code !== 0) return unavailable("git status failed");

    const observation = parseStatus(status.stdout);
    const decision = decideUpdate(observation);

    if (decision.action !== "update" || !opts.apply) {
      return { decision, observation, applied: false };
    }

    // Merge the tracked upstream ref, NOT `FETCH_HEAD`. A fetch that touches
    // several refs leaves FETCH_HEAD pointing at whichever came last, so it is
    // the wrong target in exactly the repositories this runs in — and using it
    // as the primary path meant every real apply fell through to a branch no
    // test covered. The upstream ref is what `behind` was computed against, so
    // it is the only ref whose fast-forward matches the decision.
    //
    // `--ff-only` is the guarantee: if upstream moved in a way that cannot
    // fast-forward, this fails rather than inventing a merge commit.
    //
    // The cleanliness check above is a SNAPSHOT, so a file edited between it and
    // this line is not covered by it. That window is not closed here, and the
    // reason it is survivable is git's own behaviour rather than this code's:
    // a fast-forward refuses outright when it would overwrite a conflicting
    // local change, and carries a non-conflicting one across. So "never applied
    // over uncommitted work" is the intent of the check, not an atomic
    // guarantee — stated plainly rather than implied.
    const target = observation.upstream ?? "@{u}";
    const pull = await opts.git(["merge", "--ff-only", target]);
    if (pull.code !== 0) {
      return {
        decision: {
          action: "report",
          behind: decision.behind,
          reason: `fast-forward refused: ${firstLine(pull.stderr || pull.stdout)}`,
        },
        observation,
        applied: false,
      };
    }

    const head = await opts.git(["rev-parse", "HEAD"]);
    return {
      decision,
      observation,
      applied: true,
      ...(head.code === 0 ? { head: head.stdout.trim() } : {}),
    };
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err));
  }
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim().slice(0, 200);
}

/**
 * How often a session may check.
 *
 * Generous on purpose: the cost of being a few hours stale is small, and the
 * cost of a network round trip on every session start is paid by the operator
 * every single time.
 */
export const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Should a check run now, given when one last did? */
export function shouldCheck(
  lastCheckedAtMs: number | undefined,
  nowMs: number,
  intervalMs = DEFAULT_CHECK_INTERVAL_MS,
): boolean {
  if (lastCheckedAtMs === undefined) return true;
  // A clock that moved backwards (suspend, NTP correction) must not lock out
  // checking until the clock catches up.
  if (lastCheckedAtMs > nowMs) return true;
  return nowMs - lastCheckedAtMs >= intervalMs;
}
