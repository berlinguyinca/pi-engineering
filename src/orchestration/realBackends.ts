/**
 * Real backends for the ExecutionBroker, wiring the EXISTING pi-engineering
 * runtime primitives (spec 00 §6: reuse existing engineering/review workflows):
 *
 *   - agent/research -> fresh-context worker via WorkerExecutor
 *   - process        -> deterministic subprocess via CommandVerifier
 *   - validation     -> deterministic verification via CommandVerifier
 *   - review         -> fresh independent review via WorkerExecutor (reviewer role)
 *   - integration    -> GitRepo controlled merge (integrator role)
 *
 * These adapters are what the extension uses to run a live orchestrated
 * mission; tests inject deterministic fakes instead.
 */

import { createHash } from "node:crypto";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import { id } from "../core/ids.ts";
import type { CandidateLifecycle, GitRepo, IntegrationRunRecord } from "../git/GitRepo.ts";
import type { WorktreeInfo } from "../git/GitRepo.ts";
import { type ModelRef, modelKey } from "../lifecycle/types.ts";
import type { VerificationProvider } from "../verify/Verifier.ts";
import { MODEL_SUPERSEDED } from "../workers/WorkerExecutor.ts";
import type { WorkerActivity, WorkerExecutor, WorkerRequest, WorkerRun } from "../workers/WorkerExecutor.ts";
import {
  type CheckpointRecoveryContext,
  type ExecutionOutcome,
  type IntegrationHandoff,
  workerTimeoutMs,
} from "./broker.ts";
import { normalizeReviewSeverity, validateAcceptanceResults } from "./evidence.ts";

export interface RealBackendsOptions {
  worker: WorkerExecutor;
  verifier: VerificationProvider;
  artifacts: ArtifactStore;
  git: GitRepo | null;
  cwd: string;
  /**
   * Optional capability-router hook: resolve a worker role to a specific
   * `{provider, id}` model placement (e.g. from `policy.routing.roles`). When
   * it returns a model, the worker runs on that model; when it returns
   * `undefined` (or is omitted) the worker falls back to its construction-time
   * default, preserving the pre-routing behavior. This is what makes per-role
   * model placement (a pinned implementer/reviewer) take effect in the mission
   * pipeline, matching the lifecycle `roleRunner` path.
   */
  routeModel?: RouteModel;
  /**
   * Called when the gateway confirmed it no longer serves a model (the worker
   * failed with `transient:model_unavailable` or `unknown-model`). The runtime
   * records and logs it so later routing excludes it; the attempt itself is
   * handed to the next eligible model right away (see runWithModelTakeover).
   */
  onModelUnavailable?: (model: ModelRef, context: { missionId?: string; taskId?: string; reason: string }) => void;
  /** Called when an attempt succeeded on a model: it is served again. */
  onModelServed?: (model: ModelRef) => void;
  /** True for a model currently recorded as unavailable (never a reviewer fallback). */
  isModelUnavailable?: (model: ModelRef) => boolean;
  /**
   * Current/session model: the executor's default when a role is not routed,
   * and the reviewer's last resort when no distinct model is available.
   */
  reviewFallbackModel?: ModelRef;
  /**
   * The operator pin a mission dispatches with right now (Pi `/model`),
   * adopting the session's latest choice. A change while a worker is waiting
   * between inference requests re-dispatches it on the new choice.
   */
  currentOperatorPin?: (missionId: string) => ModelRef | null | undefined;
  /** Resolve the repository selected by the current mission's async binding. */
  repository?: (repoId?: string) => Promise<{ git: GitRepo; cwd: string }> | { git: GitRepo; cwd: string };
}

export interface ModelRoute extends ModelRef {
  /** Operator-visible notice when policy had to degrade model separation. */
  warning?: string;
  /** The mission's operator pin (Pi `/model`) placed this role. */
  operatorPin?: boolean;
}

export interface RouteModelOptions {
  /** Models not to place the role on (already tried, or that produced the work). */
  exclude?: ModelRef[];
  /**
   * Choosing a replacement after the model was found gone. Only then is a
   * worker role the router has no native role for (investigator, scout, ...)
   * mapped onto one; its first attempt stays on the executor default.
   */
  replacement?: boolean;
  /** The mission being dispatched: its operator pin, if any, places the role. */
  missionId?: string;
}

/** Resolve a worker role to a model placement, or undefined for the executor default. */
export type RouteModel = (role: string, opts?: RouteModelOptions) => Promise<ModelRoute | undefined>;

