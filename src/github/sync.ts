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
import { isAbsolute } from "node:path";
import { normalizeCheckRuns } from "../merge/checkRunIngest.ts";
import { decideMerge } from "../merge/mergeGate.ts";
import type { CheckRun, MergeDecision } from "../merge/mergeGate.ts";
import { type LineageEmitter, lineageNodeId } from "../runtime/herdr/lineage.ts";
import type { GithubClient } from "./client.ts";
import { type DependencyItem, buildDependencyGraph } from "./dependencies.ts";
import { type GithubLineageSink, emitCiValidation, emitDependencyEdges, targetState } from "./lineage.ts";
import type { QuorumReader, RereviewAnswer, RereviewRequester } from "./quorum.ts";
import { type ReconcileResult, type ReconcileStore, reconcileGithubLinks } from "./reconcile.ts";
import { type GithubRef, type RefConfig, canonicalId, parseCanonicalId, refKey } from "./refs.ts";
import type { GithubGateDecision, GithubRereviewRequest, GithubStaleSignal } from "./types.ts";

export interface SyncStore extends ReconcileStore {
  listGithubStaleSignals(missionId?: string): GithubStaleSignal[];
  recordGithubRereview(request: GithubRereviewRequest): boolean;
  updateGithubRereview(request: GithubRereviewRequest): boolean;
  getGithubRereview(signalId: string): GithubRereviewRequest | undefined;
  recordGithubGate(
    missionId: string,
    target: string,
    head: string,
    decision: string,
  ): { gate: GithubGateDecision; previous: GithubGateDecision | undefined };
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
  /** Names of environment variables the re-review command may see (YAML `github.rereview_env`); none by default. */
  rereviewEnv?: readonly string[];
  quorum?: QuorumReader | null;
  /**
   * Asks Herdr to RECORD a re-review request for the stale head (`review-quorum/rereview`), once per stale signal.
   * Herdr dispatches nothing: the operator's `rereview_command` (and AutoSpec) still do the review.
   */
  rereview?: RereviewRequester | null;
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

export const REREVIEW_TIMEOUT_MS = 30_000;
export const REREVIEW_MAX_OUTPUT = 64 * 1024;
export const REREVIEW_MAX_ATTEMPTS = 5;
export const REREVIEW_BACKOFF_MS = 30_000;
/** A crash between "inflight" and the outcome is re-dispatched after this long (delivery is at-least-once). */
export const REREVIEW_INFLIGHT_LEASE_MS = 5 * 60_000;
const BASE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER"];

/**
 * Run the operator's re-review command: no shell, an absolute executable, a scrubbed environment (the base variables
 * plus only the names the YAML lists: never GIT_*, GH_* or tokens by default), bounded output and time.
 */
export function runRereviewCommand(
  argv: string[],
  allowEnv: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return new Promise((resolve) => {
    const exe = argv[0];
    if (!exe || !isAbsolute(exe)) return resolve(false);
    const env: NodeJS.ProcessEnv = {};
    for (const k of [...BASE_ENV, ...allowEnv]) if (source[k] !== undefined) env[k] = source[k];
    execFile(
      exe,
      argv.slice(1),
      { timeout: REREVIEW_TIMEOUT_MS, maxBuffer: REREVIEW_MAX_OUTPUT, windowsHide: true, env, shell: false },
      (err) => resolve(!err),
    );
  });
}

const inflightHere = new Set<string>();

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

