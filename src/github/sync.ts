/**
 * One GitHub tick: reconcile the recorded links, project what GitHub says to Herdr, and gate the merge.
 *
 *  1. {@link reconcileGithubLinks}: observed PR/issue state and head movement (stale-evidence signals).
 *  2. Stale reaction: each `github.evidence_stale` signal becomes ONE durable re-review request (idempotent on the
 *     signal id), the PR node says which head wants a re-review, and the operator's `rereview_command` (argv from
 *     the global YAML) is run once. Pi never re-reviews by itself and never merges.
 *  3. CI: the check runs of every linked PR's head become `ci:` nodes and `validated` edges (green head only).
 *  4. Dependencies: issue bodies' `## Dependencies` and native relations become `dependency` edges between issues.
 *  5. Merge gate: Herdr's review quorum (read, never computed) feeds {@link decideMerge}; the decision is projected
 *     as a Pi-owned `gate:` node (and a `validated` edge to the PR only when the decision is merge).
 *
 * Inert without a client. Every Herdr write goes through the lineage emitter and so is best-effort.
 */
import { execFile } from "node:child_process";
import { normalizeCheckRuns } from "../merge/checkRunIngest.ts";
import { decideMerge } from "../merge/mergeGate.ts";
import type { CheckRun, MergeDecision } from "../merge/mergeGate.ts";
import { type LineageEmitter, lineageNodeId } from "../runtime/herdr/lineage.ts";
import type { GithubClient } from "./client.ts";
import { type DependencyItem, buildDependencyGraph } from "./dependencies.ts";
import { type GithubLineageSink, emitCiValidation, emitDependencyEdges, targetState } from "./lineage.ts";
import type { QuorumReader } from "./quorum.ts";
import { type ReconcileResult, type ReconcileStore, reconcileGithubLinks } from "./reconcile.ts";
import { type GithubRef, type RefConfig, canonicalId, parseCanonicalId, refKey } from "./refs.ts";
import type { GithubRereviewRequest, GithubStaleSignal } from "./types.ts";

export interface SyncStore extends ReconcileStore {
  listGithubStaleSignals(missionId?: string): GithubStaleSignal[];
  recordGithubRereview(request: GithubRereviewRequest): boolean;
  listGithubRereviews(missionId?: string): GithubRereviewRequest[];
}

export interface GithubSyncDeps {
  client: GithubClient | null;
  store: SyncStore;
  cfg: RefConfig;
  lineage: LineageEmitter | null;
  missionId?: string;
  requiredChecks?: readonly string[];
  rereviewCommand?: readonly string[];
  quorum?: QuorumReader | null;
  /** Runs the operator's re-review command; resolves true on exit 0. Test seam. */
  run?: (argv: string[]) => Promise<boolean>;
  now?: () => string;
}

export interface GateOutcome {
  target: string;
  head: string;
  decision: MergeDecision["decision"];
  reasons: string[];
  quorum: string | null;
}

export interface GithubSyncReport {
  status: "disabled" | ReconcileResult["status"];
  reconcile: ReconcileResult | null;
  rereviews: GithubRereviewRequest[];
  ciPrs: number;
  dependencyEdges: number;
  gates: GateOutcome[];
}

const defaultRun = (argv: string[]): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(argv[0] as string, argv.slice(1), { timeout: 30_000, windowsHide: true }, (err) => resolve(!err));
  });

const lower = (s: string | undefined): string | undefined => (s ? s.toLowerCase() : undefined);

