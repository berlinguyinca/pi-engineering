/**
 * Convergence verification evidence (spec §31, issue #307).
 *
 * A pure, testable decision function that surfaces divergences between the
 * locally observed verification evidence and the CI evidence that a release
 * gate consumed: a local `npm test` pass, the GitHub `verify` check and the
 * roadmap release gate can disagree (red CI with green local, stale evidence
 * commit, gate blocked while CI is green) without anything surfacing the
 * divergence.
 *
 * The function performs no I/O and never mutates its input: it returns a
 * {@link VerificationEvidence} describing whether local, CI and release-gate
 * evidence are consistent, divergent or incomplete. All applicable reasons
 * and divergences are collected in a fixed order.
 */
import type { ReleaseGateResult } from "../roadmap/types.ts";
import type { CheckRun } from "./mergeGate.ts";

export interface LocalRun {
  name: string;
  status: "pass" | "fail";
  sha: string;
}

export type DivergenceKind =
  | "local-pass-ci-fail"
  | "local-fail-ci-pass"
  | "gate-blocked"
  | "gate-pass-ci-fail"
  | "stale-evidence";

export interface Divergence {
  kind: DivergenceKind;
  name: string;
  detail: string;
}

export interface VerificationEvidenceInput {
  sha: string;
  local: readonly LocalRun[];
  ci: readonly CheckRun[];
  requiredChecks: readonly string[];
  releaseGate?: ReleaseGateResult;
  evidenceCommit?: string;
}

export interface VerificationSummary {
  required: number;
  localPassed: number;
  ciPassed: number;
  ciMissing: number;
  releaseGate: "pass" | "blocked" | "absent";
}

export interface VerificationEvidence {
  status: "consistent" | "divergent" | "incomplete";
  reasons: string[];
  divergences: Divergence[];
  summary: VerificationSummary;
}

/** The last CI entry with the given name and the input sha (else undefined). */
function ciAt(name: string, input: VerificationEvidenceInput): CheckRun | undefined {
  let found: CheckRun | undefined;
  for (const run of input.ci) {
    if (run.name === name && run.sha === input.sha) {
      found = run;
    }
  }
  return found;
}

/** The first CI entry with the given name and a sha different from the input sha. */
function ciOther(name: string, input: VerificationEvidenceInput): CheckRun | undefined {
  return input.ci.find((run) => run.name === name && run.sha !== input.sha);
}

/** The last local entry with the given name and the input sha (else undefined). */
function localAt(name: string, input: VerificationEvidenceInput): LocalRun | undefined {
  let found: LocalRun | undefined;
  for (const run of input.local) {
    if (run.name === name && run.sha === input.sha) {
      found = run;
    }
  }
  return found;
}

/** The first local entry with the given name and a sha different from the input sha. */
function localOther(name: string, input: VerificationEvidenceInput): LocalRun | undefined {
  return input.local.find((run) => run.name === name && run.sha !== input.sha);
}

export function buildVerificationEvidence(input: VerificationEvidenceInput): VerificationEvidence {
  const reasons: string[] = [];
  const divergences: Divergence[] = [];
  let incomplete = false;
  let ciMissing = 0;
  let ciPassed = 0;
  let localPassed = 0;

  // R0: no required checks configured.
  if (input.requiredChecks.length === 0) {
    reasons.push("no required checks configured");
    incomplete = true;
  }

  // R1: per required check, CI and local evidence.
  for (const n of input.requiredChecks) {
    const at = ciAt(n, input);
    const other = ciOther(n, input);
    if (at === undefined) {
      if (other !== undefined) {
        reasons.push(`CI ${n} is for ${other.sha}, not ${input.sha}`);
        incomplete = true;
        ciMissing++;
      } else {
        reasons.push(`CI ${n} missing`);
        incomplete = true;
        ciMissing++;
      }
    } else if (at.status === "pending") {
      reasons.push(`CI ${n} pending`);
      incomplete = true;
    } else if (at.status === "skipped") {
      reasons.push(`CI ${n} skipped`);
      incomplete = true;
    } else if (at.status === "pass") {
      ciPassed++;
    }

    const local = localAt(n, input);
    const localOtherRun = localOther(n, input);
    if (local === undefined) {
      if (localOtherRun !== undefined) {
        reasons.push(`local ${n} is for ${localOtherRun.sha}, not ${input.sha}`);
        incomplete = true;
      } else {
        reasons.push(`local ${n} missing`);
        incomplete = true;
      }
    } else if (local.status === "pass") {
      localPassed++;
    }

    // Cross-check only when both CI and local exist at the input sha and CI is pass/fail.
    if (at !== undefined && local !== undefined && (at.status === "pass" || at.status === "fail")) {
      if (local.status === "pass" && at.status === "fail") {
        const detail = `local ${n} passed but CI ${n} failed`;
        reasons.push(detail);
        divergences.push({ kind: "local-pass-ci-fail", name: n, detail });
      } else if (local.status === "fail" && at.status === "pass") {
        const detail = `local ${n} failed but CI ${n} passed`;
        reasons.push(detail);
        divergences.push({ kind: "local-fail-ci-pass", name: n, detail });
      }
    }
  }

  // R2: release gate.
  if (input.releaseGate === undefined) {
    // absent: no reason, not incomplete.
  } else if (input.releaseGate.pass === false) {
    const gateReasons: string[] =
      input.releaseGate.blockers.length > 0
        ? input.releaseGate.blockers.map((b) => `release gate blocked: ${b}`)
        : ["release gate blocked: unspecified"];
    reasons.push(...gateReasons);
    // Divergence only if every required check has a passing CI at the input sha.
    const allCiPass = input.requiredChecks.every((n) => ciAt(n, input)?.status === "pass");
    if (input.requiredChecks.length > 0 && allCiPass) {
      divergences.push({ kind: "gate-blocked", name: "release-gate", detail: gateReasons[0] ?? "" });
    }
    // (releaseGate summary updated below)
  } else {
    // pass === true
    for (const n of input.requiredChecks) {
      const at = ciAt(n, input);
      if (at?.status === "fail") {
        const detail = `release gate passed but CI ${n} failed`;
        reasons.push(detail);
        divergences.push({ kind: "gate-pass-ci-fail", name: n, detail });
      }
    }
  }
  const effectiveReleaseGate: VerificationSummary["releaseGate"] =
    input.releaseGate === undefined ? "absent" : input.releaseGate.pass === false ? "blocked" : "pass";

  // R3: stale evidence commit (checked whether or not the release gate is present).
  if (input.evidenceCommit !== undefined && input.evidenceCommit !== input.sha) {
    const detail = `release gate evidence commit ${input.evidenceCommit} is stale for ${input.sha}`;
    reasons.push(detail);
    divergences.push({ kind: "stale-evidence", name: "release-gate", detail });
  }

  const status: VerificationEvidence["status"] =
    divergences.length > 0 ? "divergent" : incomplete ? "incomplete" : "consistent";

  return {
    status,
    reasons,
    divergences,
    summary: {
      required: input.requiredChecks.length,
      localPassed,
      ciPassed,
      ciMissing,
      releaseGate: effectiveReleaseGate,
    },
  };
}
