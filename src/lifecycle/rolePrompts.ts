/**
 * Role prompts for the engineering lifecycle (spec §11, §14, §16, §18).
 *
 * Every role runs in a fresh session with a narrow system prompt and a bounded
 * kickoff: the harness passes a compact brief plus artifact references, never a
 * transcript. Reviewers are told explicitly that they did not write the change
 * and that an empty finding list is a legitimate outcome.
 */

import type { RoleName } from "../capability/roles.ts";
import type { ChangeSnapshot, ReviewReport, VerificationReport } from "./types.ts";

const COMMON = [
  "You are one role inside an automated engineering harness. Other roles cover the rest.",
  "Report only what you can support from the repository, the diff, or command output you actually ran.",
  "Never invent a file path, line number, command result, or CVE.",
  "Prefer few high-confidence findings over many speculative ones. Reporting nothing is a valid outcome.",
  "Do not modify files unless your role explicitly grants write access.",
].join(" ");

const ROLE_BRIEFS: Record<RoleName, string> = {
  orchestrator:
    "You coordinate work: decompose the request, keep scope tight, and hand off. You do not declare completion — the harness gate does.",
  planner:
    "Produce an implementation plan: target behaviour, files to touch, risks, verification strategy, and the smallest reversible sequence. Do not write code.",
  implementer:
    "Implement the requested change with the smallest coherent diff. Follow existing conventions, keep public behaviour intact where unspecified, and update or add tests when behaviour changes.",
  reviewer:
    "You did NOT write this change. Review the diff for correctness, regressions, missing edge cases, broken invariants, and unclear intent. Judge the change, not the author.",
  test_reviewer:
    "You did NOT write these tests. Judge whether the tests actually exercise the changed behaviour, whether assertions are meaningful, and whether obvious cases are untested. Flag assertion-loosening (a test weakened to pass).",
  verifier:
    "Run the declared verification commands and report exactly what happened. Never describe a command you did not run as passing.",
  security_reviewer:
    "You did NOT write this change. Look for injection (SQL/command/prompt), secrets or credentials in code, logs or diffs, unsafe deserialization, SSRF, path traversal, permission or authz changes, and supply-chain risk. Cite the exact line.",
  architecture_reviewer:
    "You did NOT write this change. Check architectural fit: layering violations, coupling, duplicated ownership of a decision, interface erosion, and whether the design matches the documented architecture.",
  database_reviewer:
    "You did NOT write this change. Check schema/migration correctness, data loss risk, lock duration, backfill safety, index/query cost, transactionality, and whether the migration is reversible or explicitly irreversible.",
  api_reviewer:
    "You did NOT write this change. Check contract compatibility (request/response/validation), status codes, error shapes, idempotency, pagination, auth enforcement, and versioning/deprecation of the public API.",
  performance_reviewer:
    "You did NOT write this change. Look for added latency on hot paths, N+1 access, unbounded memory growth, missing pagination or limits, and synchronisation bottlenecks. Quantify when you can.",
  infrastructure_reviewer:
    "You did NOT write this change. Review IaC, CI, container and deployment changes for blast radius, secret handling, drift, missing rollback, network exposure, and service-lifecycle correctness. Legitimate remote administration is expected; flag risk, not capability.",
  vision_reviewer:
    "You did NOT produce these images. Describe what is actually visible, then judge the rendered result: layout, alignment, legibility, contrast, states (empty/loading/error), and whether the visible result matches the stated intent.",
  ui_reviewer:
    "You did NOT produce this UI. Judge interaction correctness, focus and keyboard behaviour, accessibility semantics, responsive layout, and consistency with the existing design system. Use the supplied screenshots plus the source.",
  spec_verifier:
    "You verify implementation against the specification, not against the implementer's summary. Quote each requirement, then mark it satisfied, partial, missing, divergent, or unverifiable with the file and symbol that proves it.",
  documentation_reviewer:
    "You did NOT write this documentation. Check that docs match the code as it now is, that examples actually run, and that stale instructions were updated or removed.",
};

/** System prompt for a lifecycle role. */
export function buildRolePrompt(role: RoleName): string {
  return `${ROLE_BRIEFS[role]} ${COMMON}`;
}

export interface KickoffInput {
  role: RoleName;
  request: string;
  snapshot?: ChangeSnapshot;
  checks?: VerificationReport[];
  priorFindings?: ReviewReport[];
  specExcerpt?: string;
  specPath?: string;
  round: number;
  imageCount?: number;
  extra?: string;
}

