/**
 * Lineage projection of the GitHub layer (T05), through an INJECTED sink only.
 *
 * {@link GithubLineageSink} is a structural subset of the public `LineageEmitter` methods
 * (src/runtime/herdr/lineage.ts, T02): once that emitter is on this branch it can be passed in
 * as-is. This module imports nothing from T02. With `sink === null` every function is a no-op,
 * so a standalone Pi emits nothing.
 *
 * Contract (docs/contracts/lineage-events.md): ids are repo-qualified (`issue:github.com/o/r#n`,
 * `pr:...`); `issue_link` runs any -> issue/pr; `dependency` runs dependent -> prerequisite;
 * `produced` producer -> artifact; `validated` validator -> subject with `attrs.commit` required;
 * `edge.remove` needs a reason. A missing/invalid id drops the event, it never guesses one.
 */
import { createHash } from "node:crypto";
import type { CheckRun } from "../merge/mergeGate.ts";
import type { DependencyEdge } from "./dependencies.ts";
import { type GithubRef, canonicalId, parseCanonicalId } from "./refs.ts";
import type { GithubLinkRecord, LinkSubject } from "./types.ts";

export type GithubLineageState = "pending" | "running" | "blocked" | "done" | "failed" | "cancelled";
export type GithubEdgeType = "issue_link" | "dependency" | "produced" | "validated";

export interface GithubLineageScope {
  mission_id?: string;
  task_id?: string;
}

export interface GithubLineageSink {
  nodeUpsert(
    nodeId: string | undefined,
    spec: { label?: string; state?: GithubLineageState; attrs?: Record<string, unknown> },
    transition: string,
    scope?: GithubLineageScope,
    at?: string | Date,
  ): void;
  nodeState(
    nodeId: string | undefined,
    state: GithubLineageState,
    transition: string,
    opts?: { reason?: string },
    scope?: GithubLineageScope,
    at?: string | Date,
  ): void;
  edgeAdd(
    edgeType: GithubEdgeType,
    from: string | undefined,
    to: string | undefined,
    transition: string,
    attrs?: Record<string, unknown>,
    scope?: GithubLineageScope,
    at?: string | Date,
  ): void;
  edgeRemove(
    edgeType: GithubEdgeType,
    from: string | undefined,
    to: string | undefined,
    reason: string,
    transition: string,
    scope?: GithubLineageScope,
    at?: string | Date,
  ): void;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

export function subjectNodeId(subject: LinkSubject): string | undefined {
  if (!subject.id || subject.id.length > 190 || CONTROL.test(subject.id)) return undefined;
  return `${subject.kind}:${subject.id}`;
}

function scopeOf(link: GithubLinkRecord): GithubLineageScope {
  return { mission_id: link.missionId, ...(link.subject.kind === "task" ? { task_id: link.subject.id } : {}) };
}

export function targetState(kind: "issue" | "pr", state: string | undefined): GithubLineageState {
  if (state === "merged") return "done";
  if (state === "closed") return kind === "pr" ? "cancelled" : "done";
  return "pending";
}

/** Link recorded: target node (state/title), `issue_link` subject -> target, `produced` attempt -> PR. */
export function emitLinkRecorded(sink: GithubLineageSink | null | undefined, link: GithubLinkRecord): void {
  if (!sink || link.status !== "active") return;
  const from = subjectNodeId(link.subject);
  const scope = scopeOf(link);
  const t = `ghl:${link.linkId}:${link.observed.state ?? "-"}:${link.observed.headSha?.slice(0, 12) ?? "-"}:e${link.epoch ?? 0}:n${link.notFoundCount ?? 0}`;
  sink.nodeUpsert(
    link.target,
    {
      ...(link.observed.title ? { label: link.observed.title } : {}),
      state: targetState(link.targetKind, link.observed.state),
      attrs: {
        ...(link.observed.state ? { github_state: link.observed.state } : {}),
        ...(link.observed.headSha ? { head_sha: link.observed.headSha } : {}),
      },
    },
    t,
    scope,
  );
  sink.edgeAdd("issue_link", from, link.target, t, { provenance: link.provenance, source: link.source }, scope);
  if (link.targetKind === "pr" && link.subject.kind === "attempt") {
    sink.edgeAdd(
      "produced",
      from,
      link.target,
      t,
      link.observed.headSha ? { commit: link.observed.headSha } : undefined,
      scope,
    );
  }
}

/** A reconciliation correction. `removed`/`not_found` tombstone the edge with a reason. */
export function emitLinkCorrection(
  sink: GithubLineageSink | null | undefined,
  before: GithubLinkRecord,
  after: GithubLinkRecord,
  reason: string,
): void {
  if (!sink) return;
  const scope = scopeOf(before);
  const t = `ghc:${after.linkId}:${after.status}:${after.observed.state ?? "-"}:${after.observed.headSha?.slice(0, 12) ?? "-"}:e${after.epoch ?? 0}:n${after.notFoundCount ?? 0}`;
  if (after.status !== "active") {
    sink.edgeRemove("issue_link", subjectNodeId(before.subject), before.target, reason, t, scope);
    return;
  }
  sink.nodeState(before.target, targetState(after.targetKind, after.observed.state), t, { reason }, scope);
  if (after.observed.headSha && after.observed.headSha !== before.observed.headSha) {
    sink.nodeUpsert(
      before.target,
      {
        attrs: {
          head_sha: after.observed.headSha,
          ...(before.observed.headSha ? { previous_head_sha: before.observed.headSha } : {}),
        },
      },
      t,
      scope,
    );
  }
}

/** Dependency edges (dependent -> prerequisite) between repo-qualified issues. */
export function emitDependencyEdges(
  sink: GithubLineageSink | null | undefined,
  edges: readonly DependencyEdge[],
  refs: ReadonlyMap<string, GithubRef>,
  scope: GithubLineageScope = {},
): void {
  if (!sink) return;
  for (const e of edges) {
    const a = refs.get(e.dependent);
    const b = refs.get(e.prerequisite);
    // A text-declared prerequisite is an issue by the Dependencies-section contract.
    const from = a ? canonicalId({ ...a, kind: a.kind === "unknown" ? "issue" : a.kind }) : undefined;
    const to = b ? canonicalId({ ...b, kind: b.kind === "unknown" ? "issue" : b.kind }) : undefined;
    sink.edgeAdd(
      "dependency",
      from,
      to,
      `ghd:${e.dependent}>${e.prerequisite}`,
      { source: e.source, cross_repo: e.crossRepo },
      scope,
    );
  }
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._ -]+/g, "_").slice(0, 40);
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

