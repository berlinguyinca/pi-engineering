import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { id } from "../core/ids.ts";
import { CavGateError } from "./guard.ts";
import {
  type CavEvidence,
  type CavStatus,
  type CavStepState,
  REVIEWER_ROLES,
  VERIFIED_PROMOTER_ROLES,
} from "./types.ts";

/**
 * CAV role-gated evidence ledger (EVIDENCE_LEDGER contract).
 *
 * Append-only, JSONL-backed, concurrency-safe. Reconciles with the generic
 * Engineering Ledger: this is the focused CAV evidence record keyed by stable
 * CAV requirement IDs. Status promotion is role-gated — the implementer cannot
 * write VERIFIED, and UNKNOWN/SKIPPED never satisfy a required gate.
 */

const PROMOTION_ORDER: CavStatus[] = [
  "SPECIFIED",
  "IMPLEMENTED",
  "TESTED",
  "INTEGRATION_VERIFIED",
  "E2E_VERIFIED",
  "VISUALLY_VERIFIED",
  "INDEPENDENTLY_REVIEWED",
  "RECONCILED",
  "VERIFIED",
];

export interface CavEvidenceOptions {
  gitSha: string;
  role: string;
  workerRunId: string;
  gateType: string;
  tool: string;
  command: string;
  exitCode: number;
  artifacts?: string[];
  environment?: string;
  failureReason?: string | null;
}

export class CavEvidenceLedger {
  private readonly file: string;
  private readonly memoryOnly: boolean;
  private readonly records: CavEvidence[] = [];
  private appendChain: Promise<void> = Promise.resolve();

  private constructor(file: string, memoryOnly: boolean) {
    this.file = file;
    this.memoryOnly = memoryOnly;
  }

  static async open(file: string): Promise<CavEvidenceLedger> {
    const l = new CavEvidenceLedger(file, false);
    await l.load();
    return l;
  }

  static inMemory(): CavEvidenceLedger {
    return new CavEvidenceLedger("", true);
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf-8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as CavEvidence;
        if (rec?.requirement_id) this.records.push(rec);
      } catch {
        // ignore corrupt lines
      }
    }
  }

  private async append(rec: CavEvidence): Promise<void> {
    const op = this.appendChain.then(async () => {
      if (!this.memoryOnly) {
        await mkdir(dirname(this.file), { recursive: true });
        await appendFile(this.file, `${JSON.stringify(rec)}\n`, "utf-8");
      }
      this.records.push(rec);
    });
    this.appendChain = op.catch(() => {});
    await op;
  }

  /**
   * Record evidence for a CAV requirement. The status recorded here may be any
   * CavStepState EXCEPT a promoted completion state beyond what the role may
   * grant. Promotion to VERIFIED is enforced separately via promote().
   */
  async record(requirementId: string, status: CavStepState, opts: CavEvidenceOptions): Promise<CavEvidence> {
    const now = new Date().toISOString();
    const rec: CavEvidence = {
      id: id("CAVEVID"),
      requirement_id: requirementId,
      status,
      git_sha: opts.gitSha,
      role: opts.role,
      worker_run_id: opts.workerRunId,
      started_at: now,
      finished_at: now,
      gate_type: opts.gateType,
      tool: opts.tool,
      command: opts.command,
      exit_code: opts.exitCode,
      artifacts: opts.artifacts ?? [],
      environment: opts.environment ?? "local",
      failure_reason: opts.failureReason ?? null,
    };
    await this.append(rec);
    return rec;
  }

  /**
   * Promote a step's latest evidence to a higher completion state.
   *
   * Role-gated: VERIFIED requires a VERIFIED_PROMOTER_ROLE (implementer is
   * excluded); INDEPENDENTLY_REVIEWED requires a reviewer role. Throws
   * CavGateError otherwise so the deterministic gate fails closed.
   */
  async promote(
    requirementId: string,
    target: CavStatus,
    opts: CavEvidenceOptions,
    currentStatus?: CavStepState,
  ): Promise<CavEvidence> {
    const prior = currentStatus ?? this.latestStatus(requirementId);
    // No prior evidence => nothing to promote. A reviewer cannot conjure a
    // completion state from an empty ledger ("no evidence = no verification").
    if (!prior) {
      throw new CavGateError(`cannot promote ${requirementId}: no recorded evidence to promote from`);
    }
    const from = prior;
    const fromRank = from === "WAIVED" ? -1 : PROMOTION_ORDER.indexOf(from as CavStatus);
    const targetRank = PROMOTION_ORDER.indexOf(target);
    if (targetRank < 0) throw new CavGateError(`invalid promotion target: ${target}`);
    if (targetRank <= fromRank) {
      throw new CavGateError(`cannot promote ${requirementId}: ${from} -> ${target} is not forward progress`);
    }
    if (target === "VERIFIED" && !VERIFIED_PROMOTER_ROLES.has(opts.role)) {
      throw new CavGateError(
        `role '${opts.role}' cannot write VERIFIED for ${requirementId}; promoter roles: ${[
          ...VERIFIED_PROMOTER_ROLES,
        ].join(", ")}`,
      );
    }
    if (target === "INDEPENDENTLY_REVIEWED" && !REVIEWER_ROLES.has(opts.role)) {
      throw new CavGateError(`role '${opts.role}' cannot write INDEPENDENTLY_REVIEWED for ${requirementId}`);
    }
    return this.record(requirementId, target, opts);
  }

  latestStatus(requirementId: string): CavStepState | undefined {
    let latest: CavEvidence | undefined;
    for (const r of this.records) {
      if (r.requirement_id !== requirementId) continue;
      if (!latest || r.finished_at >= latest.finished_at) latest = r;
    }
    return latest?.status;
  }

  latestEvidence(requirementId: string): CavEvidence | undefined {
    let latest: CavEvidence | undefined;
    for (const r of this.records) {
      if (r.requirement_id !== requirementId) continue;
      if (!latest || r.finished_at >= latest.finished_at) latest = r;
    }
    return latest;
  }

  byRequirement(requirementId: string): CavEvidence[] {
    return this.records.filter((r) => r.requirement_id === requirementId);
  }

  all(): CavEvidence[] {
    return this.records.slice();
  }

  count(): number {
    return this.records.length;
  }

  clear(): void {
    this.records.length = 0;
    if (!this.memoryOnly) void rm(this.file, { force: true }).catch(() => {});
  }
}

/** A step is VERIFIED only if its latest evidence status is exactly VERIFIED. */
export function isStepVerified(ledger: CavEvidenceLedger, requirementId: string): boolean {
  return ledger.latestStatus(requirementId) === "VERIFIED";
}
