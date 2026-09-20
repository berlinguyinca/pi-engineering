/**
 * BAR immutable baseline preservation (steps .../cav-baseline, BASELINE
 * contract).
 *
 * Before any repair, an audit baseline is persisted and is append-only and
 * addressable by audit ID. Baselines are immutable by construction: the
 * `immutable: true` marker is structural, and the store only appends new
 * baselines (never overwrites an existing one).
 */

import { createHash } from "node:crypto";
import { platform, release, tmpdir } from "node:os";
import { id } from "../core/ids.ts";
import type { AuditBaseline, BarGateStatus, RequirementRecord } from "./types.ts";

export interface BaselineInput {
  project: string;
  sourceRevision: string;
  requirements: RequirementRecord[];
  services: string[];
  cavResults: Array<{ gate: string; status: BarGateStatus }>;
  findings: string[];
  defectLedgerRef?: string | null;
  cwd: string;
}

/** Compute a deterministic environment fingerprint. */
export function environmentFingerprint(cwd: string): string {
  const raw = JSON.stringify({ platform: platform(), release: release(), tmp: tmpdir(), cwd });
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** Build (but do not persist) an immutable baseline. */
export function buildBaseline(input: BaselineInput): AuditBaseline {
  const auditId = id("BARAUDIT");
  return {
    auditId,
    project: input.project,
    sourceRevision: input.sourceRevision,
    environment: {
      platform: platform(),
      node: process.versions?.node ?? "unknown",
      cwd: input.cwd,
      fingerprint: environmentFingerprint(input.cwd),
    },
    createdAt: new Date().toISOString(),
    immutable: true,
    requirements: input.requirements.map((r) => ({ id: r.id, state: r.state, statement: r.statement })),
    services: input.services,
    cavResults: input.cavResults,
    findings: input.findings,
    defectLedgerRef: input.defectLedgerRef ?? null,
  };
}