/**
 * `ci:` node id for one check run: readable prefix plus a hash of the ORIGINAL name, so two names that
 * sanitise alike (`build_x` / `build/x`) stay distinct, and bounded to the contract's 200 characters.
 */
export function ciNodeId(prKey: string, headSha: string, name: string): string {
  const tail = `${headSha.slice(0, 12)}/${safeName(name)}~${shortHash(name)}`;
  const id = `ci:${prKey}@${tail}`;
  return id.length <= 200 ? id : `ci:${shortHash(prKey)}@${tail}`;
}

export interface CiValidationOptions {
  /** Check names that must pass. Default: EVERY known run on the head must be pass/skipped. */
  required?: readonly string[];
}

/**
 * CI evidence for the exact head: a `ci:` node per known, completed check run whose SHA equals
 * `headSha`. A `validated` edge (ci -> PR, `attrs.commit = headSha`) is added for the passing runs
 * only when the head is GREEN as a whole: no pending, no failing run (or, with `required`, every
 * required check present and passing). One green check among failures validates nothing.
 */
export function emitCiValidation(
  sink: GithubLineageSink | null | undefined,
  pr: GithubRef,
  headSha: string,
  runs: readonly CheckRun[],
  scope: GithubLineageScope = {},
  options: CiValidationOptions = {},
): void {
  const prId = canonicalId({ ...pr, kind: "pr" });
  if (!sink || !prId || !/^[0-9a-f]{7,64}$/.test(headSha)) return;
  const onHead = runs.filter((r) => r.sha.toLowerCase() === headSha);
  const prKey = prId.slice(3);
  const required = options.required;
  const green = required
    ? required.every((name) => onHead.some((r) => r.name === name && r.status === "pass"))
    : onHead.length > 0 && onHead.every((r) => r.status === "pass" || r.status === "skipped");
  for (const run of onHead) {
    if (run.status === "pending") continue;
    const ci = ciNodeId(prKey, headSha, run.name);
    const t = `ghv:${ci}:${run.status}`;
    sink.nodeUpsert(
      ci,
      {
        label: safeName(run.name),
        state: run.status === "pass" ? "done" : run.status === "fail" ? "failed" : "cancelled",
        attrs: { commit: headSha },
      },
      t,
      scope,
    );
    const counts = run.status === "pass" && (!required || required.includes(run.name));
    if (green && counts) sink.edgeAdd("validated", ci, prId, t, { commit: headSha }, scope);
  }
}

export { parseCanonicalId };
