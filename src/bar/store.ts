/**
 * BAR persistent audit store (steps .../implement-persistent-data-model).
 *
 * Append-only JSONL backing for requirement records, immutable baselines and
 * repair campaigns. Resumable and idempotent: reopening the store reloads every
 * record, and re-applying an already-known requirement id updates in place
 * rather than duplicating. This mirrors the CAV evidence-ledger discipline
 * (append-only, addressable) while keeping the BAR domain model separate.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { id } from "../core/ids.ts";
import type { AuditBaseline, AuditReport, RepairCampaign, RequirementRecord } from "./types.ts";

interface StoreFile<T> {
  name: string;
  parse: (line: string) => T | null;
}

export interface BarStorePaths {
  dir: string;
  requirements: string;
  baselines: string;
  campaigns: string;
  reports: string;
}

export function defaultBarStorePaths(root: string): BarStorePaths {
  const dir = join(root, ".pi-eng", "bar");
  return {
    dir,
    requirements: join(dir, "requirements.jsonl"),
    baselines: join(dir, "baselines.jsonl"),
    campaigns: join(dir, "campaigns.jsonl"),
    reports: join(dir, "reports.jsonl"),
  };
}

export class BarStore {
  private readonly paths: BarStorePaths;
  private readonly requirements = new Map<string, RequirementRecord>();
  private readonly baselines = new Map<string, AuditBaseline>();
  private readonly campaigns = new Map<string, RepairCampaign>();
  private readonly reports = new Map<string, AuditReport>();
  private chain: Promise<void> = Promise.resolve();

  private constructor(paths: BarStorePaths) {
    this.paths = paths;
  }

  static async open(root: string): Promise<BarStore> {
    const s = new BarStore(defaultBarStorePaths(root));
    await s.loadAll();
    return s;
  }

  static inMemory(): BarStore {
    // Empty paths => memory-only (no file IO). loadAll is a no-op.
    return new BarStore({
      dir: "",
      requirements: "",
      baselines: "",
      campaigns: "",
      reports: "",
    });
  }

  private async loadAll(): Promise<void> {
    await this.loadLines<RequirementRecord>(this.paths.requirements, (r) => {
      this.requirements.set(r.id, r);
      return r;
    });
    await this.loadLines<AuditBaseline>(this.paths.baselines, (b) => this.baselines.set(b.auditId, b));
    await this.loadLines<RepairCampaign>(this.paths.campaigns, (c) => this.campaigns.set(c.id, c));
    await this.loadLines<AuditReport>(this.paths.reports, (r) => this.reports.set(r.auditId, r));
  }

  private async loadLines<T>(file: string, apply: (rec: T) => void, parse?: (line: string) => T): Promise<void> {
    const parseLine = parse ?? ((line: string) => JSON.parse(line) as T);
    if (!file) return;
    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        apply(parseLine(line));
      } catch {
        // ignore corrupt lines (resume-safe)
      }
    }
  }

  private async appendLine(file: string, rec: unknown): Promise<void> {
    if (!file) {
      return;
    }
    const op = this.chain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(rec)}\n`, "utf-8");
    });
    this.chain = op.catch(() => {});
    await op;
  }

  // ---------------------------------------------------------------- upsert

  /** Insert or update a requirement record by id (idempotent). */
  async upsertRequirement(input: RequirementRecord): Promise<void> {
    const prev = this.requirements.get(input.id);
    const rec = prev ? { ...input, createdAt: prev.createdAt } : input;
    this.requirements.set(rec.id, rec);
    await this.appendLine(this.paths.requirements, rec);
  }

  async saveBaseline(base: AuditBaseline): Promise<void> {
    // Baselines are append-only and immutable by construction (BASELINE
    // contract). If an auditId is already recorded, never overwrite it: the
    // original immutable snapshot is authoritative. Returns true when newly
    // stored, false when the existing immutable baseline was preserved.
    const existing = this.baselines.get(base.auditId);
    if (existing) {
      return false;
    }
    const record = { ...base, immutable: true as const };
    this.baselines.set(record.auditId, record);
    await this.appendLine(this.paths.baselines, record);
    return true;
  }

  async saveCampaign(c: RepairCampaign): Promise<void> {
    this.campaigns.set(c.id, c);
    await this.appendLine(this.paths.campaigns, c);
  }

  async saveReport(r: AuditReport): Promise<void> {
    this.reports.set(r.auditId, r);
    await this.appendLine(this.paths.reports, r);
  }

  // ---------------------------------------------------------------- queries

  listRequirements(): RequirementRecord[] {
    return [...this.requirements.values()];
  }

  getRequirement(reqId: string): RequirementRecord | undefined {
    return this.requirements.get(reqId);
  }

  listBaselines(): AuditBaseline[] {
    return [...this.baselines.values()];
  }

  getBaseline(auditId: string): AuditBaseline | undefined {
    return this.baselines.get(auditId);
  }

  listCampaigns(): RepairCampaign[] {
    return [...this.campaigns.values()];
  }

  getCampaign(id: string): RepairCampaign | undefined {
    return this.campaigns.get(id);
  }

  listReports(): AuditReport[] {
    return [...this.reports.values()];
  }

  getReport(auditId: string): AuditReport | undefined {
    return this.reports.get(auditId);
  }

  static newRequirementId(): string {
    return id("BARREQ");
  }
}