  // 2. the stale reaction: every signal gets one durable request, written BEFORE the command runs (at-least-once on a
  // crash), retried with backoff while the command fails, and never run twice by two overlapping ticks in this process
  // (a second PROCESS cannot open the same store: the journal's writer lock).
  const run = deps.run ?? ((argv: string[]) => runRereviewCommand(argv, deps.rereviewEnv ?? []));
  const hasCommand = Boolean(deps.rereviewCommand?.length);
  const askHerdr = deps.rereview ?? null;
  if (askHerdr) await lineage?.idle().catch(() => undefined); // Herdr must hold the new head before it is asked about it
  for (const signal of store.listGithubStaleSignals(deps.missionId)) {
    const existing = store.getGithubRereview(signal.signalId);
    const nowMs = Date.parse(now());
    let commandDue = hasCommand;
    if (existing) {
      commandDue = hasCommand && existing.dispatch !== "ok" && existing.dispatch !== "none";
      if (commandDue) {
        const attempts = existing.attempts ?? 1;
        if (existing.dispatch === "failed") {
          if (attempts >= REREVIEW_MAX_ATTEMPTS) commandDue = false;
          else if (existing.nextAttemptAt && Date.parse(existing.nextAttemptAt) > nowMs) commandDue = false;
        }
        if (
          existing.dispatch === "inflight" &&
          Date.parse(existing.inflightAt ?? existing.requestedAt) + REREVIEW_INFLIGHT_LEASE_MS > nowMs
        )
          commandDue = false;
      }
    }
    // Herdr's ledger is idempotent per PR head, so a crash before the answer was stored only repeats a harmless ask.
    let askDue = Boolean(askHerdr);
    if (askDue && existing?.ask) {
      askDue =
        existing.ask.state === "failed" &&
        existing.ask.attempts < REREVIEW_MAX_ATTEMPTS &&
        !(existing.ask.nextAt && Date.parse(existing.ask.nextAt) > nowMs);
    }
    if (!commandDue && !askDue) continue;
    if (inflightHere.has(signal.signalId)) continue;
    const attempts = (existing?.attempts ?? 0) + (commandDue ? 1 : 0);
    const base: GithubRereviewRequest = {
      ...(existing ?? {}),
      signalId: signal.signalId,
      missionId: signal.missionId,
      target: signal.target,
      headSha: signal.headSha,
      previousHeadSha: signal.previousHeadSha,
      requestedAt: existing?.requestedAt ?? now(),
      dispatch: commandDue ? "inflight" : (existing?.dispatch ?? "none"),
      attempts,
      ...(commandDue ? { inflightAt: now() } : {}),
    };
    if (!existing) {
      if (!store.recordGithubRereview(base)) continue;
    } else if (commandDue) store.updateGithubRereview(base); // the in-flight marker; an ask-only retry has nothing to persist yet
    let final = base;
    let changed = false;
    if (askDue && askHerdr) {
      inflightHere.add(signal.signalId);
      let answer: RereviewAnswer;
      try {
        answer = await askHerdr(signal.target, signal.headSha);
      } catch {
        answer = { state: "failed", reason: "error" };
      } finally {
        inflightHere.delete(signal.signalId);
      }
      const tries = (existing?.ask?.attempts ?? 0) + 1;
      final = {
        ...final,
        ask: {
          state: answer.state,
          attempts: tries,
          ...(answer.state === "failed"
            ? { nextAt: new Date(Date.parse(now()) + REREVIEW_BACKOFF_MS * 2 ** (tries - 1)).toISOString() }
            : {}),
          ...(answer.requestId ? { requestId: answer.requestId } : {}),
          ...(answer.reason ? { reason: answer.reason } : {}),
        },
      };
      store.updateGithubRereview(final);
      changed = true;
    }
    if (commandDue) {
      inflightHere.add(signal.signalId);
      let ok = false;
      try {
        ok = await run([
          ...(deps.rereviewCommand as string[]),
          "--pr",
          signal.target,
          "--head",
          signal.headSha,
          "--signal",
          signal.signalId,
        ]);
      } catch {
        ok = false;
      } finally {
        inflightHere.delete(signal.signalId);
      }
      const { inflightAt: _i, ...rest } = final;
      final = ok
        ? { ...rest, dispatch: "ok" }
        : {
            ...rest,
            dispatch: "failed",
            nextAttemptAt: new Date(Date.parse(now()) + REREVIEW_BACKOFF_MS * 2 ** (attempts - 1)).toISOString(),
          };
      store.updateGithubRereview(final);
      changed = true;
    }
    if (!existing) report.rereviews.push(final);
    else if (changed && (final.dispatch === "ok" || final.ask?.state === "ok")) report.rereviews.push(final);
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
    // No answer from the checks API (absent, failing or malformed) is "no CI evidence", never "no checks needed".
    let checksUnavailable = !client.listCheckRuns;
    if (client.listCheckRuns) {
      try {
        runs = normalizeCheckRuns({ headSha: head, restCheckRuns: await client.listCheckRuns(ref, head) });
      } catch {
        runs = [];
        checksUnavailable = true;
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
    const onHead = runs.filter((r) => r.sha === head);
    let decision = decideMerge({
      repo: `${ref.host}/${ref.owner}/${ref.repo}`,
      prNumber: ref.number,
      candidateSha: candidate,
      prHeadSha: head,
      baseSha: "",
      checks: onHead,
      requiredChecks: required ?? onHead.map((r) => r.name),
      review,
      queue: [],
    });
    // Fail closed: a merge needs CI evidence for this head. A broken checks API, a client that cannot list checks, or
    // a head with no check at all (when no required_checks are configured) waits.
    if (decision.decision === "merge" && (checksUnavailable || onHead.length === 0)) {
      decision = {
        ...decision,
        decision: "wait",
        reasons: [
          checksUnavailable ? "no CI evidence: the checks could not be read" : "no CI evidence: no checks on this head",
        ],
      };
    }
    report.gates.push({
      target: link.target,
      head,
      decision: decision.decision,
      reasons: decision.reasons,
      quorum: q?.status ?? null,
    });
    const gate = lineageNodeId("gate", refKey(ref));
    const { gate: rec, previous } = store.recordGithubGate(link.missionId, link.target, head, decision.decision);
    const rev = rec.revision;
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
      `gate:${head}:${decision.decision}:${rev}`,
      scope,
    );
    if (decision.decision === "merge") {
      lineage?.edgeAdd(
        "validated",
        gate,
        link.target,
        `gate-valid:${head}:${rev}`,
        { commit: head, source: "merge-gate" },
        scope,
      );
    } else if (previous?.decision === "merge") {
      // The gate no longer says merge (at this or another head): withdraw Pi's own edge, with the reason.
      lineage?.edgeRemove(
        "validated",
        gate,
        link.target,
        `merge gate is now ${decision.decision}: ${decision.reasons[0] ?? "no reason"}`.slice(0, 300),
        `gate-void:${head}:${rev}`,
        scope,
      );
    }
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
