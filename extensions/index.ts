import type { Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { GitRepo } from "../src/git/GitRepo.ts";
import { EngineeringRuntime } from "../src/runtime/EngineeringRuntime.ts";
import { type CoreServices, buildCoreTools } from "../src/tools/coreTools.ts";
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

/**
 * Open (or reuse) the runtime for a working directory, lazily.
 *
 * The cache is keyed by the repository ROOT (git toplevel), not the raw cwd:
 * two cwd strings that point into the same repo (e.g. `<repo>` and
 * `<repo>/src`) must share ONE runtime/ledger view, otherwise each holds a
 * stale in-memory ledger over the same shared `.pi-eng/ledger.jsonl` file.
 */
async function getRuntimeByCwd(cwd: string, model?: Model<any>): Promise<EngineeringRuntime> {
  const key = await repoCacheKey(cwd);
  const existing = runtimes.get(key);
  if (existing) return existing;
  const rt = await EngineeringRuntime.open({
    cwd,
    verifier: new CommandVerifier(),
    model,
  });
  runtimes.set(key, rt);
  return rt;
}

async function repoCacheKey(cwd: string): Promise<string> {
  const repo = await GitRepo.open(cwd).catch(() => null);
  return repo ? repo.root : cwd;
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
    const incumbent = wi.incumbent_candidate_id ? rt.ledger.getCandidate(wi.incumbent_candidate_id) : undefined;
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

  pi.registerCommand("tournament", {
    description:
      "Run a candidate tournament: N independent implementations, verify+review each, promote the deterministic winner.",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("/tournament <goal> [n]", "error");
        return;
      }
      const parts = args.trim().split(/\s+/);
      const n = /\.\d+$/.test(parts[parts.length - 1]!) ? undefined : Number(parts.at(-1));
      const nCandidates = Number.isInteger(n) && n! >= 2 ? n! : 3;
      const goal = Number.isInteger(n) ? parts.slice(0, -1).join(" ") : args.trim();
      const rt = await getRuntime(ctx);
      ctx.ui.notify(`Running candidate tournament (${nCandidates} independent candidates)...`, "info");
      const report = await rt.tournament(goal, { n: nCandidates });
      const winner = report.entries.find((e) => e.winner);
      const lines = [
        `Work item ${report.work_item.id} [${report.work_item.status}] risk=${report.risk}`,
        `Candidates: ${report.entries.map((e) => `${e.candidate.id}:${e.outcome.passed ? "pass" : "FAIL"}(${e.findings.length})`).join(" ")}`,
        `Winner: ${winner?.candidate.id ?? "none"} (outcome: ${report.outcome})`,
        `Evidence: ${report.evidence_ids.join(", ") || "none"}`,
      ];
      ctx.ui.notify(lines.join("\n"), report.outcome === "promoted" ? "info" : "error");
    },
  });

  pi.registerCommand("plan", {
    description:
      "Decompose a goal into a dependency-aware task DAG (recorded in the ledger), then run /execute to execute it.",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("/plan <goal>", "error");
        return;
      }
      const rt = await getRuntime(ctx);
      ctx.ui.notify("Planning task DAG (planner worker)...", "info");
      const report = await rt.plan(args.trim());
      const lines = [
        `Plan work item ${report.plan_work_item.id} [${report.plan_work_item.status}] outcome=${report.outcome}`,
        report.tasks.length
          ? report.tasks
              .map(
                (t) =>
                  `- ${t.id} [${t.risk}] ${t.title}${t.depends_on.length ? ` (after ${t.depends_on.join(", ")})` : ""}`,
              )
              .join("\n")
          : "No tasks produced.",
        report.summary ? `Planner: ${report.summary.slice(0, 300)}` : "",
        `Run /execute ${report.plan_work_item.id} to execute this DAG.`,
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), report.outcome === "planned" ? "info" : "error");
    },
  });

  pi.registerCommand("execute", {
    description:
      "Execute a planned task DAG (from /plan) in dependency order, running each task through the engineer pipeline.",
    handler: async (args, ctx) => {
      const rt = await getRuntime(ctx);
      const planId = args.trim() || rt.ledger.listWorkItems().at(-1)?.id;
      if (!planId) {
        ctx.ui.notify("/execute <plan-work-item-id>  (or run /plan first)", "error");
        return;
      }
      ctx.ui.notify("Executing task DAG (each task through scout->implement->verify->review)...", "info");
      const report = await rt.executePlan(planId);
      const lines = [
        `Plan ${report.plan_work_item.id} [${report.plan_work_item.status}] outcome=${report.outcome}`,
        report.order.length
          ? report.order.map((t) => `- ${t.id} [${t.status}] ${t.title}`).join("\n")
          : "No tasks in DAG.",
        report.summary ? report.summary.split("\n").slice(0, 20).join("\n") : "",
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), report.outcome === "completed" ? "info" : "error");
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
    description:
      "Run risk-appropriate verification and record deterministic evidence. Use '/verify full' for a broader suite (lint + test:full).",
    handler: async (args, ctx) => {
      const rt = await getRuntime(ctx);
      const full = /\bfull\b/.test(args.trim());
      ctx.ui.notify(
        full ? "Detecting FULL verification profile (lint + test:full)..." : "Detecting verification profile...",
        "info",
      );
      const profile = await rt.verifier.detect(rt.cwd, { full });
      const outcome = await rt.verifier.run(rt.cwd, profile, rt.artifacts);
      // Record deterministic evidence into the ledger (linked to the latest
      // work item / candidate so it is not discarded).
      const wi = rt.ledger.listWorkItems().at(-1);
      const actor = { type: "user" as const };
      const evidenceIds: string[] = [];
      for (const ev of outcome.evidence) {
        const recorded = await rt.ledger.recordEvidence(
          wi?.current_candidate_id ?? null,
          ev.type,
          ev.tool,
          ev.command,
          ev.exit_code,
          ev.status,
          ev.summary,
          ev.artifacts,
          ev.trust,
          wi?.id ?? null,
          actor,
        );
        evidenceIds.push(recorded.id);
      }
      const lines = [
        evidenceIds.length ? `Evidence recorded: ${evidenceIds.join(", ")}` : "No evidence recorded.",
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
        rt.ledger.listWorkItems().at(-1) ??
          (await rt.ledger.createWorkItem(goal, "medium", [rt.cwd], { type: "user" })),
        goal,
        "",
      );
      ctx.ui.notify(`Challenger: ${result?.summary.slice(0, 600) ?? "no challenge produced"}`, "info");
    },
  });

  // The runtime and ledger are opened lazily on first command or tool use, so
  // no durable state is created until engineering work actually begins.
}
