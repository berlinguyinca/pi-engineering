/**
 * Linked-PR source for `/summary <session id>`: the PRs the Ledger recorded with `work_item.pr_linked` (the same
 * durable data that projects as `issue_link` task -> PR edges in taskLineage/taskRefs). No new store.
 */
import type { WorkItemPrLink } from "../core/types.ts";

/** The slice of the Ledger this needs. */
export interface LinkedPrsLedger {
  getTask(id: string): { work_item_id: string } | undefined;
  listPrLinks(workItemId: string): WorkItemPrLink[];
}

/** `owner/repo#n`, with the host prefixed when it is not github.com. */
export const prLabel = (l: WorkItemPrLink): string =>
  `${l.host === "github.com" ? "" : `${l.host}/`}${l.owner}/${l.repo}#${l.number}`;

/** Resolver for `getSessionSummary`'s `linkedPrs` option: a work item id or a Ledger task id -> its PR labels. */
export function ledgerLinkedPrs(ledger: LinkedPrsLedger): (taskId: string) => string[] {
  return (taskId) => ledger.listPrLinks(ledger.getTask(taskId)?.work_item_id ?? taskId).map(prLabel);
}
