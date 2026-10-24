/**
 * AutoSpec DAG -> Herdr lineage (T04 projection).
 *
 * After a DAG is ingested and bound to the plan gate, the plan CLI projects what the DAG says, and only that:
 *  - a `task` node per DAG task (state `pending`) with `dependency` edges dependent -> prerequisite;
 *  - an `issue` node per repo-qualified issue ref (label and repo/number attrs, NO state: Pi has not asked GitHub, so
 *    it does not invent open/closed) and an `issue_link` edge task -> issue.
 *
 * Issue nodes are written with fields (a bare "ensure" does not give the node a claim, and Herdr refuses an edge to
 * a node nobody defined). Task ids are mission-qualified (`task:<mission>/<task>`): AutoSpec task ids such as `t-1`
 * repeat across missions. Absent emitter = no-op.
 */

import { canonicalId, parseGithubRef } from "../../github/refs.ts";
import { type LineageEmitter, lineageNodeId } from "../../runtime/herdr/lineage.ts";
import type { DagIngestResult } from "./dagIngest.ts";

export const dagTaskNodeId = (missionId: string, taskId: string): string | undefined =>
  lineageNodeId("task", `${missionId}/${taskId}`);

export interface DagLineageSummary {
  tasks: number;
  issues: number;
  dependencies: number;
  skipped: number;
}

export function emitDagLineage(
  lineage: LineageEmitter | null | undefined,
  ingest: Extract<DagIngestResult, { ok: true }>,
  hosts?: readonly string[],
): DagLineageSummary {
  const out: DagLineageSummary = { tasks: 0, issues: 0, dependencies: 0, skipped: 0 };
  if (!lineage) return out;
  const scope = { mission_id: ingest.missionId };
  const seenIssues = new Set<string>();
  for (const task of ingest.tasks) {
    const taskId = task.task_id;
    const node = taskId ? dagTaskNodeId(ingest.missionId, taskId) : undefined;
    if (!taskId || !node) {
      out.skipped++;
      continue;
    }
    lineage.nodeUpsert(
      node,
      { label: task.objective.slice(0, 120), state: "pending", attrs: { role: task.role, source: "autospec" } },
      "dag",
      { ...scope, task_id: taskId },
    );
    out.tasks++;
    for (const dep of task.depends_on ?? []) {
      const to = dagTaskNodeId(ingest.missionId, dep);
      lineage.edgeAdd("dependency", node, to, `dag:${taskId}>${dep}`, { source: "autospec" }, scope);
      if (to) out.dependencies++;
    }
    for (const text of ingest.issueRefs.get(taskId) ?? []) {
      const parsed = parseGithubRef(text, hosts ? { hosts } : {});
      if (!parsed.ok) {
        out.skipped++;
        continue;
      }
      // `owner/repo#N` from autospec.issue_refs is an issue by the extension's contract.
      const id = canonicalId({ ...parsed.ref, kind: "issue" });
      if (!id) {
        out.skipped++;
        continue;
      }
      if (!seenIssues.has(id)) {
        seenIssues.add(id);
        lineage.nodeUpsert(
          id,
          {
            label: `${parsed.ref.owner}/${parsed.ref.repo}#${parsed.ref.number}`,
            attrs: { repo: `${parsed.ref.host}/${parsed.ref.owner}/${parsed.ref.repo}`, number: parsed.ref.number },
          },
          "dag-issue",
          scope,
        );
        out.issues++;
      }
      lineage.edgeAdd(
        "issue_link",
        node,
        id,
        `dag:${taskId}>${id}`,
        { provenance: "autospec", source: "issue_refs" },
        {
          ...scope,
          task_id: taskId,
        },
      );
    }
  }
  return out;
}
