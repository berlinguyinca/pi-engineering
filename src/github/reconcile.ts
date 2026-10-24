/**
 * Reconciler (T05): compares the RECORDED link state with GitHub reality and writes corrections.
 *
 *  - Idempotent: a correction is made only when observation differs from the record, so a
 *    second pass over an unchanged GitHub emits nothing.
 *  - Never fabricates: an API failure (rate limit, auth, timeout, bad payload) changes NOTHING
 *    and is returned in `errors`; only a definitive 404 marks a link `not_found`, and only a
 *    PR body that no longer carries its closing line marks a link `removed`.
 *  - Head movement: a PR whose head SHA differs from the recorded one yields a `github.evidence_stale`
 *    signal (review/validation evidence bound to the old SHA is stale; T06 consumes it) and, through
 *    the optional sink, a head_sha update. The signal is derived from the link, so nothing is invented.
 *  - One fetch per target per pass; a rate limit stops the pass (remaining links count as `skipped`).
 */
import { type GhIssue, type GhPullRequest, type GithubClient, GithubClientError } from "./client.ts";
import { closingRefs } from "./discovery.ts";
import type { GithubLinkStore } from "./discovery.ts";
import { type GithubLineageSink, emitLinkCorrection, emitLinkRecorded } from "./lineage.ts";
import { type RefConfig, parseCanonicalId, refKey } from "./refs.ts";
import { boundTitle } from "./sanitize.ts";
import { type GithubLinkPatch, type GithubLinkRecord, type GithubStaleSignal, staleSignalIdFor } from "./types.ts";

export interface ReconcileStore extends GithubLinkStore {
  correctGithubLink(linkId: string, patch: GithubLinkPatch, reason: string): boolean;
  recordGithubStale(signal: GithubStaleSignal): boolean;
  getGithubLink(linkId: string): GithubLinkRecord | undefined;
}

export interface LinkCorrection {
  linkId: string;
  target: string;
  reason: string;
  patch: GithubLinkPatch;
}

export interface ReconcileError {
  linkId: string;
  target: string;
  kind: string;
  message: string;
  retryAfterMs?: number;
}

export interface ReconcileResult {
  status: "disabled" | "ok" | "rate_limited";
  checked: number;
  skipped: number;
  corrections: LinkCorrection[];
  staleSignals: GithubStaleSignal[];
  errors: ReconcileError[];
}

export const NOT_FOUND_CONFIRMATIONS = 3;

export interface ReconcileOptions {
  /** Consecutive 404 passes before a link is deactivated as not_found (default 3). */
  notFoundConfirmations?: number;
  missionId?: string;
  sink?: GithubLineageSink | null;
  now?: () => string;
}

type Fetched<T> = { ok: true; value: T } | { ok: false; error: GithubClientError };

