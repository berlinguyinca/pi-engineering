/**
 * PR linkage (T05): task / attempt / commit -> PR, recorded from EXPLICIT data only.
 *
 * Pi creates no PRs here. The PR comes from the stdout of a `gh pr create` the operator or a
 * worker ran ({@link parsePrCreateOutput}) or is handed in. The head SHA is recorded so the
 * reconciler can detect movement with the same SHA-fence convention as `src/merge`.
 */
import { type GithubClient, GithubClientError } from "./client.ts";
import { type GithubLinkStore, closingRefs, linkExistingRef } from "./discovery.ts";
import { type GithubRef, type RefConfig, canonicalId, extractGithubRefs, sameRepo, withKind } from "./refs.ts";
import { type GithubLinkRecord, type LinkSubject, linkIdFor, suggestionIdFor } from "./types.ts";

/** The PR URL printed by `gh pr create`: exactly one distinct PR URL, or nothing (no guessing). */
export function parsePrCreateOutput(stdout: string, cfg: RefConfig): GithubRef | undefined {
  const urls = extractGithubRefs(stdout.slice(0, 16 * 1024), cfg).filter((r) => r.kind === "pr");
  return urls.length === 1 ? urls[0] : undefined;
}

export interface LinkPullRequestInput {
  missionId: string;
  prRef: GithubRef;
  /** Task / attempt / commit subjects that produced the PR. */
  subjects: readonly LinkSubject[];
  /** Head SHA when the caller already knows it (required when there is no client). */
  headSha?: string;
  provenance?: "pr_create_output" | "operator" | "autospec";
}

export async function linkPullRequest(
  client: GithubClient | null,
  store: GithubLinkStore,
  input: LinkPullRequestInput,
  now: () => string = () => new Date().toISOString(),
): Promise<GithubLinkRecord[]> {
  // Without a client nothing can verify an unknown-kind ref is a PR, so it must already say so (a /pull/ URL).
  if (!client && input.prRef.kind !== "pr") return [];
  const ref = withKind(input.prRef, "pr");
  const target = ref ? canonicalId(ref) : undefined;
  if (!ref || !target) return [];
  let headSha = input.headSha?.toLowerCase();
  let state: "open" | "closed" | "merged" | undefined;
  let title: string | undefined;
  let author: string | undefined;
  if (client) {
    try {
      const pr = await client.getPullRequest(ref);
      headSha = pr.headSha;
      state = pr.state;
      title = pr.title;
      author = pr.author;
    } catch (error) {
      // A PR GitHub says does not exist is never linked; other failures keep caller-provided data
      // (the reconciler verifies it later), but nothing is recorded without a head SHA.
      if (error instanceof GithubClientError && error.kind === "not_found") return [];
      if (!headSha) return [];
    }
  } else if (!headSha) {
    return [];
  }
  // A caller-provided SHA must be a full object name: a short one cannot be compared reliably.
  if (headSha && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha) && !(client && state)) return [];
  if (headSha && !/^[0-9a-f]{7,64}$/.test(headSha)) return [];
  const out: GithubLinkRecord[] = [];
  for (const subject of input.subjects) {
    out.push(
      store.recordGithubLink({
        linkId: linkIdFor(input.missionId, subject, target),
        missionId: input.missionId,
        subject,
        target,
        targetKind: "pr",
        provenance: input.provenance ?? "pr_create_output",
        source: "pr",
        observed: {
          ...(state ? { state } : {}),
          ...(headSha ? { headSha } : {}),
          ...(title ? { title } : {}),
          ...(author ? { author } : {}),
          observedAt: now(),
        },
        status: "active",
        recordedAt: now(),
      }),
    );
  }
  return out;
}

/**
 * Link subjects to the issues a PR body closes (closing keywords only), remembering the PR so the
 * reconciler can notice the line being removed later.
 */
export async function linkClosingIssues(
  client: GithubClient | null,
  store: GithubLinkStore,
  cfg: RefConfig,
  input: {
    missionId: string;
    prRef: GithubRef;
    /** FULL body for parsing (GhPullRequest.parseBody). */
    prBody: string;
    prBodyTruncated?: boolean;
    subjects: readonly LinkSubject[];
  },
  now: () => string = () => new Date().toISOString(),
): Promise<GithubLinkRecord[]> {
  if (!client) return [];
  const pr = withKind(input.prRef, "pr");
  const viaPr = pr ? canonicalId(pr) : undefined;
  if (!pr || !viaPr) return [];
  const out: GithubLinkRecord[] = [];
  for (const ref of closingRefs(input.prBody, cfg, { truncated: input.prBodyTruncated === true })) {
    if (!sameRepo(ref, pr)) {
      // A PR may only close issues in its own repo. A closing keyword aimed elsewhere is a hint, not a link.
      for (const subject of input.subjects) {
        try {
          const item = await client.getIssue(ref);
          const target = canonicalId(item.ref);
          if (target)
            store.suggestGithubLink({
              suggestionId: suggestionIdFor(input.missionId, subject, target),
              missionId: input.missionId,
              subject,
              target,
              targetKind: item.ref.kind,
              reason: "PR body has a closing keyword for another repository (needs confirmation)",
              title: item.title,
              state: "pending",
              recordedAt: now(),
            });
        } catch {
          // an unreachable foreign ref is simply not suggested
        }
      }
      continue;
    }
    for (const subject of input.subjects) {
      const link = await linkExistingRef(
        client,
        store,
        input.missionId,
        subject,
        ref,
        "explicit_ref",
        "pr_body",
        now,
        undefined,
        viaPr,
      );
      if (link) out.push(link);
    }
  }
  return out;
}
