/**
 * Intent & policy router (spec 01).
 *
 * Stage A — semantic intent: classify a natural-language request into one or
 * more intents and a suggested workflow class. Deterministic, keyword/signature
 * based so it is testable without a model endpoint.
 *
 * Stage B — deterministic policy enrichment: given runtime facts (files
 * changed, file classes, manifests, security paths), upgrade the workflow class
 * and required gates regardless of the semantic guess.
 *
 * No mandatory workflow depends on a slash command: the router is invoked from
 * normal-language intent by the orchestrator / extension hook.
 */

import { deriveRequiredGates, mutationFactFromChangedFiles, workflowRank } from "./policies.ts";
import type { Intent, IntentResult, RequiredGate, RiskProfile, WorkflowClass } from "./types.ts";

export interface IntentRouterOptions {
  /** Risk classifier override. */
  classifyRisk?: (text: string) => RiskProfile;
}

/** Signature → intent map. Ordered; first match wins per category. */
const INTENT_SIGNATURES: Array<{ intent: Intent; patterns: RegExp[] }> = [
  {
    intent: "implement",
    patterns: [
      /implement/i,
      /\badd\b/i,
      /build (a )?(new |an )?/i,
      /create (a |an |the )?/i,
      /write (a |an |the )?/i,
      /implement google auth/i,
    ],
  },
  {
    intent: "fix",
    patterns: [/\bfix\b/i, /\bbug\b/i, /\berror\b/i, /\bcrash\b/i, /doesn'?t work/i, /\bbreak(s|ing)?\b/i],
  },
  { intent: "modify", patterns: [/\bmodify\b/i, /\bchange\b/i, /\bupdate\b/i, /\badd support for\b/i] },
  {
    intent: "refactor",
    patterns: [/\brefactor\b/i, /\brestructure\b/i, /\breorgani[sz]e\b/i, /\bclean up\b/i, /\bsimplify\b/i],
  },
  { intent: "migrate", patterns: [/\bmigrate\b/i, /\bmigration\b/i, /\bupgrade to\b/i] },
  {
    intent: "investigate",
    patterns: [
      /\bwhy\b/i,
      /\bfind out\b/i,
      /\bdebug\b/i,
      /\bdiagnose\b/i,
      /\btroubleshoot\b/i,
      /\binvestigate\b/i,
      /is failing/i,
      /fails\b/i,
      /\bwhat causes\b/i,
    ],
  },
  {
    intent: "research",
    patterns: [
      /\bfind where\b/i,
      /\bfind how\b/i,
      /\bwhere does\b/i,
      /\bhow does\b/i,
      /\bsearch\b/i,
      /\bexplore\b/i,
      /\blocate\b/i,
      /\bresearch\b/i,
    ],
  },
  { intent: "explain", patterns: [/\bexplain\b/i, /\bwhat is\b/i, /\bdescribe\b/i, /\bwhat does this\b/i] },
  {
    intent: "review",
    patterns: [/\breview\b/i, /\bcheck my changes\b/i, /\bready\?/i, /\bcode review\b/i, /\bassess\b/i],
  },
  {
    intent: "validate",
    patterns: [/\bvalidate\b/i, /\bverify\b/i, /\btest\b/i, /\bcheck\b/i, /\bpass\?/i, /\brun tests\b/i, /\bready\?/i],
  },
  { intent: "release", patterns: [/\brelease\b/i, /\bship\b/i, /\bdeploy\b/i, /\bpublish\b/i, /\bcut a release\b/i] },
  {
    intent: "security-review",
    patterns: [
      /\bsecurity review\b/i,
      /\bsecurity audit\b/i,
      /\bpermissions\b/i,
      /\bsecret\b/i,
      /\binjection\b/i,
      /\bCVE\b/i,
      /\bcryptography\b/i,
    ],
  },
];

/** Risk keywords that hint at higher risk (spec 01 risk_hints). */
const RISK_HINTS: Array<{ hint: string; pattern: RegExp }> = [
  { hint: "auth", pattern: /auth|login|oauth|session|credential|password/i },
  { hint: "security", pattern: /security|permission|secret|token|crypto|encryption/i },
  { hint: "database", pattern: /database|schema|migration|sql|persist/i },
  { hint: "network", pattern: /network|http|endpoint|api|exposure|remote/i },
  { hint: "dependency", pattern: /dependency|package|library|upgrade version|lockfile/i },
];

/** Default risk classifier (deterministic heuristic). */
export function classifyRiskDefault(text: string): RiskProfile {
  const hints = RISK_HINTS.filter((h) => h.pattern.test(text));
  const count = hints.length;
  if (/\bsecurity\b/i.test(text) && /\bauth|login|oauth|credential/i.test(text)) return "critical";
  // Auth/credential-sensitive change with an explicit credential signal.
  if (
    /\b(login|oauth|credential|password)\b/i.test(text) &&
    /\b(auth|login|oauth|credential|password|token)\b/i.test(text)
  ) {
    return "critical";
  }
  if (count >= 3) return "high";
  if (count === 2) return "medium";
  if (count === 1) return "medium";
  if (/\brefactor|migrate|release|deploy\b/i.test(text)) return "medium";
  return "low";
}

/** Semantic intent classification (Stage A). */
export function classifyIntent(text: string): { intent: Intent[]; confidence: number } {
  const found: Intent[] = [];
  for (const sig of INTENT_SIGNATURES) {
    if (sig.patterns.some((p) => p.test(text)) && !found.includes(sig.intent)) {
      found.push(sig.intent);
    }
  }
  const confidence = found.length > 0 ? Math.min(0.99, 0.55 + found.length * 0.14) : 0.2;
  return { intent: found, confidence };
}

/** Map a set of intents to a suggested workflow class (Stage A). */
export function workflowForIntent(intents: Intent[]): WorkflowClass {
  if (intents.includes("security-review")) return "security_sensitive";
  if (intents.includes("release")) return "engineering_review";
  if (
    intents.includes("implement") ||
    intents.includes("modify") ||
    intents.includes("fix") ||
    intents.includes("refactor") ||
    intents.includes("migrate")
  ) {
    return "engineering_review";
  }
  if (intents.includes("review")) return "review";
  if (intents.includes("validate")) return "review";
  if (intents.includes("investigate")) return "investigation";
  if (intents.includes("research")) return "research";
  if (intents.includes("explain")) return "conversation";
  return "conversation";
}

/** Whether a workflow class requires repository mutation capability. */
export function workflowMutatesRepo(w: WorkflowClass): boolean {
  return (
    w === "engineering" ||
    w === "engineering_review" ||
    w === "incident_fix" ||
    w === "refactor" ||
    w === "migration" ||
    w === "security_sensitive"
  );
}

export interface RouteInput {
  request: string;
  /** Files changed by the user/agent so far (empty at mission creation). */
  changedFiles?: string[];
  /** True when the request is a mutation request regardless of semantic guess. */
  mutationRequested?: boolean;
}

export class IntentRouter {
  private readonly classifyRisk: (text: string) => RiskProfile;

  constructor(opts: IntentRouterOptions = {}) {
    this.classifyRisk = opts.classifyRisk ?? classifyRiskDefault;
  }

  /** Full routing: Stage A semantic + Stage B deterministic policy. */
  route(input: RouteInput): IntentResult {
    const { intent, confidence } = classifyIntent(input.request);
    const semanticWorkflow = workflowForIntent(intent);
    const riskHints = RISK_HINTS.filter((h) => h.pattern.test(input.request)).map((h) => h.hint);
    const needsScout = riskHints.length > 0 || workflowRank(semanticWorkflow) >= workflowRank("engineering_review");

    let workflow: WorkflowClass = semanticWorkflow;
    const reasons: string[] = [`semantic intent: ${intent.join(",") || "none"} -> ${workflow}`];
    let escalated = false;

    // Stage B: if there is a mutation fact, policy may upgrade gates + workflow.
    const files = input.changedFiles ?? [];
    if (files.length > 0 || input.mutationRequested) {
      const fact = mutationFactFromChangedFiles(files);
      // A mutation request is itself a source mutation even before files exist.
      if (input.mutationRequested && files.length === 0) fact.changedFiles = [input.request];
      const { upgradedWorkflow, reasons: policyReasons } = deriveRequiredGates(fact);
      if (upgradedWorkflow && workflowRank(upgradedWorkflow) > workflowRank(workflow)) {
        escalated = true;
        workflow = upgradedWorkflow;
        reasons.push(`policy upgraded to ${upgradedWorkflow}: ${policyReasons.join("; ")}`);
      } else {
        reasons.push(...policyReasons);
      }
    }

    // A request that clearly mutates should never stay a pure investigation/research.
    if (
      input.mutationRequested &&
      (workflow === "investigation" || workflow === "research" || workflow === "conversation")
    ) {
      workflow = "engineering_review";
      escalated = true;
      reasons.push("mutation requested -> engineering_review");
    }

    return {
      intent,
      confidence,
      suggested_workflow: workflow,
      risk_hints: riskHints,
      needs_scout: needsScout,
      escalated,
      reasons,
    };
  }

  risk(input: RouteInput): RiskProfile {
    return this.classifyRisk(input.request);
  }
}
