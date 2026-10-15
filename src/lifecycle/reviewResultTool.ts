/**
 * Structured review output contract (spec §14).
 *
 * Reviewers must return a machine-checkable verdict. Bounds are enforced in the
 * schema so a reviewer cannot overflow the harness, and the harness treats a
 * missing/invalid verdict as a failed review rather than an approval.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { FindingSeverity, ReviewFinding, ReviewReport, SpecGap, WorkCategory } from "./types.ts";

const SEVERITIES = ["blocker", "critical", "high", "medium", "low", "info"] as const;

/**
 * llama.cpp compiles the tool schema into a GBNF grammar and rejects the whole
 * request ("Failed to initialize samplers: failed to parse grammar") for what
 * it cannot express. The schema below is therefore deliberately flat: plain
 * string enums (no anyOf/const), no length/count/range bounds, no pattern or
 * format, few optional properties. The bounds live in `execute`, which caps
 * every field, so the harness stays protected without the grammar paying for it.
 */
const stringEnum = <T extends string>(values: readonly T[]) => Type.Unsafe<T>({ type: "string", enum: [...values] });

const severitySchema = stringEnum(SEVERITIES);

const findingSchema = Type.Object({
  severity: severitySchema,
  title: Type.String(),
  detail: Type.String(),
  file: Type.Optional(Type.String()),
  line: Type.Optional(Type.Number()),
  suggestion: Type.Optional(Type.String()),
});

const missingTestSchema = Type.Object({
  description: Type.String(),
  severity: severitySchema,
});

const specGapSchema = Type.Object({
  requirement: Type.String(),
  status: stringEnum(["missing", "partial", "divergent", "unverifiable"] as const),
  detail: Type.String(),
  severity: severitySchema,
});

const acceptanceResultSchema = Type.Object({
  acceptance_id: Type.String(),
  status: stringEnum(["passed", "failed"] as const),
  detail: Type.String(),
});

export const reviewResultTool = defineTool({
  name: "review_result",
  label: "Review Result",
  description:
    "Return your final review verdict as structured data. Use this as your LAST action. A verdict of approve means you found no blocking defect.",
  promptSnippet: "Emit the final review verdict (findings, missing tests, spec gaps) and stop",
  promptGuidelines: [
    "Call review_result exactly once, as your final action.",
    "Report only defects you can point to in the diff or the code; never invent file paths.",
    "Use severity blocker or critical only for breakage, security, data loss, or a spec requirement that is unmet.",
  ],
  parameters: Type.Object({
    verdict: stringEnum(["approve", "request_changes"] as const),
    summary: Type.String(),
    confidence: Type.Optional(Type.Number()),
    findings: Type.Array(findingSchema),
    missing_tests: Type.Array(missingTestSchema),
    spec_gaps: Type.Array(specGapSchema),
    acceptance_results: Type.Array(acceptanceResultSchema),
  }),

  async execute(_toolCallId, params) {
    const cap = (s: unknown, n: number): string => {
      const str = String(s ?? "");
      return str.length > n ? `${str.slice(0, n)}…` : str;
    };
    const findings: ReviewFinding[] = (params.findings ?? []).slice(0, 40).map((f) => ({
      fingerprint: fingerprint({
        severity: f.severity,
        file: f.file,
        title: f.title,
      }),
      role: "",
      severity: (SEVERITIES as readonly string[]).includes(f.severity) ? (f.severity as FindingSeverity) : "medium",
      file: f.file ? cap(f.file, 500) : undefined,
      line: typeof f.line === "number" ? f.line : undefined,
      title: cap(f.title, 300),
      detail: cap(f.detail, 3000),
      confidence: 0.6,
      suggestion: f.suggestion ? cap(f.suggestion, 2000) : undefined,
      categories: [] as WorkCategory[],
    }));
    const missingTests = (params.missing_tests ?? []).slice(0, 20).map((m) => ({
      description: cap(m.description, 1000),
      severity: (SEVERITIES as readonly string[]).includes(m.severity) ? m.severity : "medium",
    }));
    const specGaps: SpecGap[] = (params.spec_gaps ?? []).slice(0, 20).map((g) => ({
      requirement: cap(g.requirement, 1000),
      status: g.status,
      detail: cap(g.detail, 2000),
      severity: (SEVERITIES as readonly string[]).includes(g.severity) ? g.severity : "medium",
    }));
    const summary = cap(params.summary, 4000);
    const verdict = params.verdict === "approve" ? "approve" : "request_changes";
    return {
      content: [{ type: "text" as const, text: `Review recorded: ${verdict} (${findings.length} findings)` }],
      details: {
        verdict,
        findings,
        missingTests,
        specGaps,
        acceptanceResults: (params.acceptance_results ?? []).slice(0, 100).map((result) => ({
          acceptanceId: cap(result.acceptance_id, 200),
          status: result.status,
          detail: cap(result.detail, 2000),
        })),
        confidence: typeof params.confidence === "number" ? Math.max(0, Math.min(1, params.confidence)) : undefined,
        summary,
      },
      terminate: true,
    };
  },
});

/** A normalized verdict payload as returned by the tool. */
export interface ReviewVerdictPayload {
  verdict: "approve" | "request_changes";
  summary: string;
  confidence?: number;
  findings: ReviewFinding[];
  missingTests: MissingTestPayload[];
  specGaps: SpecGap[];
  acceptanceResults?: Array<{ acceptanceId: string; status: "passed" | "failed"; detail: string }>;
}

export interface MissingTestPayload {
  description: string;
  file?: string;
  severity: FindingSeverity;
}

/** Stable identity for a finding so repeat reviews deduplicate instead of re-remediating. */
export function fingerprint(input: { severity?: string; file?: string; title: string }): string {
  const normalized = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 160);
  const file = (input.file ?? "").replace(/^\.\//, "").toLowerCase();
  return `${input.severity ?? "medium"}|${file}|${normalized}`;
}

/** Fold a tool payload plus execution metadata into a ReviewReport. */
export function toReviewReport(args: {
  role: string;
  model: ReviewReport["model"];
  round: number;
  durationMs: number;
  payload: ReviewVerdictPayload | undefined;
  artifactUri?: string;
  error?: string;
}): ReviewReport {
  const { payload } = args;
  if (!payload) {
    return {
      role: args.role,
      model: args.model,
      round: args.round,
      verdict: "failed",
      findings: [],
      missingTests: [],
      specGaps: [],
      confidence: 0,
      summary: args.error ?? "Reviewer returned no review_result; the review did not happen.",
      at: new Date().toISOString(),
      durationMs: args.durationMs,
      artifactUri: args.artifactUri,
      error: args.error ?? "no-result",
    };
  }
  return {
    role: args.role,
    model: args.model,
    round: args.round,
    verdict: payload.verdict,
    findings: payload.findings.map((f) => ({ ...f, role: args.role })),
    missingTests: payload.missingTests,
    specGaps: payload.specGaps,
    confidence: payload.confidence ?? 0.6,
    summary: payload.summary,
    at: new Date().toISOString(),
    durationMs: args.durationMs,
    artifactUri: args.artifactUri,
  };
}