/**
 * Worker failure markers for a model that is not served: a gateway 404
 * model_not_found (`transient:model_unavailable`) or a model pruned from the
 * local model runtime (`unknown-model`). Both hand the attempt to another model.
 */
const MODEL_GONE_MARKERS: ReadonlySet<string> = new Set(["transient:model_unavailable", "unknown-model"]);

/**
 * An "invalid model name" refusal comes from one route of the gateway (the
 * multimodal one), so it is specific to the request: hand the attempt over,
 * but do not mark the model unavailable for every other worker.
 */
const REQUEST_SPECIFIC_REFUSAL = /invalid model name/i;

const sameModel = (a: ModelRef, b: ModelRef): boolean => modelKey(a) === modelKey(b);

/** Missions whose producing models are remembered for reviewer separation. */
export const MAX_TRACKED_MISSIONS = 256;

/** The model a worker run says it ran on (PiWorkerExecutor names it on failure). */
function ranOn(run: WorkerRun): ModelRef | undefined {
  const named = run.result.details?.model;
  if (!named || typeof named !== "object") return undefined;
  const { provider, id } = named as Record<string, unknown>;
  return typeof provider === "string" && typeof id === "string" ? { provider, id } : undefined;
}

/** Attach the model an attempt ran on to its outcome. */
function withModel(outcome: ExecutionOutcome, model: ModelRef | undefined): ExecutionOutcome {
  return model ? { ...outcome, model: { provider: model.provider, id: model.id } } : outcome;
}

const reducedIndependence = (model: ModelRef, why: string): string =>
  `Warning: ${why}; reviewing with ${modelKey(model)} in a fresh session with reduced independence.`;

async function artifactContentHashes(
  store: ArtifactStore,
  refs: string[],
): Promise<{ hashes: string[]; allAccessible: boolean }> {
  const hashes: string[] = [];
  let allAccessible = true;
  for (const ref of refs) {
    const content = await store.readContentByUri(ref);
    if (content === undefined) {
      allAccessible = false;
      continue;
    }
    hashes.push(`sha256:${createHash("sha256").update(content).digest("hex")}`);
  }
  return { hashes, allAccessible };
}

/**
 * Normalize reviewer findings of varying shapes into a uniform list of records
 * consumed by the orchestrator's finding store + the completion gate. Handles
 * three shapes: objects ({severity, summary|message|text|title}), plain strings
 * (severity defaults to "warning"), and a JSON string (possibly an array).
 * The output always carries `summary` (the human message) alongside `message`,
 * plus optional `severity`, `category`, `file`, `line`, `evidence`, and
 * `recommended_action` passthroughs.
 */
export function normalizeFindings(raw: unknown): Array<Record<string, unknown>> {
  const norm = (obj: Record<string, unknown>): Record<string, unknown> => {
    const summary = obj.summary ?? obj.message ?? obj.text ?? obj.title;
    const out: Record<string, unknown> = { summary };
    if (typeof summary === "string") {
      out.message = summary;
      for (const k of ["severity", "category", "file", "line", "evidence", "recommended_action"] as const) {
        if (obj[k] !== undefined) out[k] = obj[k];
      }
    }
    return out;
  };
  if (Array.isArray(raw)) {
    return raw.flatMap((f) => {
      if (typeof f === "string") return [{ summary: f, message: f }];
      if (f && typeof f === "object") {
        const out = norm(f as Record<string, unknown>);
        return out.summary !== undefined ? [out] : [];
      }
      return [];
    });
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return normalizeFindings(parsed);
        if (parsed && typeof parsed === "object") {
          const out = norm(parsed as Record<string, unknown>);
          return out.summary !== undefined ? [out] : [];
        }
      } catch {
        /* fall through */
      }
    }
    return [{ summary: trimmed, message: trimmed }];
  }
  if (raw && typeof raw === "object") {
    const out = norm(raw as Record<string, unknown>);
    return out.summary !== undefined ? [out] : [];
  }
  return [];
}

function validRawReviewFinding(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  if (typeof finding.title !== "string" || !finding.title.trim()) return false;
  if (typeof finding.detail !== "string" || !finding.detail.trim()) return false;
  try {
    normalizeReviewSeverity(finding.severity);
    return true;
  } catch {
    return false;
  }
}

function validRawMissingTest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const missing = value as Record<string, unknown>;
  if (typeof missing.description !== "string" || !missing.description.trim()) return false;
  try {
    normalizeReviewSeverity(missing.severity);
    return true;
  } catch {
    return false;
  }
}

