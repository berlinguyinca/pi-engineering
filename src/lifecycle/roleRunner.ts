/**
 * Role execution (spec §11, §12.3 fallback, §23 tool policy).
 *
 * A role is dispatched to the model the router chose, inside a fresh isolated
 * session with a role-scoped tool allowlist. When the chosen model fails, the
 * registry records the failure and the next eligible model is tried — routing
 * failure is a first-class outcome, not a crash.
 */

import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import type { ModelCapabilityRegistry } from "../capability/registry.ts";
import type { RoleName } from "../capability/roles.ts";
import { ROLE_REQUIREMENTS } from "../capability/roles.ts";
import type { RoleRouter } from "../capability/router.ts";
import { newArtifactId } from "../core/ids.ts";
import type { WorkerExecutor, WorkerImage, WorkerRun } from "../workers/WorkerExecutor.ts";
import { type ReviewVerdictPayload, toReviewReport } from "./reviewResultTool.ts";
import { buildRoleKickoff, buildRolePrompt } from "./rolePrompts.ts";
import type { ChangeSnapshot, ModelRef, ReviewReport, RoutingDecision, VerificationReport } from "./types.ts";
import { modelKey } from "./types.ts";

export interface RoleSpec {
  role: RoleName;
  request: string;
  round: number;
  snapshot?: ChangeSnapshot;
  checks?: VerificationReport[];
  priorFindings?: ReviewReport[];
  spec?: { path: string; excerpt: string };
  images?: WorkerImage[];
  /** Model that produced the work under review (separation of duties). */
  requester?: ModelRef;
  /** Models already attempted for this role in this round. */
  exclude?: ModelRef[];
  extraKickoff?: string;
  timeoutMs?: number;
  taskModelOverride?: string;
}

export interface ReviewOutcome {
  role: RoleName;
  decision: RoutingDecision;
  report: ReviewReport;
}

export interface RoleRunner {
  runReview(spec: RoleSpec): Promise<ReviewOutcome>;
  runWorker(spec: RoleSpec): Promise<{ role: RoleName; decision: RoutingDecision; run: WorkerRun }>;
  /** The model currently serving the parent session, if known. */
  sessionModel(): ModelRef | undefined;
}

export interface PiRoleRunnerOptions {
  registry: ModelCapabilityRegistry;
  router: RoleRouter;
  executor: WorkerExecutor;
  artifacts: ArtifactStore;
  cwd: string;
  maxAttempts?: number;
  /** Called whenever a role lands on a model, for telemetry. */
  onInvocation?: (args: {
    role: RoleName;
    model: ModelRef;
    ok: boolean;
    durationMs: number;
    error?: string;
    usage?: { input: number; output: number; cost: number } | null;
  }) => void;
}

const MAX_ROUTING_ATTEMPTS = 3;

export class PiRoleRunner implements RoleRunner {
  private readonly registry: ModelCapabilityRegistry;
  private readonly router: RoleRouter;
  private readonly executor: WorkerExecutor;
  private readonly artifacts: ArtifactStore;
  private readonly cwd: string;
  private readonly maxAttempts: number;
  private readonly onInvocation?: PiRoleRunnerOptions["onInvocation"];

  constructor(opts: PiRoleRunnerOptions) {
    this.registry = opts.registry;
    this.router = opts.router;
    this.executor = opts.executor;
    this.artifacts = opts.artifacts;
    this.cwd = opts.cwd;
    this.maxAttempts = Math.min(MAX_ROUTING_ATTEMPTS, opts.maxAttempts ?? MAX_ROUTING_ATTEMPTS);
    this.onInvocation = opts.onInvocation;
  }

  sessionModel(): ModelRef | undefined {
    // Cast through unknown: bracket access is the only way to read the router's
    // private session model, which is not exposed via a public accessor.
    return (this.router as unknown as { sessionModel?: () => ModelRef | undefined }).sessionModel?.();
  }

  private async attempt(
    spec: RoleSpec,
    resultTool: "worker_result" | "review_result",
  ): Promise<{ decision: RoutingDecision; run?: WorkerRun; error?: string; model?: ModelRef }> {
    const attempted: ModelRef[] = [...(spec.exclude ?? [])];
    let lastDecision: RoutingDecision | undefined;

    for (let i = 0; i < this.maxAttempts; i++) {
      const decision =
        attempted.length === 0
          ? await this.router.select({
              role: spec.role,
              requester: spec.requester,
              taskOverride: spec.taskModelOverride,
              minContext: spec.snapshot ? Math.min(200_000, 16_000 + spec.snapshot.diffChars) : undefined,
            })
          : ((await this.router.fallback(
              { role: spec.role, requester: spec.requester, taskOverride: spec.taskModelOverride },
              attempted,
            )) ?? lastDecision);
      if (!decision) break;
      lastDecision = decision;
      const model = decision.selected;
      if (!model)
        return { decision, error: decision.rationale.find((r) => r.startsWith("No eligible")) ?? "no eligible model" };
      attempted.push(model);

      const started = Date.now();
      const kickoff = buildRoleKickoff({
        role: spec.role,
        request: spec.request,
        snapshot: spec.snapshot,
        checks: spec.checks,
        priorFindings: spec.priorFindings,
        specExcerpt: spec.spec?.excerpt,
        specPath: spec.spec?.path,
        round: spec.round,
        imageCount: spec.images?.length,
        extra: spec.extraKickoff,
      });
      const roleRequirements = ROLE_REQUIREMENTS[spec.role];
      try {
        const run = await this.executor.run({
          // The lifecycle owns its own role vocabulary; `implementer` is the
          // closest legacy role for budget accounting and is overridden below.
          role: "implementer",
          task: spec.request,
          kickoff,
          systemPromptOverride: buildRolePrompt(spec.role),
          tools: [...roleRequirements.tools],
          cwd: this.cwd,
          modelOverride: model,
          images: spec.images,
          resultTool,
          timeoutMs: spec.timeoutMs ?? 240_000,
        });
        const durationMs = Date.now() - started;
        const failed = !!run.error;
        this.onInvocation?.({
          role: spec.role,
          model,
          ok: !failed,
          durationMs,
          error: run.error,
          usage: run.usage ? { input: run.usage.input, output: run.usage.output, cost: run.usage.cost } : null,
        });
        if (!failed) {
          this.registry.clearPenalty(model);
          return { decision, run, model };
        }
        this.registry.penalize(model, run.error ?? "role invocation failed");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - started;
        this.onInvocation?.({ role: spec.role, model, ok: false, durationMs, error: message });
        this.registry.penalize(model, message);
      }
    }
    return {
      decision: lastDecision ?? {
        role: spec.role,
        candidates: [],
        rejected: [],
        rationale: ["Routing produced no decision."],
        decidedAt: new Date().toISOString(),
      },
      error: "all routing attempts failed",
      model: attempted.at(-1),
    };
  }

