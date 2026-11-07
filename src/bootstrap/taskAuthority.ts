/**
 * T01: canonical original-task authority — the operator-authored goal/scope/nonGoals/tests hashed in a canonical
 * form of their own, apart from any generated planner contract, so a model cannot move the identity of the task it
 * was given. Pure and deterministic: no fs, no network, no clock, no RNG, no mutation of inputs. Hashing reuses the
 * protocol canonicalizer in resultGate.ts; there is deliberately no second implementation to drift from.
 */
import { canonicalHash } from "./resultGate.ts";
export const AUTHORITY_KIND = "operator-task/v1"; export const PLANNER_KIND = "planner-contract/v1";
const FIELDS = ["goal", "scope", "nonGoals", "tests"] as const; const LIST_FIELDS = ["scope", "nonGoals", "tests"] as const;
export type AuthorityField = (typeof FIELDS)[number];
export interface OperatorTaskSource { goal: string; scope: readonly string[]; nonGoals: readonly string[]; tests: readonly string[]; origin?: string }
export interface CanonicalTask { kind: string; goal: string; scope: string[]; nonGoals: string[]; tests: string[] }
export interface PlannerContract { plan: string; tasks: readonly string[]; restatement?: Record<string, unknown> }
export type TaskAuthorityResult = { ok: true; authorityHash: string; canonical: CanonicalTask } | { ok: false; reasons: string[] };
export interface AuthorityVerification { ok: boolean; authorityHash: string | null; diverged: AuthorityField[]; reasons: string[] }
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((s, i) => s === b[i]);
// Trim, drop empty strings, collapse duplicates keeping the first occurrence, preserve authored order (a scope list
// is a contract, not a set). Non-string members and non-arrays are reported, never coerced or silently dropped.
function cleanList(value: unknown): { values: string[]; bad: string[] } {
  if (!Array.isArray(value)) return { values: [], bad: ["expected an array of strings"] };
  const values: string[] = []; const bad: string[] = [];
  value.forEach((member, i) => { if (typeof member !== "string") bad.push(`member ${i} is not a string`); else { const s = member.trim(); if (s !== "" && !values.includes(s)) values.push(s); } });
  return { values, bad };
}
/** Authority over the operator's words only; a source declaring other origin (e.g. "planner") is refused — a model may not overwrite the task by supplying its own copy. */
export function deriveTaskAuthority(source: unknown): TaskAuthorityResult {
  if (!isRecord(source)) return { ok: false, reasons: ["source: expected an operator-authored task object"] };
  const reasons: string[] = [];
  if (source.origin !== undefined && source.origin !== "operator") reasons.push(`origin: ${typeof source.origin === "string" && source.origin !== "" ? source.origin : typeof source.origin}-authored content cannot define task authority, expected "operator"`);
  const goal = typeof source.goal === "string" ? source.goal.trim() : "";
  if (typeof source.goal !== "string") reasons.push("goal: expected a string"); else if (goal === "") reasons.push("goal: empty after trimming");
  const lists = {} as Record<(typeof LIST_FIELDS)[number], string[]>;
  for (const field of LIST_FIELDS) { const cleaned = cleanList(source[field]); for (const reason of cleaned.bad) reasons.push(`${field}: ${reason}`);
    if (cleaned.values.length === 0 && cleaned.bad.length === 0) reasons.push(`${field}: empty after canonicalization`); lists[field] = cleaned.values; }
  if (reasons.length > 0) return { ok: false, reasons }; // no placeholder is ever invented for a missing operator field
  const canonical: CanonicalTask = { kind: AUTHORITY_KIND, goal, scope: lists.scope, nonGoals: lists.nonGoals, tests: lists.tests };
  return { ok: true, authorityHash: canonicalHash(canonical), canonical };
}
/** The generated planner artifact hashes over its own canonical form, so identical words give a different digest; its restatement is recorded, never dropped. */
export function derivePlannerContractHash(contract: PlannerContract): string {
  return canonicalHash({ kind: PLANNER_KIND, plan: contract.plan.trim(), tasks: contract.tasks.map((t) => t.trim()).filter((t) => t !== ""), restatement: contract.restatement ?? null });
}
/** Recompute authority from the frozen operator source ONLY. Planner output is read to name `diverged` drift — a field stated at its top level, or else under `plannerOutput.restatement` (this module's own PlannerContract shape) — and is never substituted, so a planner edit — however it restates goal/scope/nonGoals/tests — cannot move the hash, and divergence is never a re-authorization. */
export function verifyAuthority(authorityHash: string, candidate: { source: unknown; plannerOutput?: unknown }): AuthorityVerification {
  const derived = deriveTaskAuthority(candidate.source);
  if (!derived.ok) return { ok: false, authorityHash: null, diverged: [], reasons: derived.reasons };
  const planner = isRecord(candidate.plannerOutput) ? candidate.plannerOutput : {}; const nested = isRecord(planner.restatement) ? planner.restatement : {}; const diverged: AuthorityField[] = [];
  for (const field of FIELDS) { const holder = field in planner ? planner : nested; if (!(field in holder)) continue; const restated = holder[field]; // top-level restatement wins; a PlannerContract's nested restatement is the fallback holder
    if (field === "goal") { if (typeof restated !== "string" || restated.trim() !== derived.canonical.goal) diverged.push(field); }
    else { const cleaned = cleanList(restated); if (cleaned.bad.length > 0 || !sameList(cleaned.values, derived.canonical[field])) diverged.push(field); } }
  const ok = derived.authorityHash === authorityHash;
  return { ok, authorityHash: derived.authorityHash, diverged, reasons: ok ? [] : [`authority mismatch: recomputed ${derived.authorityHash} != recorded ${authorityHash}`] };
}
