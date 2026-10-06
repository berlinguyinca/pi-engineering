/**
 * Mission auto-invoke decision (spec 06).
 *
 * The extension injects a directive telling the model to delegate engineering
 * requests to the `mission` tool. Injecting it for the wrong prompt is costly:
 * a bare "retry" re-launched a mission, a question became a mission, a
 * headless `--print` run was told to call a tool that could not start, and a
 * session whose mission tool had already answered "not initialized" kept being
 * told to call it. This decides, deterministically, whether to inject.
 */

import { classifyIntent, workflowForIntent } from "./intentRouter.ts";
import type { WorkflowClass } from "./types.ts";

// Ordered from passive (conversation/research) to fully-enforced. Anything
// at/above `engineering` (incl. `review` and `security_sensitive`) auto-invokes.
const WORKFLOW_ORDER: WorkflowClass[] = [
  "conversation",
  "research",
  "investigation",
  "engineering",
  "review",
  "engineering_review",
  "security_sensitive",
];
const workflowRank = (w: WorkflowClass): number => WORKFLOW_ORDER.indexOf(w);

/** Minimum classifier confidence for injecting the directive. */
export const AUTO_INVOKE_MIN_CONFIDENCE = 0.6;
/** Prompts with fewer words than this are treated as chat, not a mission request. */
export const AUTO_INVOKE_MIN_WORDS = 4;
/** Re-submits of the same prompt within this window are harness retries. */
const RESUBMIT_WINDOW_MS = 30_000;

const BARE_CONTINUATION =
  /^(?:please\s+)?(?:retry|re-?try|try again|again|continue|go on|go ahead|keep going|carry on|resume|proceed|next|ok(?:ay)?|yes|y|yep|sure|do it|done)[\s.!]*$/i;
/** True for a bare "continue"/"yes"/"retry" nudge that carries no request of its own. */
export function isBareContinuation(prompt: string): boolean {
  return BARE_CONTINUATION.test(prompt.trim());
}
const CHAT_OPENER = /^(?:hi|hello|hey|thanks|thank you|thx|cool|nice|great|lol)\b/i;

export interface AutoInvokeInput {
  prompt: string;
  /** Pi run mode (`print` for `pi -p`). */
  mode?: string;
  /** The mission tool already reported unavailable/not initialized in this session. */
  missionToolUnavailable: boolean;
  lastAutoInvoked: { prompt: string; at: number } | null;
  now: number;
  minConfidence?: number;
}

export interface AutoInvokeDecision {
  invoke: boolean;
  workflow: WorkflowClass;
  confidence: number;
  reason: string;
}

export function decideAutoInvoke(input: AutoInvokeInput): AutoInvokeDecision {
  const prompt = input.prompt.trim();
  const skip = (reason: string, workflow: WorkflowClass = "conversation", confidence = 0): AutoInvokeDecision => ({
    invoke: false,
    workflow,
    confidence,
    reason,
  });
  if (!prompt) return skip("empty prompt");
  if (/^\/\w/.test(prompt)) return skip("slash command routes explicitly");
  if (input.mode === "print") return skip("print mode is headless; no mission directive");
  if (input.missionToolUnavailable) return skip("mission tool already reported unavailable in this session");
  if (
    input.lastAutoInvoked &&
    input.lastAutoInvoked.prompt === prompt &&
    input.now - input.lastAutoInvoked.at < RESUBMIT_WINDOW_MS
  ) {
    return skip("harness re-submit of the same prompt");
  }
  if (BARE_CONTINUATION.test(prompt)) return skip("bare retry/continue prompt");
  if (/\?\s*$/.test(prompt)) return skip("question, not a mission request");
  const words = prompt.split(/\s+/).filter(Boolean).length;
  if (words < AUTO_INVOKE_MIN_WORDS || CHAT_OPENER.test(prompt)) return skip("short or chat-like prompt");

  let classified: { intent: ReturnType<typeof classifyIntent>["intent"]; confidence: number };
  try {
    classified = classifyIntent(prompt);
  } catch {
    return skip("classification failed");
  }
  const workflow = workflowForIntent(classified.intent);
  if (workflowRank(workflow) < workflowRank("engineering")) {
    return skip(`workflow ${workflow} does not need a mission`, workflow, classified.confidence);
  }
  const min = input.minConfidence ?? AUTO_INVOKE_MIN_CONFIDENCE;
  if (classified.confidence < min) {
    return skip(`intent confidence ${classified.confidence.toFixed(2)} below ${min}`, workflow, classified.confidence);
  }
  return { invoke: true, workflow, confidence: classified.confidence, reason: `engineering intent (${workflow})` };
}

/**
 * True when a mission tool result is the tool's own "cannot serve missions
 * here" message (src/tools/coreTools.ts `notInitialized`). Matching only that
 * prefix keeps an ordinary mission report ("validation evidence is
 * unavailable") from switching auto-invoke off for the session.
 */
export function missionToolReportedUnavailable(text: string): boolean {
  return /^(?:Orchestrator|Engineering runtime) not initialized for this directory\b/.test(text.trim());
}
