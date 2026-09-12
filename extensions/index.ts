import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import { EngineeringRuntime } from "../src/runtime/EngineeringRuntime.ts";
import { buildCoreTools, type CoreServices } from "../src/tools/coreTools.ts";
import { CommandVerifier } from "../src/verify/Verifier.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

/**
 * pi-engineering-runtime — extension entry point.
 *
 * Registers the explicit interactive command surface (`/engineer`, `/review`,
 * `/challenge`, `/verify`, `/ledger`, `/context`) and the semantic tools
 * (`ledger_read`, `ledger_claim`, `artifact_read`, `repo_search`, `symbol`,
 * `tests_for`). Normal Pi coding needs no command; `/engineer` runs the full
 * adaptive workflow on demand.
 *
 * All state lives on disk (ledger + artifacts), so nothing depends on a
 * transcript surviving (INV-001).
 */

const runtimes = new Map<string, EngineeringRuntime>();

async function getRuntime(ctx: ExtensionCommandContext, worker?: EngineeringRuntime): Promise<EngineeringRuntime> {
  return getRuntimeByCwd(worker ? worker.cwd : ctx.cwd, ctx.model);
}

/** Open (or reuse) the runtime for a working directory, lazily. */
async function getRuntimeByCwd(cwd: string, model?: Model<any>): Promise<EngineeringRuntime> {
  const existing = runtimes.get(cwd);
  if (existing) return existing;
  const rt = await EngineeringRuntime.open({
    cwd,
    verifier: new CommandVerifier(),
    model,
  });
  runtimes.set(cwd, rt);
  return rt;
}

/**
 * Resolve tools to the runtime for the calling cwd, opening it lazily so the
 * semantic tools work in the interactive session without a prior command.
 */
async function resolveServices(cwd: string): Promise<CoreServices | null> {
  const rt = await getRuntimeByCwd(cwd).catch(() => null);
  if (!rt) return null;
  return {
    ledger: rt.ledger,
    artifacts: rt.artifacts,
    broker: rt.broker,
    currentWorkItemId: () => {
      const w = rt.ledger.listWorkItems().at(-1);
      return w ? w.id : null;
    },
    actor: () => ({ type: "user" }),
  };
}

function formatWorkItems(rt: EngineeringRuntime): string {
  const w = rt.ledger.listWorkItems();
  if (w.length === 0) return "No work items yet.";
  const lines = w.map((wi) => {
    const candidates = rt.ledger.listCandidates(wi.id);
    const incumbent = wi.incumbent_candidate_id
      ? rt.ledger.getCandidate(wi.incumbent_candidate_id)
      : undefined;
    return `- ${wi.id} [${wi.status}] risk=${wi.risk}\n    goal: ${wi.goal}\n    candidates: ${candidates.length}, incumbent: ${incumbent ? incumbent.id : "none"}`;
  });
  return lines.join("\n");
}

