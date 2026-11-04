/**
 * B05: result gate + immutable handoff writer. Verifies collected proof (verify-command exit codes, evidence artifacts,
 * the B03 diff-scope report, the commit's parent SHA) and writes the handoff atomically, never overwriting, stamping
 * the protocol checksum. Never commits, pushes or invokes a model.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiffGuardReport } from "./diffGuard.ts";
export interface Proof { command: string; exitCode: number; outputArtifact: string }
export interface GateObservations { requiredCommands: readonly string[]; proofs: readonly Proof[]; artifactSha256: Readonly<Record<string, string | null>>; expectedArtifactSha256?: Readonly<Record<string, string>>; diff: DiffGuardReport; commitParentSha: string; approvedBaseSha: string }
export interface GateResult { ok: boolean; blockers: string[] }
/** Protocol canonicalization (02-HANDOFF-PROTOCOL.md:15): sorted keys at every level, compact JSON, UTF-8, `handoffHash` excluded. */
export function canonicalHash(record: unknown): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sort((value as Record<string, unknown>)[key])])) : value;
  const clone = { ...(record as Record<string, unknown>) }; delete clone.handoffHash; return `sha256:${createHash("sha256").update(JSON.stringify(sort(clone)), "utf8").digest("hex")}`;
}

export function hashArtifact(path: string): string | null { try { return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`; } catch { return null; } }
export function evaluateResultGate(obs: GateObservations): GateResult {
  const proofs = new Map(obs.proofs.map((proof) => [proof.command, proof])); const blockers: string[] = [];
  for (const command of obs.requiredCommands) { const proof = proofs.get(command);
    if (proof === undefined) blockers.push(`missing proof for required command: ${command}`); else if (proof.exitCode !== 0) blockers.push(`proof exit code ${proof.exitCode} != 0 for: ${command}`); }
  for (const proof of obs.proofs) {
    const sha = obs.artifactSha256[proof.outputArtifact] ?? null; const want = obs.expectedArtifactSha256?.[proof.outputArtifact];
    if (sha === null) blockers.push(`evidence artifact absent or unreadable: ${proof.outputArtifact}`); else if (want !== undefined && sha !== want) blockers.push(`evidence tampered: ${proof.outputArtifact} sha ${sha} != recorded ${want}`);
  }
  if (!obs.diff.ok) for (const violation of obs.diff.violations) blockers.push(`diff scope rejected (${violation.kind}): ${violation.detail}`);
  if (obs.commitParentSha !== obs.approvedBaseSha) blockers.push(`commit parent ${obs.commitParentSha} != approved base ${obs.approvedBaseSha}`); // the task commit must sit on the approved base
  return { ok: blockers.length === 0, blockers };
}

/** Atomic (tmp + rename) and immutable: an existing handoff is never rewritten. Returns the stamped checksum. */
export function writeHandoff(dir: string, taskId: string, record: Record<string, unknown>): { path: string; handoffHash: string } {
  const handoffHash = canonicalHash(record); const target = join(dir, `${taskId}.handoff.json`);
  if (existsSync(target)) throw new Error(`refusing to overwrite an existing handoff: ${target}`);
  const tmp = join(dir, `.${taskId}.handoff.${process.pid}.tmp`); writeFileSync(tmp, `${JSON.stringify({ ...record, handoffHash }, null, 2)}\n`, "utf8"); renameSync(tmp, target);
  return { path: target, handoffHash };
}