export async function reconcileGithubLinks(
  client: GithubClient | null,
  store: ReconcileStore,
  cfg: RefConfig,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    status: "disabled",
    checked: 0,
    skipped: 0,
    corrections: [],
    staleSignals: [],
    errors: [],
  };
  if (!client) return result;
  result.status = "ok";
  const now = options.now ?? (() => new Date().toISOString());
  const issues = new Map<string, Fetched<GhIssue>>();
  const prs = new Map<string, Fetched<GhPullRequest>>();

  const fetchOnce = async <T>(
    cache: Map<string, Fetched<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<Fetched<T>> => {
    const hit = cache.get(key);
    if (hit) return hit;
    let entry: Fetched<T>;
    try {
      entry = { ok: true, value: await load() };
    } catch (error) {
      entry = {
        ok: false,
        error:
          error instanceof GithubClientError ? error : new GithubClientError("transient", boundTitle(String(error))),
      };
    }
    cache.set(key, entry);
    return entry;
  };

  let limited = false;
  // `not_found` links are re-checked too, so a transient 404 can heal; `removed` is final.
  const links = store
    .listGithubLinks(options.missionId)
    .filter((l) => l.status === "active" || l.status === "not_found");
  const notFoundLimit = options.notFoundConfirmations ?? NOT_FOUND_CONFIRMATIONS;
  for (let i = 0; i < links.length; i++) {
    const link = links[i] as GithubLinkRecord;
    if (limited) {
      result.skipped++;
      continue;
    }
    const ref = parseCanonicalId(link.target, cfg);
    if (!ref) {
      result.errors.push({
        linkId: link.linkId,
        target: link.target,
        kind: "invalid",
        message: "recorded target is not a valid reference",
      });
      continue;
    }
    result.checked++;
    const fail = (error: GithubClientError): void => {
      result.errors.push({
        linkId: link.linkId,
        target: link.target,
        kind: error.kind,
        message: boundTitle(error.message),
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      });
      if (error.kind === "rate_limited") limited = true;
    };
    const apply = (patch: GithubLinkPatch, reason: string): void => {
      const before = store.getGithubLink(link.linkId) ?? link;
      if (!store.correctGithubLink(link.linkId, patch, reason)) return;
      const after = store.getGithubLink(link.linkId);
      result.corrections.push({ linkId: link.linkId, target: link.target, reason, patch });
      if (!after) return;
      if (before.status !== "active" && after.status === "active") emitLinkRecorded(options.sink, after);
      else if (
        before.status !== after.status ||
        before.observed.state !== after.observed.state ||
        before.observed.headSha !== after.observed.headSha
      )
        emitLinkCorrection(options.sink, before, after, reason);
    };
    /** A definitive 404: count it; deactivate only after N consecutive confirmations. */
    const missing = (what: string): void => {
      if (link.status === "not_found") return; // already deactivated and still missing: nothing to say
      const count = (link.notFoundCount ?? 0) + 1;
      if (count >= notFoundLimit) apply({ status: "not_found", notFoundCount: count }, `${what} (confirmed ${count}x)`);
      else apply({ notFoundCount: count }, `${what} (${count}/${notFoundLimit}, will re-check)`);
    };
    /** A successful read: reactivate a not_found link and clear the miss counter. */
    const present = (patch: GithubLinkPatch): GithubLinkPatch => ({
      ...patch,
      ...(link.status === "not_found" ? { status: "active" as const } : {}),
      ...(link.notFoundCount ? { notFoundCount: 0 } : {}),
    });

    // 1. A closing line that came from a PR body must still be there (only judged on a COMPLETE body).
    if (link.viaPr && link.status === "active") {
      const via = parseCanonicalId(link.viaPr, cfg);
      if (via) {
        const pr = await fetchOnce(prs, refKey(via), () => client.getPullRequest(via));
        if (pr.ok) {
          if (!pr.value.bodyTruncated) {
            const still = closingRefs(pr.value.parseBody, cfg).some((r) => refKey(r) === refKey(ref));
            if (!still) {
              apply({ status: "removed" }, "closing reference no longer present in the PR body");
              continue;
            }
          }
        } else if (pr.error.kind !== "not_found") {
          fail(pr.error);
          continue;
        }
        // The carrying PR being 404 is NOT proof the line was removed (it may be transient): fall through to the target check.
      }
    }
    if (limited) {
      result.skipped++;
      continue;
    }

    // 2. The target itself.
    if (link.targetKind === "pr") {
      const pr = await fetchOnce(prs, refKey(ref), () => client.getPullRequest(ref));
      if (!pr.ok) {
        if (pr.error.kind === "not_found") missing("pull request not found on GitHub");
        else fail(pr.error);
        continue;
      }
      const observed = pr.value;
      const prev = link.observed.headSha;
      const moved = prev !== undefined && !sameSha(prev, observed.headSha);
      const upgraded = prev !== undefined && !moved && prev !== observed.headSha; // short -> full SHA, same commit
      const changed = link.observed.state !== observed.state || prev === undefined || moved || upgraded;
      const recover = link.status === "not_found" || Boolean(link.notFoundCount);
      if (!changed && !recover) continue;
      let epoch: number | undefined;
      if (moved) {
        epoch = (link.epoch ?? 0) + 1;
        const signal: GithubStaleSignal = {
          signalId: staleSignalIdFor(link.linkId, prev as string, observed.headSha, epoch),
          missionId: link.missionId,
          linkId: link.linkId,
          target: link.target,
          reason: "pr_head_changed",
          previousHeadSha: prev as string,
          headSha: observed.headSha,
          epoch,
          recordedAt: now(),
        };
        if (store.recordGithubStale(signal)) result.staleSignals.push(signal);
      }
      apply(
        present({
          observed: {
            state: observed.state,
            headSha: observed.headSha,
            ...(observed.author ? { author: observed.author } : {}),
            observedAt: now(),
          },
          ...(epoch !== undefined ? { epoch } : {}),
        }),
        recover && !changed
          ? "pull request reachable again"
          : moved
            ? "PR head SHA changed"
            : `PR is ${observed.state}`,
      );
    } else {
      const issue = await fetchOnce(issues, refKey(ref), () => client.getIssue(ref));
      if (!issue.ok) {
        if (issue.error.kind === "not_found") missing("issue not found on GitHub");
        else fail(issue.error);
        continue;
      }
      if (issue.value.isPullRequest) {
        fail(new GithubClientError("invalid", "recorded as an issue but GitHub says it is a pull request"));
        continue;
      }
      const recover = link.status === "not_found" || Boolean(link.notFoundCount);
      if (link.observed.state === issue.value.state && !recover) continue;
      apply(
        present({ observed: { state: issue.value.state, observedAt: now() } }),
        link.observed.state === issue.value.state
          ? "issue reachable again"
          : link.observed.state === "closed" && issue.value.state === "open"
            ? "issue reopened"
            : `issue ${issue.value.state}`,
      );
    }
  }
  if (limited) result.status = "rate_limited";
  return result;
}

/** Same commit, tolerating an abbreviated recorded SHA (prefix of the other). */
export function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || (Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x)));
}