  async runReview(spec: RoleSpec): Promise<ReviewOutcome> {
    const started = Date.now();
    const { decision, run, model, error } = await this.attempt(spec, "review_result");
    const modelRef: ModelRef = model ?? decision.selected ?? { provider: "none", id: "none" };
    if (!run) {
      return {
        role: spec.role,
        decision,
        report: toReviewReport({
          role: spec.role,
          model: modelRef,
          round: spec.round,
          durationMs: Date.now() - started,
          payload: undefined,
          error: error ?? "Role could not be executed.",
        }),
      };
    }
    let artifactUri: string | undefined;
    const summaryText = JSON.stringify(run.structured ?? run.result, null, 2);
    if (summaryText.length > 400) {
      const meta = await this.artifacts.put(
        "review",
        newArtifactId(),
        summaryText,
        `${spec.role} round ${spec.round} full output`,
      );
      artifactUri = meta.uri;
    }
    return {
      role: spec.role,
      decision,
      report: toReviewReport({
        role: spec.role,
        model: modelRef,
        round: spec.round,
        durationMs: Date.now() - started,
        payload: run.structured as ReviewVerdictPayload | undefined,
        artifactUri,
        error: run.error ?? (run.structured ? undefined : "Reviewer produced no verdict."),
      }),
    };
  }

  async runWorker(spec: RoleSpec): Promise<{ role: RoleName; decision: RoutingDecision; run: WorkerRun }> {
    const { decision, run, error } = await this.attempt(spec, "worker_result");
    return {
      role: spec.role,
      decision,
      run:
        run ??
        ({
          result: {
            status: "failed",
            summary: error ?? "Role could not be executed.",
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
            error: error ?? "role-unavailable",
          },
          usage: null,
          error: error ?? "role-unavailable",
        } as WorkerRun),
    };
  }
}

/** Deterministic role runner used by tests and offline dry-runs. */
export class ScriptedRoleRunner implements RoleRunner {
  private readonly reviews: ReviewReport[] = [];
  private index = 0;

  private readonly opts: {
    sessionModel?: ModelRef;
    /** Programmatic verdicts keyed by role; the same role may be scripted twice. */
    verdicts?: Record<string, () => ReviewVerdictPayload | undefined>;
    routing?: Record<string, ModelRef>;
  };

  constructor(
    opts: {
      sessionModel?: ModelRef;
      verdicts?: Record<string, () => ReviewVerdictPayload | undefined>;
      routing?: Record<string, ModelRef>;
    } = {},
  ) {
    this.opts = opts;
  }

  sessionModel(): ModelRef | undefined {
    return this.opts.sessionModel;
  }

  /** Record a scripted review so a later round can see prior findings. */
  remember(report: ReviewReport): void {
    this.reviews.push(report);
  }

  async runReview(spec: RoleSpec): Promise<ReviewOutcome> {
    const model = this.opts.routing?.[spec.role] ?? this.opts.sessionModel ?? { provider: "scripted", id: spec.role };
    const decision: RoutingDecision = {
      role: spec.role,
      selected: model,
      candidates: [{ model, score: 1, parts: {} }],
      rejected: [],
      rationale: [`scripted routing for ${spec.role} -> ${modelKey(model)}`],
      decidedAt: new Date().toISOString(),
    };
    const factory = this.opts.verdicts?.[spec.role];
    const payload = factory?.();
    const report = toReviewReport({
      role: spec.role,
      model,
      round: spec.round,
      durationMs: 1,
      payload,
      error: payload ? undefined : "scripted: no verdict",
    });
    this.remember(report);
    return { role: spec.role, decision, report };
  }

  async runWorker(spec: RoleSpec): Promise<{ role: RoleName; decision: RoutingDecision; run: WorkerRun }> {
    const model = this.opts.routing?.[spec.role] ?? this.opts.sessionModel ?? { provider: "scripted", id: spec.role };
    const decision: RoutingDecision = {
      role: spec.role,
      selected: model,
      candidates: [{ model, score: 1, parts: {} }],
      rejected: [],
      rationale: [`scripted routing for ${spec.role} -> ${modelKey(model)}`],
      decidedAt: new Date().toISOString(),
    };
    return {
      role: spec.role,
      decision,
      run: {
        result: {
          status: "completed",
          summary: `scripted ${spec.role}`,
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
        usage: null,
      },
    };
  }
}
