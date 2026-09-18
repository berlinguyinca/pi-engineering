/**
 * CAV-12 Defect Ledger and Repair Loop: convert failures into defects, repair,
 * selectively rerun and close with evidence.
 *
 * A defect is opened from a failing gate, repaired, and closed ONLY when a
 * re-run of the failing gate passes. Closing requires evidence (a passing
 * rerun); prose cannot close a defect. This is the repair-loop contract.
 */
import { id } from "../core/ids.ts";

export type DefectStatus = "open" | "in_progress" | "closed" | "wontfix";

export interface Defect {
  defect_id: string;
  requirement_id: string;
  status: DefectStatus;
  title: string;
  description: string;
  /** Evidence ids that surfaced the defect (failing gates). */
  failing_evidence: string[];
  /** Evidence id that closed it (passing rerun). */
  closing_evidence: string | null;
  opened_at: string;
  closed_at: string | null;
  assignee_role: string;
}

export class DefectLedger {
  private readonly defects = new Map<string, Defect>();

  open(
    requirementId: string,
    title: string,
    description: string,
    failingEvidence: string[],
    assigneeRole: string,
  ): Defect {
    const now = new Date().toISOString();
    const defect: Defect = {
      defect_id: id("DEFECT"),
      requirement_id: requirementId,
      status: "open",
      title,
      description,
      failing_evidence: failingEvidence,
      closing_evidence: null,
      opened_at: now,
      closed_at: null,
      assignee_role: assigneeRole,
    };
    this.defects.set(defect.defect_id, defect);
    return defect;
  }

  get(defectId: string): Defect | undefined {
    return this.defects.get(defectId);
  }

  list(status?: DefectStatus): Defect[] {
    const all = [...this.defects.values()];
    return status ? all.filter((d) => d.status === status) : all;
  }

  markInProgress(defectId: string): void {
    const d = this.defects.get(defectId);
    if (d && d.status === "open") d.status = "in_progress";
  }

  /**
   * Close a defect ONLY with a passing rerun evidence id. A null/absent closing
   * evidence fails closed: a defect cannot be closed by prose.
   */
  close(defectId: string, closingEvidence: string): Defect {
    const d = this.defects.get(defectId);
    if (!d) throw new Error(`unknown defect ${defectId}`);
    if (!closingEvidence) throw new Error(`cannot close ${defectId}: closing evidence required`);
    d.status = "closed";
    d.closing_evidence = closingEvidence;
    d.closed_at = new Date().toISOString();
    return d;
  }

  openDefects(): Defect[] {
    return this.list("open").concat(this.list("in_progress"));
  }

  count(): number {
    return this.defects.size;
  }
}