function validRawSpecGap(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const gap = value as Record<string, unknown>;
  if (typeof gap.requirement !== "string" || !gap.requirement.trim()) return false;
  if (typeof gap.detail !== "string" || !gap.detail.trim()) return false;
  if (!["missing", "partial", "divergent", "unverifiable"].includes(String(gap.status))) return false;
  try {
    normalizeReviewSeverity(gap.severity);
    return true;
  } catch {
    return false;
  }
}

/** Convert a worker result into a bounded broker outcome. */
function outcomeOf(result: Awaited<ReturnType<WorkerExecutor["run"]>>): ExecutionOutcome {
  const completed = result.result.status === "completed";
  const outcome: ExecutionOutcome = {
    executionId: "worker",
    exitStatus: completed ? "succeeded" : "failed",
    summary: result.result.summary,
    artifactRefs: result.result.evidence_refs ?? [],
    usage: {
      input: result.usage?.input ?? 0,
      output: result.usage?.output ?? 0,
      model: result.usage?.model ?? "unknown",
    },
  };
  // Surface the worker's machine-readable failure marker (e.g.
  // `transient:server_unavailable`) so the scheduler can classify a non-throwing
  // failure and route a transient infrastructure failure into the time-based
  // resilience window instead of immediately failing the task.
  if (!completed) outcome.error = result.result.error ?? result.result.summary;
  return outcome;
}