export async function githubSync(deps: GithubSyncDeps): Promise<GithubSyncReport> {
  const report: GithubSyncReport = {
    status: "disabled",
    reconcile: null,
    rereviews: [],
    ciPrs: 0,
    dependencyEdges: 0,
    gates: [],
  };
  const { client, store, cfg, lineage } = deps;
  if (!client) return report;
  const now = deps.now ?? (() => new Date().toISOString());
  const sink = lineage as unknown as GithubLineageSink | null;
  const before = new Map(store.listGithubLinks(deps.missionId).map((l) => [l.linkId, lower(l.observed.headSha)]));

  const reconcile = await reconcileGithubLinks(client, store, cfg, {
    ...(deps.missionId ? { missionId: deps.missionId } : {}),
    sink,
    now,
  });
  report.reconcile = reconcile;
  report.status = reconcile.status;

  // 2. the stale reaction: every signal gets exactly one durable request.
  const run = deps.run ?? defaultRun;
  const done = new Set(store.listGithubRereviews(deps.missionId).map((r) => r.signalId));
  for (const signal of store.listGithubStaleSignals(deps.missionId)) {
    if (done.has(signal.signalId)) continue;
    let dispatch: GithubRereviewRequest["dispatch"] = "none";
    if (deps.rereviewCommand?.length) {
      const argv = [
        ...deps.rereviewCommand,
        "--pr",
        signal.target,
        "--head",
        signal.headSha,
        "--signal",
        signal.signalId,
      ];
      dispatch = (await run(argv)) ? "ok" : "failed";
    }
    const request: GithubRereviewRequest = {
      signalId: signal.signalId,
      missionId: signal.missionId,
      target: signal.target,
      headSha: signal.headSha,
      previousHeadSha: signal.previousHeadSha,
      requestedAt: now(),
      dispatch,
    };
    if (!store.recordGithubRereview(request)) continue;
    report.rereviews.push(request);
    lineage?.nodeUpsert(
      signal.target,
      { attrs: { rereview_head: signal.headSha, rereview_signal: signal.signalId } },
      `rereview:${signal.signalId}`,
      { mission_id: signal.missionId },
    );
  }

  const links = store.listGithubLinks(deps.missionId).filter((l) => l.status === "active");

  // 3 + 5. CI and the merge gate, per linked PR (a PR linked from several subjects is handled once).
  const seen = new Set<string>();
  for (const link of links) {
    if (link.targetKind !== "pr" || seen.has(link.target)) continue;
    seen.add(link.target);
    const ref = parseCanonicalId(link.target, cfg);
    const head = lower(link.observed.headSha);
    if (!ref || ref.kind !== "pr" || !head || !/^[0-9a-f]{7,64}$/.test(head)) continue;
    const scope = { mission_id: link.missionId };
    let runs: CheckRun[] = [];
    if (client.listCheckRuns) {
      try {
        runs = normalizeCheckRuns({ headSha: head, restCheckRuns: await client.listCheckRuns(ref, head) });
      } catch {
        runs = [];
      }
    }
    const required = deps.requiredChecks?.length ? [...deps.requiredChecks] : undefined;
    emitCiValidation(sink, ref, head, runs, scope, required ? { required } : {});
    report.ciPrs++;

    if (!deps.quorum) continue;
    const q = await deps.quorum(link.target);
    const review =
      q && q.head === head && q.status === "satisfied"
        ? ({ verdict: "PASS", sha: head } as const)
        : q && q.status === "blocked"
          ? ({ verdict: "FAIL", sha: head } as const)
          : null;
    // Pi's candidate is the head it last saw before this tick: a head that moved since is rejected, not merged.
    const candidate = before.get(link.linkId) ?? head;
    const decision = decideMerge({
      repo: `${ref.host}/${ref.owner}/${ref.repo}`,
      prNumber: ref.number,
      candidateSha: candidate,
      prHeadSha: head,
      baseSha: "",
      checks: runs.filter((r) => r.sha === head),
      requiredChecks: required ?? runs.map((r) => r.name),
      review,
      queue: [],
    });
    report.gates.push({
      target: link.target,
      head,
      decision: decision.decision,
      reasons: decision.reasons,
      quorum: q?.status ?? null,
    });
    const gate = lineageNodeId("gate", refKey(ref));
    lineage?.nodeUpsert(
      gate,
      {
        label: `merge gate ${decision.decision}`,
        state: decision.decision === "merge" ? "done" : decision.decision === "wait" ? "pending" : "failed",
        attrs: {
          decision: decision.decision,
          commit: head,
          reasons: decision.reasons.slice(0, 8).join("; ").slice(0, 400),
          quorum: q?.status ?? "unavailable",
        },
      },
      `gate:${head}:${decision.decision}`,
      scope,
    );
    if (decision.decision === "merge")
      lineage?.edgeAdd(
        "validated",
        gate,
        link.target,
        `gate-valid:${head}`,
        { commit: head, source: "merge-gate" },
        scope,
      );
  }

  // 4. dependency edges between the linked issues.
  const issueLinks = links.filter((l) => l.targetKind === "issue");
  const items: DependencyItem[] = [];
  const have = new Set<string>();
  for (const link of issueLinks) {
    const ref = parseCanonicalId(link.target, cfg);
    if (!ref || have.has(refKey(ref))) continue;
    have.add(refKey(ref));
    try {
      const issue = await client.getIssue(ref);
      const native = client.listDependencies ? await client.listDependencies(ref).catch(() => undefined) : undefined;
      items.push({
        ref,
        state: issue.state,
        ...(issue.stateReason ? { stateReason: issue.stateReason } : {}),
        body: issue.parseBody,
        bodyTruncated: issue.bodyTruncated,
        ...(native ? { nativeBlockedBy: native.blockedBy } : {}),
      });
    } catch {
      // an unreadable issue contributes no edges this tick
    }
  }
  if (items.length) {
    const graph = buildDependencyGraph(items, { cfg });
    const refs = new Map<string, GithubRef>();
    const define = (r: GithubRef, state?: "open" | "closed", scopeMission?: string): void => {
      const id = canonicalId({ ...r, kind: r.kind === "unknown" ? "issue" : r.kind });
      if (!id || refs.has(refKey(r))) return;
      refs.set(refKey(r), r);
      lineage?.nodeUpsert(
        id,
        {
          label: `${r.owner}/${r.repo}#${r.number}`,
          ...(state ? { state: targetState(r.kind === "pr" ? "pr" : "issue", state) } : {}),
          attrs: { repo: `${r.host}/${r.owner}/${r.repo}`, number: r.number },
        },
        `ghd-node:${id}:${state ?? "?"}`,
        scopeMission ? { mission_id: scopeMission } : {},
      );
    };
    const missionOf = (r: GithubRef) => issueLinks.find((l) => l.target === `issue:${refKey(r)}`)?.missionId;
    for (const it of items) define(it.ref, it.state, missionOf(it.ref));
    for (const e of graph.edges) {
      const p = parseCanonicalId(`issue:${e.prerequisite}`, cfg);
      if (p) define(p);
    }
    emitDependencyEdges(sink, graph.edges, refs, deps.missionId ? { mission_id: deps.missionId } : {});
    report.dependencyEdges = graph.edges.length;
  }
  return report;
}
