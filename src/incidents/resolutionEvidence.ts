// R08: resolution evidence — a fix is proven by a run that reproduced the failure, the identity of what changed, a named
// check that now passes, and a scope the change stayed inside. Pure and read-only: the only import is a type, so nothing
// reaches D04 at runtime; no fs, clock, randomness, timer, env or telemetry; it never writes, logs or executes.
// Mapping to D04 (`RecoveryOutcome`): its ordered rules are suppressed > recovered > unresolved > unknown, and
// "recovered" needs only an allowlisted completion record strictly after failureAt — a record that a run finished, not
// that the cause was removed, so a durable `recovered` supports only `recovered_temporarily`, never `root_cause_resolved`
// (D04 says nothing about root causes, and retries never raise a status). Proof must name the check that ran, the
// discipline the harness's own handoff gate uses (a PASS needs proofs whose command matches a manifest command, at the
// right commit, with artifacts present): `passingCheck` carries command + exitCode + artifact, and identities are checked
// by shape the way FAILURE_ID is — text not shaped like an identity is absent, never shortened into something it is not.
import type { RecoveryOutcome } from "./recoveryOutcome.ts";

export const RESOLUTION_SHA: RegExp = /^sha256:[0-9a-f]{64}$/;
export type ResolutionStatus = "recovered_temporarily" | "root_cause_resolved" | "unresolved" | "unknown";
export interface ReproductionEvidence {
  command: string;
  exitCode: number;
  artifact?: string;
}
export interface PassingCheck {
  command: string;
  exitCode: number;
  artifact: string;
}
export interface ResolutionEvidenceInput {
  reproduction?: ReproductionEvidence | null;
  patchIdentity?: string;
  settingIdentity?: string;
  passingCheck?: PassingCheck | null;
  scopeAllowed?: boolean;
  changedFiles?: readonly string[];
  allowedPaths?: readonly string[];
  postFixStatus?: RecoveryOutcome | null;
  retryCount?: number;
  sameCheckSequencePassed?: boolean;
}
export interface ResolutionVerdict {
  status: ResolutionStatus;
  resolved: boolean;
  missing: string[];
  reason: string;
  temporaryBecause: string | null;
}

const TEMPORARY = "postFixStatus.recovered:completion-record-not-removed-cause";
const blank = (v: unknown): boolean => typeof v !== "string" || v.trim() === "";
const shaped = (v: unknown): boolean => typeof v === "string" && RESOLUTION_SHA.test(v);
// an allowed path covers itself and what hangs beneath it; "src/a.ts" never covers "src/a.ts.bak"
const inside = (file: string, allowed: readonly string[]): boolean =>
  allowed.some((p) => !blank(p) && (file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`)));
const out = (
  status: ResolutionStatus,
  reason: string,
  missing: string[] = [],
  temporaryBecause: string | null = null,
): ResolutionVerdict => ({ status, resolved: status === "root_cause_resolved", missing, reason, temporaryBecause });

/** Rules in order: failing reproduction > patch/setting identity by shape > passing check > scope > observed post-fix status; only the same check sequence passing promotes recovered to root_cause_resolved. */
export function classifyResolution(input: ResolutionEvidenceInput): ResolutionVerdict {
  const repro = input?.reproduction ?? null;
  if (repro === null || blank(repro.command) || repro.exitCode === 0)
    return out("unresolved", "reproduction.not.failing", ["failing-reproduction"]);
  const missing: string[] = [];
  if (!shaped(input.patchIdentity)) missing.push("patch-identity");
  if (!shaped(input.settingIdentity)) missing.push("setting-identity");
  const check = input.passingCheck ?? null;
  if (check === null || check.exitCode !== 0 || blank(check.command) || blank(check.artifact))
    missing.push("passing-check");
  const files = Array.isArray(input.changedFiles) ? input.changedFiles : [];
  const allowed = Array.isArray(input.allowedPaths) ? input.allowedPaths : [];
  if (input.scopeAllowed === false || files.some((f) => blank(f) || !inside(f, allowed))) missing.push("scope");
  if (missing.length > 0) return out("unresolved", "requirements.unmet", missing);
  const post = input.postFixStatus ?? "unknown";
  if (post === "unknown") return out("unknown", "postFixStatus.not.observed", ["post-fix-status"]);
  if (post !== "recovered") return out("unresolved", `postFixStatus.${post}`, ["post-fix-status"]);
  const retries =
    Number.isInteger(input.retryCount) && (input.retryCount as number) > 0 ? (input.retryCount as number) : 0;
  if (input.sameCheckSequencePassed === true) return out("root_cause_resolved", "checkSequence.passed.after.fix");
  return out(
    "recovered_temporarily",
    `postFixStatus.recovered:retryCount=${retries}`,
    ["same-check-sequence"],
    TEMPORARY,
  );
}