function formatEntities(rt: EngineeringRuntime, kind?: string): string {
  const entities = rt.ledger.listEntities(kind as never);
  if (entities.length === 0) return "No ledger entities yet.";
  return entities
    .slice(-30)
    .map((e) => `- ${e.kind} ${e.id} [${e.status}]${e.severity ? ` (${e.severity})` : ""}: ${e.claim.slice(0, 160)}`)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  // Semantic tools resolved against the runtime for the calling cwd.
  for (const tool of buildCoreTools(resolveServices)) {
    pi.registerTool(tool);
  }

  pi.registerCommand("engineer", {
    description: "Run the adaptive engineering workflow for a goal (scout -> implement -> verify -> review).",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("/engineer <goal>", "error");
        return;
      }
      const rt = await getRuntime(ctx);
      ctx.ui.notify("Running engineering workflow (fresh scouts/implementer/reviewer)...", "info");
      const report = await rt.engineer(args.trim());
      const lines = [
        `Work item ${report.work_item.id} [${report.work_item.status}] risk=${report.risk}`,
        report.scout_summary ? `Scout: ${report.scout_summary.slice(0, 300)}` : "Scout: skipped (low risk)",
        report.review_summary ? `Review: ${report.review_summary.slice(0, 300)}` : "Review: none",
        `Incumbent: ${report.incumbent_candidate?.id ?? "none"} (outcome: ${report.outcome}, ${report.rounds} round(s))`,
        `Evidence: ${report.evidence_ids.join(", ") || "none"}`,
      ];
      ctx.ui.notify(lines.join("\n"), report.outcome === "promoted" ? "info" : "error");
    },
  });

  pi.registerCommand("ledger", {
    description: "Show compact engineering state (work items, candidates, entities).",
    handler: async (args, ctx) => {
      const rt = await getRuntime(ctx);
      const kind = args.trim();
      const sections = [
        "=== Work items ===",
        formatWorkItems(rt),
        "",
        kind ? `=== Entities: ${kind} ===` : "=== Entities ===",
        formatEntities(rt, kind || undefined),
      ];
      ctx.ui.notify(sections.join("\n"), "info");
    },
  });

  pi.registerCommand("context", {
    description: "Show current context budget, sources, and worker usage.",
    handler: async (_args, ctx) => {
      const rt = await getRuntime(ctx);
      const usage = ctx.getContextUsage?.();
      const lines = [
        "=== Context ===",
        usage?.tokens != null ? `Active session tokens: ${usage.tokens}` : "Active session tokens: unavailable",
        `Ledger events: ${rt.ledger.count()}`,
        `Artifacts: ${rt.artifacts.list().length}`,
        `Repo indexed: ${rt.broker ? "yes" : "no"}`,
        `Role budgets (target/hard): scout 10k/24k, implementer 16k/40k, reviewer 10k/24k`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("verify", {
    description: "Run risk-appropriate verification and record deterministic evidence.",
    handler: async (_args, ctx) => {
      const rt = await getRuntime(ctx);
      ctx.ui.notify("Detecting verification profile...", "info");
      const profile = await rt.verifier.detect(rt.cwd);
      const outcome = await rt.verifier.run(rt.cwd, profile, rt.artifacts);
      const lines = [
        `Profile: ${profile.name} (${profile.stages.map((s) => s.name).join(", ") || "none"})`,
        `Result: ${outcome.passed ? "PASSED" : "FAILED"}${outcome.failedStage ? ` at ${outcome.failedStage}` : ""}`,
        ...outcome.stages.map(
          (s) => `- ${s.stage.name}: ${s.passed ? "pass" : "FAIL"} (exit ${s.exitCode}) log: ${s.artifactUri}`,
        ),
      ];
      ctx.ui.notify(lines.join("\n"), outcome.passed ? "info" : "error");
    },
  });

  pi.registerCommand("review", {
    description: "Launch a fresh-context independent review of the current work item's candidate.",
    handler: async (_args, ctx) => {
      const rt = await getRuntime(ctx);
      const wi = rt.ledger.listWorkItems().at(-1);
      if (!wi) {
        ctx.ui.notify("No work item to review. Run /engineer <goal> first.", "error");
        return;
      }
      const candidate = wi.current_candidate_id ? rt.ledger.getCandidate(wi.current_candidate_id) : undefined;
      if (!candidate) {
        ctx.ui.notify("No candidate to review.", "error");
        return;
      }
      ctx.ui.notify(`Spawning fresh-context reviewer for ${candidate.id}...`, "info");
      const rev = await rt.review(wi, candidate, wi.goal);
      ctx.ui.notify(rev.summary.slice(0, 600) || "Review complete.", "info");
    },
  });

  pi.registerCommand("challenge", {
    description: "Run a clean-room challenge of the current approach.",
    handler: async (args, ctx) => {
      const rt = await getRuntime(ctx);
      const goal = args.trim() || rt.ledger.listWorkItems().at(-1)?.goal;
      if (!goal) {
        ctx.ui.notify("No goal to challenge.", "error");
        return;
      }
      ctx.ui.notify("Spawning clean-room challenger (no prior reasoning)...", "info");
      const result = await rt.challenge(
        rt.ledger.listWorkItems().at(-1) ?? (await rt.ledger.createWorkItem(goal, "medium", [rt.cwd], { type: "user" })),
        goal,
        "",
      );
      ctx.ui.notify(`Challenger: ${result?.summary.slice(0, 600) ?? "no challenge produced"}`, "info");
    },
  });

  // The runtime and ledger are opened lazily on first command or tool use, so
  // no durable state is created until engineering work actually begins.
}
