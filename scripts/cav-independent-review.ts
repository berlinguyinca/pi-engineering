#!/usr/bin/env node
import { resolve } from "node:path";
import { CavEvidenceLedger, applyReviewPromotion, cavPaths, evaluateIndependentReview } from "../src/cav/index.ts";

/**
 * Dispatch a genuine INDEPENDENT review of CAV steps using a DIFFERENT model
 * than the implementer.
 *
 * This runs a fresh-context reviewer session on the model named by
 * CAV_REVIEWER_MODEL (default: qwen3.8-27b), which is distinct from the
 * implementer's model. The reviewer receives ONLY the deterministic evidence
 * for the target step (no implementer rationale) and must reach a verdict on
 * that evidence alone. Promotion to VERIFIED is then applied through the
 * role-gated ledger path.
 *
 * The reviewer is given a bounded, evidence-only brief: it may not waive a
 * deterministic failure, and it must cite the exact evidence records it
 * inspected.
 *
 * Usage:
 *   node --experimental-strip-types scripts/cav-independent-review.ts <step-id> [--visual]
 *   --visual  route to a vision-capable model (qwen3.8-27b-vision) for visual review
 * Env:
 *   CAV_REVIEWER_MODEL  reviewer model id (default qwen3.8-27b; qwen3.8-27b-vision with --visual)
 */
const REPO_ROOT = resolve(import.meta.dirname, "..");

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const stepId = args.find((a) => !a.startsWith("--"));
  if (!stepId) {
    console.error("usage: cav-independent-review.ts <step-id>");
    return 2;
  }
  // Route visual-review tasks to a vision-capable model by default; all other
  // review tasks default to a different, text-capable model than the implementer.
  const isVisual = args.includes("--visual");
  const reviewerModel = process.env.CAV_REVIEWER_MODEL ?? (isVisual ? "qwen3.8-27b-vision" : "qwen3.8-27b");

  const { stepsDir, ledgerFile } = cavPaths(REPO_ROOT);
  const { loadCavSteps } = await import("../src/cav/index.ts");
  const steps = loadCavSteps(stepsDir);
  const step = steps.find((s) => s.id === stepId);
  if (!step) {
    console.error(`unknown CAV step: ${stepId}`);
    return 2;
  }

  const ledger = await CavEvidenceLedger.open(ledgerFile);
  const evidence = ledger.byRequirement(stepId);
  if (evidence.length === 0) {
    console.error(`no evidence recorded for ${stepId}; nothing to review`);
    return 1;
  }
  const latest = ledger.latestEvidence(stepId)!;

  // Evidence-only brief for the reviewer — NO implementer rationale.
  const brief = `You are an INDEPENDENT REVIEWER. A different model (the implementer)
produced the evidence below for CAV requirement ${stepId}.

You must decide whether this requirement may be promoted to VERIFIED based ONLY
on the deterministic evidence. You CANNOT waive a deterministic failure. Missing
evidence or a non-zero exit code means NOT VERIFIED. Your verdict must name the
exact evidence record ids you inspected.

Evidence for ${stepId}:
${evidence
  .map(
    (e) =>
      `- ${e.id}: status=${e.status} role=${e.role} gate=${e.gate_type} exit=${e.exit_code} git=${e.git_sha.slice(0, 8)} cmd="${e.command}"`,
  )
  .join("\n")}

Latest: ${latest.id} status=${latest.status} exit=${latest.exit_code} gate=${latest.gate_type}

Reply with ONLY a JSON object:
{"approved": true|false, "inspected": ["EVID-..."], "reasons": ["..."]}`;

  // Fresh-context reviewer on a DIFFERENT model via Pi's SDK.
  const { ModelRuntime, SessionManager, SettingsManager, createAgentSession, createExtensionRuntime } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const model = runtime.getModel("metabolomics", reviewerModel);
  if (!model) {
    console.error(`reviewer model ${reviewerModel} is not registered`);
    return 2;
  }

  const sessionManager = SessionManager.inMemory(REPO_ROOT);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const { session } = await createAgentSession({
    cwd: REPO_ROOT,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => brief,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    },
    sessionManager,
    settingsManager,
    tools: [],
    customTools: [],
    thinkingLevel: "off",
  });

  const out = await session.prompt("Review the evidence above and return the JSON verdict object only.", {
    expandPromptTemplates: false,
  });
  const rawMessages = (session as unknown as { messages?: unknown[] }).messages ?? [];
  session.dispose();
  if (process.env.CAV_REVIEW_DEBUG) {
    console.error("[debug] prompt return:", JSON.stringify(out)?.slice(0, 500));
    console.error("[debug] message count:", rawMessages.length);
  }

  // Extract text from the session result regardless of return shape.
  let text = "";
  if (typeof out === "string") {
    text = out;
  } else if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    if (typeof o.text === "string") text = o.text;
    else if (typeof o.content === "string") text = o.content;
    else if (typeof o.result === "string") text = o.result;
    else text = JSON.stringify(out);
  }
  // Fall back to scanning session messages for the final assistant text.
  if (!text.trim()) {
    for (const m of rawMessages) {
      const msg = m as { role?: string; content?: unknown };
      if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) {
        text = msg.content;
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{ type?: string; text?: string }>) {
          if (block.type === "text" && block.text) text += block.text;
        }
      }
    }
  }

  // Parse the reviewer's JSON verdict (find the first { ... } block).
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error(`reviewer did not return a JSON verdict. Raw:\n${text.slice(0, 2000)}`);
    return 1;
  }
  let verdict;
  try {
    verdict = JSON.parse(match[0]);
  } catch {
    console.error(`could not parse reviewer verdict: ${match[0].slice(0, 500)}`);
    return 1;
  }

  const reviewVerdict = {
    requirementId: stepId,
    reviewRole: "reviewer",
    approved: verdict.approved === true,
    inspectedEvidence: Array.isArray(verdict.inspected) ? verdict.inspected : [],
    reasons: Array.isArray(verdict.reasons) ? verdict.reasons : [],
  };

  if (!reviewVerdict.approved) {
    console.log(JSON.stringify({ step: stepId, verdict: reviewVerdict, promoted: false }, null, 2));
    return 1;
  }

  // Apply role-gated promotion (reviewer role on a different model).
  await applyReviewPromotion(step, reviewVerdict, {
    ledger,
    reviewRole: "reviewer",
    workerRunId: `review-${reviewerModel}-${Date.now().toString(36)}`,
    gitSha: latest.git_sha,
    assessment: reviewVerdict.reasons.join("; "),
  });
  console.log(JSON.stringify({ step: stepId, reviewerModel, verdict: reviewVerdict, promoted: true }, null, 2));
  return 0;
}

main()
  .then((c) => {
    process.exitCode = c;
  })
  .catch((err) => {
    console.error(String(err));
    process.exitCode = 3;
  });