function compactSnapshot(snapshot: ChangeSnapshot): string {
  const lines = snapshot.files
    .slice(0, 60)
    .map(
      (f) =>
        `${f.scope === "untracked" ? "?" : f.deleted ? "D" : f.added ? "A" : "M"} ${f.path} +${f.linesAdded}/-${f.linesDeleted}`,
    );
  const more = snapshot.files.length > 60 ? `\n… ${snapshot.files.length - 60} more files` : "";
  return [
    `Base ${snapshot.baseRef.slice(0, 12)} → HEAD ${snapshot.headCommit.slice(0, 12)} (${snapshot.headRef})`,
    `Files (${snapshot.files.length}):`,
    ...lines,
    more,
    snapshot.truncated ? `(diff excerpt truncated from ${snapshot.diffChars} chars)` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build the opening message for a role session. */
export function buildRoleKickoff(input: KickoffInput): string {
  const parts: string[] = [];
  parts.push(`## Request\n${input.request.trim()}`);
  if (input.snapshot) parts.push(`## Change in progress (round ${input.round})\n${compactSnapshot(input.snapshot)}`);
  if (input.checks?.length) {
    parts.push(
      `## Verification so far\n${input.checks
        .map(
          (c) =>
            `${c.stage} round ${c.round}: ${c.status}${c.blocking.length ? ` — ${c.blocking.join("; ")}` : ""}\n${c.outcomes
              .map((o) => `  - ${o.spec.name}: ${o.status}${o.artifactUri ? ` (${o.artifactUri})` : ""}`)
              .join("\n")}`,
        )
        .join("\n")}`,
    );
  }
  if (input.priorFindings?.length) {
    parts.push(
      `## Findings already reported\n${input.priorFindings
        .flatMap((r) =>
          r.findings.map((f) => `- [${f.severity}] ${f.file ?? "general"}: ${f.title} (${f.fingerprint})`),
        )
        .join(
          "\n",
        )}\nDo not repeat a finding whose fingerprint is listed unless it is still present and materially different.`,
    );
  }
  if (input.specExcerpt) {
    parts.push(`## Specification${input.specPath ? ` (${input.specPath})` : ""}\n${input.specExcerpt}`);
  }
  if (input.imageCount) {
    parts.push(
      `## Images\n${input.imageCount} image(s) are attached to this message. Base every visual claim on what is actually visible in them.`,
    );
  }
  if (input.extra) parts.push(input.extra);
  parts.push(
    input.role === "implementer" || input.role === "planner" || input.role === "orchestrator"
      ? "Do the work now. Finish with worker_result containing your bounded structured result."
      : "Review now. Finish with review_result containing your verdict, findings, missing tests and spec gaps.",
  );
  return parts.join("\n\n");
}

/** Remediation brief injected when the harness gate is not satisfied (spec §19). */
export function buildRemediationBrief(args: {
  round: number;
  reports: ReviewReport[];
  verification?: VerificationReport;
  gateBlockers: string[];
}): string {
  const { round, reports, verification, gateBlockers } = args;
  const lines: string[] = [];
  lines.push(`[harness] Automatic engineering gate — round ${round}`);
  lines.push(
    "The work is not complete yet. These items are blocking completion; the harness owns the completion decision, so a summary claiming success will not close the gate.",
  );
  if (gateBlockers.length) {
    lines.push(`\nGate blockers:\n${gateBlockers.map((b) => `- ${b}`).join("\n")}`);
  }
  for (const report of reports) {
    const blocking = report.findings.filter(
      (f) => f.severity === "blocker" || f.severity === "critical" || f.severity === "high",
    );
    if (!blocking.length && !report.missingTests.length && !report.specGaps.length) continue;
    lines.push(`\n${report.role} (${report.model.provider}/${report.model.id}) — ${report.verdict}`);
    for (const f of blocking) {
      lines.push(`- [${f.severity}] ${f.file ?? "general"}${f.line ? `:${f.line}` : ""} ${f.title}`);
      lines.push(`  ${f.detail}`);
      if (f.suggestion) lines.push(`  Fix: ${f.suggestion}`);
      lines.push(`  fingerprint: ${f.fingerprint}`);
    }
    for (const m of report.missingTests.filter((t) => t.severity !== "info")) {
      lines.push(`- [missing test/${m.severity}] ${m.file ?? ""} ${m.description}`);
    }
    for (const g of report.specGaps) {
      lines.push(`- [spec/${g.status}/${g.severity}] ${g.requirement} — ${g.detail}`);
    }
  }
  if (verification && verification.status !== "passed") {
    lines.push(`\nVerification ${verification.status}:`);
    for (const o of verification.outcomes) {
      if (o.status === "passed") continue;
      lines.push(`- ${o.spec.name}: ${o.status} — ${o.summary.split("\n")[0]}`);
    }
  }
  lines.push(
    "\nFix the items above in this session. If an item is a false positive, say so explicitly and explain the evidence; the harness re-verifies and re-reviews when you finish.",
  );
  return lines.join("\n");
}

/** Human-facing completion report produced by the harness, not the model (§21). */
export function buildCompletionReport(args: {
  state: string;
  pass: boolean;
  gateBlockers: string[];
  rounds: number;
  files: number;
  reports: ReviewReport[];
  verification?: VerificationReport;
  models: string[];
}): string {
  const { state, pass, gateBlockers, rounds, files, reports, verification, models } = args;
  const lines: string[] = [];
  lines.push(`[harness] Engineering lifecycle ${pass ? "COMPLETE" : state.toLowerCase()} after ${rounds} round(s)`);
  if (!pass) lines.push(`Blocking: ${gateBlockers.join("; ") || "unresolved gate conditions"}`);
  lines.push(
    `Reviewers: ${reports.length ? reports.map((r) => `${r.role}(${r.model.provider}/${r.model.id})=${r.verdict}`).join(", ") : "none required"}`,
  );
  lines.push(
    `Verification: ${verification ? `${verification.status} (${verification.outcomes.map((o) => `${o.spec.name}=${o.status}`).join(", ") || "no commands"})` : "not run"}`,
  );
  lines.push(`Changes: ${files} file(s). Models used: ${[...new Set(models)].join(", ") || "session model"}.`);
  return lines.join("\n");
}