export function realBackends(opts: RealBackendsOptions) {
  const repository = async (repoId?: string): Promise<{ git: GitRepo | null; cwd: string }> =>
    (await opts.repository?.(repoId)) ?? { git: opts.git, cwd: opts.cwd };
  const runWorker = async (
    req: WorkerRequest,
    input: { signal: AbortSignal; onActivity?: (event: WorkerActivity) => void },
  ): Promise<Awaited<ReturnType<WorkerExecutor["run"]>>> => {
    if (input.signal.aborted) throw new Error("worker execution aborted");
    let aborted = false;
    const markAborted = (): void => {
      aborted = true;
    };
    const publish = (event: WorkerActivity): void => {
      if (aborted) return;
      try {
        input.onActivity?.(event);
      } catch {
        // Activity consumers are observers, never participants.
      }
    };
    req.onActivity = publish;
    req.signal = input.signal;
    input.signal.addEventListener("abort", markAborted, { once: true });
    try {
      const result = await opts.worker.run(req);
      const completed = result.result.status === "completed";
      publish({
        kind: "state",
        phase: completed ? "completed" : "failed",
        summary: completed ? "Worker session completed" : "Worker session failed",
        meaningfulProgress: completed,
      });
      return result;
    } catch (error) {
      publish({ kind: "state", phase: "failed", summary: "Worker session failed", meaningfulProgress: false });
      throw error;
    } finally {
      input.signal.removeEventListener("abort", markAborted);
    }
  };
  /**
   * Models that produced each mission's work (the final model of every agent
   * run), so the reviewer can keep separation of duties after a takeover.
   */
  const producedBy = new Map<string, ModelRef[]>();
  const recordProducer = (missionId: string | undefined, model: ModelRef | undefined): void => {
    if (!missionId || !model) return;
    const models = producedBy.get(missionId) ?? [];
    if (!models.some((known) => sameModel(known, model))) models.push({ provider: model.provider, id: model.id });
    // Most recently active last; the oldest mission is forgotten past the bound
    // (realBackends has no mission-settled hook to prune on).
    producedBy.delete(missionId);
    producedBy.set(missionId, models);
    if (producedBy.size > MAX_TRACKED_MISSIONS) {
      const oldest = producedBy.keys().next().value;
      if (oldest !== undefined) producedBy.delete(oldest);
    }
  };
  /** The operator pin a mission dispatches with right now (adopting a new choice). */
  const pinKeyOf = (missionId: string | undefined): string | null => {
    if (!missionId || !opts.currentOperatorPin) return null;
    const pin = opts.currentOperatorPin(missionId);
    return pin ? modelKey(pin) : null;
  };
  /** Place the attempt on `route` and arm the operator-switch check for it. */
  const arm = (req: WorkerRequest, route: ModelRoute | undefined, missionId: string | undefined): void => {
    if (route) req.modelOverride = { provider: route.provider, id: route.id };
    else delete req.modelOverride;
    req.operatorPinned = route?.operatorPin === true;
    if (!missionId || !opts.currentOperatorPin) return;
    const dispatchedWith = pinKeyOf(missionId);
    req.modelSuperseded = () => pinKeyOf(missionId) !== dispatchedWith;
  };
  /**
   * Run a worker on `plan.initial` (or, unrouted, on the executor default).
   * While the attempt fails because its model is not served, record the model
   * as unavailable, ask `plan.next` for another with every tried model
   * excluded, and rerun on it in a fresh session. Stops on success, any other
   * outcome, or when no new model is offered (the last failure is then
   * returned, so the task fails as before). Every switch is announced as
   * activity and prefixed to the summary.
   *
   * An attempt that ended because the operator chose another model
   * (`model_superseded`, only ever at an inference boundary) is re-dispatched
   * on `plan.repick()` — the new choice — without marking anything unavailable.
   */
  const runWithModelTakeover = async (
    req: WorkerRequest,
    input: { signal: AbortSignal; onActivity?: (event: WorkerActivity) => void },
    plan: {
      initial: ModelRoute | undefined;
      next: (tried: ModelRef[]) => Promise<ModelRoute | undefined>;
      repick: (tried: ModelRef[]) => Promise<ModelRoute | undefined>;
      freshSessionId: () => string;
      context: { missionId?: string; taskId?: string };
      onSwitch?: (from: ModelRef, to: ModelRoute) => void;
      /** Announce a route's own warning (e.g. a pin the role could not use). */
      announceWarnings?: boolean;
    },
  ): Promise<{ run: Awaited<ReturnType<WorkerExecutor["run"]>>; route: ModelRoute | undefined; model?: ModelRef }> => {
    const announce = (summary: string): void => {
      try {
        input.onActivity?.({ kind: "state", phase: "started", summary, meaningfulProgress: false });
      } catch {
        // Activity consumers are observers, never participants.
      }
    };
    let route = plan.initial;
    if (plan.announceWarnings && route?.warning) announce(route.warning);
    arm(req, route, plan.context.missionId);
    let run = await runWorker(req, input);
    // The model the attempt ran on: the route; unrouted, the model the worker
    // names, else the session model (normally the executor's default).
    let model: ModelRef | undefined = route ?? ranOn(run) ?? opts.reviewFallbackModel;
    const tried: ModelRef[] = [];
    const switches: string[] = [];
    while (!input.signal.aborted) {
      const error = outcomeOf(run).error ?? "";
      if (error === MODEL_SUPERSEDED) {
        const next = await plan.repick(tried);
        const notice = `operator switched models — ${req.role} moves from ${model ? modelKey(model) : "the default model"} to ${next ? modelKey(next) : "automatic routing"} at this inference boundary`;
        switches.push(notice);
        announce(notice);
        if (plan.announceWarnings && next?.warning) announce(next.warning);
        if (model && next) plan.onSwitch?.(model, next);
        route = next;
        req.sessionId = plan.freshSessionId();
        arm(req, route, plan.context.missionId);
        run = await runWorker(req, input);
        model = route ?? ranOn(run) ?? opts.reviewFallbackModel;
        continue;
      }
      if (!model || !MODEL_GONE_MARKERS.has(error)) break;
      const failed: ModelRef = model;
      const reason = run.result.summary;
      if (!REQUEST_SPECIFIC_REFUSAL.test(reason)) opts.onModelUnavailable?.(failed, { ...plan.context, reason });
      tried.push(failed);
      const next = await plan.next(tried);
      if (!next || tried.some((known) => sameModel(known, next))) break;
      const notice = `model ${modelKey(failed)} is no longer served — switched ${req.role} to ${modelKey(next)}`;
      switches.push(notice);
      announce(notice);
      plan.onSwitch?.(failed, next);
      route = next;
      model = next;
      req.sessionId = plan.freshSessionId();
      arm(req, route, plan.context.missionId);
      run = await runWorker(req, input);
    }
    // A model that serves an attempt again is no longer considered gone.
    if (model && run.result.status === "completed") opts.onModelServed?.(model);
    if (switches.length > 0) {
      run = { ...run, result: { ...run.result, summary: `${switches.join("; ")}. ${run.result.summary}` } };
    }
    return { run, route, model };
  };
  /** Takeover plan for a routed worker role: the next model the router offers. */
  const routedPlan = async (role: string, context: { missionId?: string; taskId?: string }, prefix: string) => ({
    initial: await opts.routeModel?.(role, { missionId: context.missionId }),
    next: async (tried: ModelRef[]) =>
      opts.routeModel?.(role, { exclude: tried, replacement: true, missionId: context.missionId }),
    repick: async (tried: ModelRef[]) =>
      opts.routeModel?.(role, { ...(tried.length > 0 ? { exclude: tried } : {}), missionId: context.missionId }),
    freshSessionId: () => id(prefix),
    context,
    announceWarnings: true,
  });
  return {
    agent: {
      async runAgent(input: {
        role: string;
        repoId?: string;
        objective: string;
        contextRef?: string;
        worktree?: string | null;
        isolatedWorktree?: boolean;
        modelRequirements?: Record<string, unknown>;
        recovery?: CheckpointRecoveryContext;
        deliverables?: readonly string[];
        missionId?: string;
        taskId?: string;
        signal: AbortSignal;
        onActivity?: (event: WorkerActivity) => void;
      }): Promise<ExecutionOutcome> {
        const bound = await repository(input.repoId);
        const req: WorkerRequest = {
          role: (input.role as WorkerRequest["role"]) ?? "implementer",
          task: input.objective,
          context: input.contextRef,
          tools: ["ledger_read", "ledger_claim", "artifact_read", "repo_search", "symbol", "tests_for", "bash"],
          cwd: input.worktree ?? bound.cwd,
          // No duration cap: the broker owns liveness (activity-based) and any
          // opt-in limit. This only carries an explicit operator override.
          timeoutMs: workerTimeoutMs(),
          // A mission worker waits for inference capacity however long it takes.
          unboundedInferenceWait: true,
          // Only the broker's word makes a directory an isolated worktree; the
          // fallback (no worktree) runs in the user's checkout.
          isolatedWorktree: input.isolatedWorktree === true && !!input.worktree,
          recovery: input.recovery,
          deliverables: input.deliverables,
          // Every delegated implementation/recovery run is a fresh session;
          // carrying the identity through the public worker request makes its
          // separation from the later reviewer independently auditable.
          sessionId: id("WKS"),
        };
        // Place the worker on the model the capability router chose for this
        // role (honours `policy.routing.roles`); fall back to the executor
        // default when routing is unavailable or the role is unknown.
        // A model the gateway no longer serves is handed over to the next
        // eligible one in this same execution.
        const { run, model } = await runWithModelTakeover(
          req,
          input,
          await routedPlan(req.role, { missionId: input.missionId, taskId: input.taskId }, "WKS"),
        );
        recordProducer(input.missionId, model);
        return withModel(outcomeOf(run), model);
      },
    },
    research: {
      async runAgent(input: {
        role?: string;
        repoId?: string;
        objective: string;
        contextRef?: string;
        signal: AbortSignal;
        onActivity?: (event: WorkerActivity) => void;
      }): Promise<ExecutionOutcome> {
        const bound = await repository(input.repoId);
        const req: WorkerRequest = {
          role: "scout",
          task: input.objective,
          context: input.contextRef,
          tools: ["ledger_read", "repo_search", "symbol", "tests_for"],
          cwd: bound.cwd,
          unboundedInferenceWait: true,
        };
        const { run, model } = await runWithModelTakeover(req, input, await routedPlan(req.role, {}, "WKS"));
        return withModel(outcomeOf(run), model);
      },
    },
    validation: {
      candidateScoped: true,
      async runValidation(input: {
        repoId?: string;
        objective: string;
        worktree?: string | null;
        signal: AbortSignal;
        onActivity?: (event: WorkerActivity) => void;
      }): Promise<ExecutionOutcome> {
        input.signal.throwIfAborted();
        const cwd = input.worktree ?? (await repository(input.repoId)).cwd;
        const profile = await opts.verifier.detect(cwd);
        input.signal.throwIfAborted();
        const outcome = await opts.verifier.run(cwd, profile, opts.artifacts, { signal: input.signal });
        const artifactRefs = outcome.evidence.flatMap((e) => e.artifacts).filter(Boolean);
        const artifactState = await artifactContentHashes(opts.artifacts, artifactRefs);
        // A repo with no detectable checks produced no evidence; nothing FAILED.
        // Reporting it as a failed task made the repair loop spawn "Fix the
        // failing validation step" work no implementer can satisfy. The
        // noTargets evidence still keeps the completion gate closed.
        return {
          executionId: "validation",
          exitStatus: outcome.passed || outcome.noTargets ? "succeeded" : "failed",
          summary: outcome.noTargets
            ? "no verification targets detected — recorded as missing evidence, not a failed check"
            : outcome.passed
              ? `validation passed (${outcome.stages.length} stages)`
              : `validation failed at ${outcome.failedStage ?? "unknown"}`,
          artifactRefs,
          artifactHashes: artifactState.hashes,
          usage: { stages: outcome.stages.length },
          validationEvidence: {
            command:
              profile.stages.map((stage) => [stage.command, ...stage.args].join(" ")).join(" && ") || "<no-target>",
            profile: profile.name,
            exitCode:
              outcome.passed && !outcome.noTargets ? 0 : (outcome.stages.find((stage) => !stage.passed)?.exitCode ?? 1),
            testSummary: {
              stages: outcome.stages.map((stage) => ({
                name: stage.stage.name,
                exitCode: stage.exitCode,
                passed: stage.passed,
              })),
              failedStage: outcome.failedStage,
            },
            noTargets: outcome.noTargets,
            accessible: artifactState.allAccessible,
            acceptanceResults: [],
          },
        };
      },
    },
    review: {
      candidateScoped: true,
      async runReview(input: {
        repoId?: string;
        objective: string;
        contextRef?: string;
        acceptanceCriteria?: Array<{ acceptanceId: string; criterion: string }>;
        worktree?: string | null;
        missionId?: string;
        taskId?: string;
        signal: AbortSignal;
        onActivity?: (event: WorkerActivity) => void;
      }): Promise<ExecutionOutcome> {
        // A review must inspect the integrated change, read evidence, and write
        // concrete findings — a long, prose-heavy task. Give it an explicit,
        // generous context budget so the reviewer is never cut off for hitting
        // the (previously unset → default) token cap; the role-adjusted guard
        // lets it write its findings report without a false degeneration abort.
        const bound = await repository(input.repoId);
        const reviewerSessionId = id("RVS");
        const req: WorkerRequest = {
          role: "reviewer",
          task: `${input.objective}${(input.acceptanceCriteria ?? [])
            .map((criterion) => `\nAcceptance criterion ${criterion.acceptanceId}: ${criterion.criterion}`)
            .join("")}`,
          context: input.contextRef,
          tools: ["ledger_read", "artifact_read", "repo_search", "symbol"],
          cwd: input.worktree ?? bound.cwd,
          maxContextTokens: 64_000,
          // Same as implementation workers: no duration cap (the broker owns
          // liveness), and inference waiting is unbounded. The executor's old
          // 5-minute default aborted reviewers mid-analysis.
          timeoutMs: workerTimeoutMs(),
          unboundedInferenceWait: true,
          sessionId: reviewerSessionId,
          resultTool: "review_result",
        };
        // Separation of duties: the reviewer must not run on a model that
        // produced this mission's work, including one an implementer took over
        // onto. Candidates in order: a distinct routed model; once, the session
        // model (reduced independence) unless it is itself unavailable; and,
        // only when nothing else is left, a producing model (reduced).
        const producers = producedBy.get(input.missionId ?? "") ?? [];
        const fallback = opts.reviewFallbackModel;
        const pickReviewer = async (tried: ModelRef[]): Promise<ModelRoute | undefined> => {
          const distinct = await opts.routeModel?.(req.role, {
            exclude: [...producers, ...tried],
            missionId: input.missionId,
          });
          if (distinct) return distinct;
          if (fallback && !tried.some((m) => sameModel(m, fallback)) && !opts.isModelUnavailable?.(fallback)) {
            return { ...fallback, warning: reducedIndependence(fallback, "no distinct reviewer model is available") };
          }
          return producers.length > 0
            ? opts.routeModel?.(req.role, { exclude: tried, missionId: input.missionId })
            : undefined;
        };
        const reviewWarning = (route: ModelRoute): string | undefined =>
          route.warning ??
          (producers.some((m) => sameModel(m, route))
            ? reducedIndependence(route, "the only reviewer model left produced this work")
            : undefined);
        const notify = (summary: string): void => {
          input.onActivity?.({
            kind: "execution",
            stage: "review",
            phase: "started",
            summary,
            meaningfulProgress: false,
          });
        };
        const initial = await pickReviewer([]);
        const initialWarning = initial
          ? reviewWarning(initial)
          : "Warning: no distinct reviewer model is available; reviewing with the current worker model in a fresh session with reduced independence.";
        if (initialWarning) notify(initialWarning);
        // A reviewer model the gateway no longer serves is handed over too, and
        // every switch says whether the review is still independent.
        const takeover = await runWithModelTakeover(req, input, {
          initial,
          next: pickReviewer,
          repick: pickReviewer,
          freshSessionId: () => id("RVS"),
          context: { missionId: input.missionId, taskId: input.taskId },
          onSwitch: (_from, to) =>
            notify(
              reviewWarning(to) ??
                `Reviewer moved to ${modelKey(to)}; the review stays independent of the model that produced the work.`,
            ),
        });
        const run = takeover.run;
        // Independence is judged on the model that actually reviewed.
        const modelRoute = takeover.route;
        const independent = !!modelRoute && !reviewWarning(modelRoute);
        const outcome = withModel(outcomeOf(run), takeover.model);
        // If the reviewer emitted structured findings, normalize and surface them
        // so the completion gate can block on blocking findings. Handles three
        // shapes: a list of objects ({severity, message|summary|text}), a list of
        // plain strings (severity defaults to "warning"), and a JSON string.
        const details = run.result.details as Record<string, unknown> | undefined;
        const structured = (run.structured ?? details) as Record<string, unknown> | undefined;
        const raw = structured?.findings;
        outcome.findings = normalizeFindings(raw);
        const verdict = structured?.verdict;
        let outputValid =
          (verdict === "approve" || verdict === "request_changes") &&
          Array.isArray(raw) &&
          raw.every(validRawReviewFinding) &&
          Array.isArray(structured?.missingTests) &&
          structured.missingTests.every(validRawMissingTest) &&
          Array.isArray(structured?.specGaps) &&
          structured.specGaps.every(validRawSpecGap) &&
          !!modelRoute;
        const supplemental = [
          ...(Array.isArray(structured?.missingTests) ? structured.missingTests : []),
          ...(Array.isArray(structured?.specGaps) ? structured.specGaps : []),
        ];
        outcome.findings.push(
          ...supplemental.map((entry) => {
            const record = entry as Record<string, unknown>;
            return { severity: record.severity, summary: record.description ?? record.detail ?? record.requirement };
          }),
        );
        const normalizedFindings = outcome.findings.flatMap((finding) => {
          try {
            return [
              {
                severity: normalizeReviewSeverity(finding.severity),
                summary: String(finding.summary ?? "review finding"),
                status: finding.status === "resolved" ? ("resolved" as const) : ("open" as const),
              },
            ];
          } catch {
            outputValid = false;
            return [];
          }
        });
        let acceptanceResults: ReturnType<typeof validateAcceptanceResults> = [];
        try {
          acceptanceResults = validateAcceptanceResults(
            structured?.acceptanceResults,
            (input.acceptanceCriteria ?? []).map((criterion) => criterion.acceptanceId),
          );
        } catch {
          outputValid = false;
        }
        const artifactEvidence = await artifactContentHashes(opts.artifacts, outcome.artifactRefs);
        outcome.reviewEvidence = {
          reviewerSessionId: req.sessionId ?? reviewerSessionId,
          model: modelRoute?.id ?? "",
          provider: modelRoute?.provider ?? "",
          verdict: verdict === "approve" ? "approve" : "request_changes",
          independenceMode: independent ? "independent" : "same_model_reduced",
          findings: normalizedFindings,
          outputValid,
          accessible: artifactEvidence.allAccessible,
          acceptanceResults,
        };
        outcome.artifactHashes = artifactEvidence.hashes;
        return outcome;
      },
    },
    process: {
      async runProcess(input: {
        repoId?: string;
        objective: string;
        worktree?: string | null;
        signal: AbortSignal;
      }): Promise<ExecutionOutcome> {
        // Deterministic process execution falls back to verification-style
        // commands; a generic subprocess runner can be attached here later.
        input.signal.throwIfAborted();
        const cwd = input.worktree ?? (await repository(input.repoId)).cwd;
        const profile = await opts.verifier.detect(cwd);
        input.signal.throwIfAborted();
        const outcome = await opts.verifier.run(cwd, profile, opts.artifacts, { signal: input.signal });
        return {
          executionId: "process",
          exitStatus: outcome.passed ? "succeeded" : "failed",
          summary: outcome.passed ? "process completed" : "process failed",
          artifactRefs: outcome.evidence.flatMap((e) => e.artifacts).filter(Boolean),
          usage: {},
        };
      },
    },
    integration: {
      candidateScoped: true,
      async runIntegration(input: {
        repoId?: string;
        objective: string;
        handoffs: IntegrationHandoff[];
        candidate?: WorktreeInfo;
        candidateLifecycle?: CandidateLifecycle;
        integrationRun?: IntegrationRunRecord;
        authority?: import("./ownership.ts").DispatchAuthority;
        signal: AbortSignal;
      }): Promise<ExecutionOutcome> {
        input.signal.throwIfAborted();
        const repo = await repository(input.repoId);
        if (!repo.git)
          return {
            executionId: "integration",
            exitStatus: "failed",
            summary: "no git provider",
            artifactRefs: [],
            usage: {},
          };
        if (input.repoId && !input.candidate) {
          throw new Error("CANDIDATE_UNAVAILABLE: integration cannot fall back to the incumbent checkout");
        }
        // Integrator (spec 05): merge each worker worktree branch into an
        // ISOLATED worktree, then run integration checks there. Integration MUST
        // never merge into the incumbent/shared checkout's branch (AGENTS.md
        // no-direct-to-main; INV-004 isolation). Candidate-scoped missions pass
        // an existing candidate worktree; the legacy in-process path (no
        // candidate) previously merged into the current checkout's main and
        // dirtied the shared local main — now it gets a dedicated integration
        // worktree from HEAD instead, and the integration branch is the
        // deliverable.
        //
        // Recovered work (from a timed-out execution) merges its exact worker
        // commit, and a conflict on it is reported but does not fail the
        // integration: the branch stays preserved, and clean work is not held
        // hostage by a half-finished run.
        const merged: string[] = [];
        const recovered: string[] = [];
        const conflicts: string[] = [];
        const skippedRecovered: string[] = [];
        const base = await repo.git.headCommit();
        const integrationWt = input.candidate
          ? undefined
          : await repo.git.createWorktree(base, `pi-eng-integrate-${base.slice(0, 7)}-${Date.now().toString(36)}`);
        const target = input.candidate ?? integrationWt;
        if (!target) {
          return {
            executionId: "integration",
            exitStatus: "failed",
            summary: "no isolated integration target available",
            artifactRefs: [],
            usage: {},
          };
        }
        try {
          for (const [sequence, h] of input.handoffs.entries()) {
            input.signal.throwIfAborted();
            const r = await repo.git
              .mergeRefInWorktree(
                target,
                h.ref ?? h.worktree.branch,
                input.authority,
                input.candidateLifecycle,
                sequence,
                {},
                input.integrationRun,
              )
              .catch((e: Error) => ({
                merged: false,
                reason: e.message,
              }));
            input.signal.throwIfAborted();
            const reason = `${h.worktree.branch}: ${(r as { reason?: string }).reason ?? "conflict"}`;
            if (r.merged) (h.recovered ? recovered : merged).push(h.worktree.branch);
            else (h.recovered ? skippedRecovered : conflicts).push(reason);
          }
          const recoveredNote =
            (recovered.length ? `; recovered from timed-out execution(s): ${recovered.join(", ")}` : "") +
            (skippedRecovered.length
              ? `; recovered work NOT merged (kept on its branch): ${skippedRecovered.join("; ")}`
              : "");
          if (conflicts.length > 0) {
            return {
              executionId: "integration",
              exitStatus: "conflict",
              summary: `integration conflicts: ${conflicts.join("; ")}${recoveredNote}`,
              artifactRefs: [],
              usage: { mergedBranches: merged.length + recovered.length, conflicts: conflicts.length },
            };
          }
          input.signal.throwIfAborted();
          const candidateCwd = target.path;
          if (input.candidateLifecycle) {
            await repo.git.beginCandidateCheck(
              input.candidateLifecycle,
              "integration-verifier",
              input.authority,
              input.integrationRun,
            );
          }
          const checks = await opts.verifier.detect(candidateCwd);
          input.signal.throwIfAborted();
          const result = await opts.verifier.run(candidateCwd, checks, opts.artifacts, { signal: input.signal });
          if (input.candidateLifecycle) {
            await repo.git.completeCandidateCheck(
              input.candidateLifecycle,
              "integration-verifier",
              result.passed,
              input.authority,
              input.integrationRun,
            );
          }
          const artifactRefs = result.evidence.flatMap((e) => e.artifacts).filter(Boolean);
          const artifactState = await artifactContentHashes(opts.artifacts, artifactRefs);
          return {
            executionId: "integration",
            exitStatus: result.passed ? "succeeded" : "failed",
            summary: `integrated ${merged.join(", ") || "nothing"}${recoveredNote} into ${target.branch}; checks: ${result.passed ? "pass" : "fail"}`,
            artifactRefs,
            artifactHashes: artifactState.hashes,
            usage: {
              mergedBranches: merged.length + recovered.length,
              conflicts: conflicts.length,
              integrationBranch: target.branch,
            },
          };
        } finally {
          // Keep the integration branch (it is the deliverable); remove only the
          // worktree directory we created.
          if (integrationWt) {
            await repo.git.removeWorktree(integrationWt, { keepBranch: true }).catch(() => {});
          }
        }
      },
    },
  };
}
