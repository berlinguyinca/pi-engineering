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
import { modelFamily, sameFamily as sameFamilyId } from "../capability/modelRecord.ts";
import {
  type RegistryModel,
  filterEnabledModels,
  rankRegistryModels,
  registryModelSupportsRole,
} from "../capability/registryCandidates.ts";
import { ROLE_REQUIREMENTS, routerRoleFor } from "../capability/roles.ts";
import { id } from "../core/ids.ts";
import { ROLE_BUDGETS } from "../core/types.ts";
import type { CandidateLifecycle, GitRepo, IntegrationRunRecord } from "../git/GitRepo.ts";
import type { WorktreeInfo } from "../git/GitRepo.ts";
import {
  type CitationReport,
  citationSummary,
  fileSystemReader,
  gitObjectReader,
  resolveCitations,
} from "../ledger/citations.ts";
import { type ModelRef, modelKey } from "../lifecycle/types.ts";
import type { MissionBuildOptions } from "../resources/buildBudget.ts";
import {
  NO_TARGETS_WARNING,
  type VerificationProvider,
  type VerifyOutcome,
  type VerifyRunOptions,
} from "../verify/Verifier.ts";
import { subtractBaselineFailures } from "../verify/baselineSubtraction.ts";
import { hasCachedVerification, verifyOnce } from "../verify/resultCache.ts";
import type { TestQuarantine } from "../verify/testQuarantine.ts";
import { MODEL_SUPERSEDED } from "../workers/WorkerExecutor.ts";
import type { WorkerActivity, WorkerExecutor, WorkerRequest, WorkerRun } from "../workers/WorkerExecutor.ts";
import {
  type CheckpointRecoveryContext,
  type ExecutionOutcome,
  type IntegrationHandoff,
  VERIFY_CACHE_NOTICE,
  workerTimeoutMs,
} from "./broker.ts";
import { normalizeReviewSeverity, validateAcceptanceResults } from "./evidence.ts";
import { INVALID_WORKER_OUTPUT_PREFIX } from "./recovery.ts";
import { guardReviewWorktree } from "./reviewGuard.ts";

/** What a verification run concluded, in the shape the result cache stores. */
interface JudgedVerification {
  passed: boolean;
  outcome: VerifyOutcome;
  warnings: string[];
  inheritedFailures: string[];
}

export interface RealBackendsOptions {
  /**
   * Per-mission build directories and disk admission for mission verification
   * (src/resources/buildBudget.ts). Every mission verify stage run through
   * these backends gets the mission id plus these options.
   */
  build?: Omit<MissionBuildOptions, "executionId">;
  /**
   * Stall quarantine for mission verification: a stage that stalls twice with
   * the same signature is quarantined and later outcomes that depend on it are
   * `blocked` (src/verify/testQuarantine.ts, issue #260).
   */
  quarantine?: TestQuarantine;
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
   * Every model the session registry can serve. When routing offers a gate
   * role nothing usable (no repo policy, or its candidates are tried or on an
   * unreachable provider), the role is placed from here.
   */
  registryModels?: () => Promise<readonly RegistryModel[]> | readonly RegistryModel[];
  /** Pi's `enabledModels` globs: the registry fallback stays inside them while any model matches. */
  enabledModels?: () => readonly string[] | undefined;
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
  /** The operator pin ("provider/id") not used for this role, if any. */
  pinRefused?: string;
  /** Operator-visible reason the pin could not place this role. */
  pinNotice?: string;
  /** Why this role was placed from the model registry instead of by routing. */
  registryNotice?: string;
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
  /**
   * The task's required model ("provider/id") from its execution requirements
   * (P3). Wins over role pins and ranking, but below the operator's live pin;
   * an unserviceable requirement degrades to normal routing, never fails.
   */
  taskOverride?: string;
  /** Hard capability requirements from the task's execution requirements (P3). */
  extraRequires?: string[];
}

/** Resolve a worker role to a model placement, or undefined for the executor default. */
export type RouteModel = (role: string, opts?: RouteModelOptions) => Promise<ModelRoute | undefined>;

/**
 * Worker failure markers for a model that is not served: a gateway 404
 * model_not_found (`transient:model_unavailable`) or a model pruned from the
 * local model runtime (`unknown-model`). Both hand the attempt to another model.
 */
/**
 * Mission implementer/repair tools: Pi's file tools (line-numbered `read`,
 * whitespace-tolerant `edit`, `write`) plus search. No ledger/artifact tools and
 * no `checkpoint_progress`: `claim_deliverable` names only the deliverable and
 * the broker derives sha and paths from the branch.
 */
export const IMPLEMENTER_TOOLS: readonly string[] = [
  "read",
  "edit",
  "write",
  "bash",
  "repo_search",
  "tests_for",
  "claim_deliverable",
];

/** Reviewer tools: the evidence tools, search, and `read`/`bash` to inspect files around the diff. */
const REVIEWER_TOOLS: string[] = ["ledger_read", "artifact_read", "repo_search", "symbol", "read", "bash"];

/**
 * Criteria have no kind field, so "test-like" is a heuristic over the criterion:
 * its text starts with the word "test"/"tests" ("Tests must cover ..."), or its
 * ID has a word-bounded "test" part (TEST-1, AC-TEST-1, ac_tests_2; not
 * AC-LATEST-1 or AC-CONTEST). The heuristic only selects candidates. The real
 * guard is the run itself: see `testStageRan`.
 */
const TEST_LIKE_CRITERION_TEXT = /^\s*tests?\b/i;
const TEST_LIKE_CRITERION_ID = /^tests?(?:[-_]|$)|[-_]tests?(?:[-_]|$)/i;
/** A verifier stage that runs tests: `test`, `test:unit`, `unit-tests`, `spec`, `jest`, `vitest`, `pytest`. */
const TEST_STAGE_NAME = /(?:^|[-_:.\s])(?:tests?|specs?|jest|vitest|pytest|e2e)(?:$|[-_:.\s])/i;

/** True when at least one passed stage of the run executes tests (typecheck/lint/build do not count). */
function testStageRan(stages: Array<{ stage: { name: string }; passed: boolean }>): boolean {
  return stages.some((run) => run.passed && TEST_STAGE_NAME.test(run.stage.name));
}

export function testCriteriaPassed(
  criteria: Array<{ acceptanceId: string; criterion: string }>,
  stages: Array<{ stage: { name: string }; passed: boolean }>,
  inheritedFailures: readonly unknown[],
): Array<{ acceptanceId: string; status: "passed"; detail: string }> {
  if (inheritedFailures.length > 0 || !testStageRan(stages)) return [];
  const names = stages
    .filter((run) => run.passed && TEST_STAGE_NAME.test(run.stage.name))
    .map((run) => run.stage.name)
    .join(", ");
  return criteria
    .filter((c) => TEST_LIKE_CRITERION_TEXT.test(c.criterion) || TEST_LIKE_CRITERION_ID.test(c.acceptanceId))
    .map((c) => ({
      acceptanceId: c.acceptanceId,
      status: "passed" as const,
      detail: `test stage(s) passed in the verification run: ${names}`,
    }));
}

const MODEL_GONE_MARKERS: ReadonlySet<string> = new Set(["transient:model_unavailable", "unknown-model"]);

/**
 * Worker failure markers for a model that is temporarily unable to serve:
 * the gateway reports no capacity free (its `capacity_unavailable` / queue
 * deadline, which it may tell us to retry on an alternate deployment) or the
 * provider has no worker/route for this model right now. Unlike
 * MODEL_GONE_MARKERS this does NOT remove the model from routing for a TTL:
 * capacity is transient, so other workers and later attempts may still use it.
 * We move THIS attempt to the next comparable model rather than fail it on a
 * saturated one.
 */
const MODEL_CAPACITY_MARKERS: ReadonlySet<string> = new Set(["transient:server_unavailable"]);

/**
 * A server that cannot compile the request's tool schema into a sampling
 * grammar (llama.cpp: "Failed to initialize samplers: failed to parse grammar")
 * refuses it with a 400 on every attempt. That is a property of the route, not
 * a defect in the work: it is never retried there and hands over to the next.
 */
/** Provider-side failures a reviewer fails over on: an unreachable host, a 5xx, a timeout. */
const PROVIDER_FAULT_MARKERS: ReadonlySet<string> = new Set([
  "transient:network",
  "transient:server_error",
  "transient:timeout",
]);

const PROVIDER_REQUEST_REFUSAL = /failed to parse grammar|failed to initialize samplers/i;

/**
 * An "invalid model name" refusal comes from one route of the gateway (the
 * multimodal one), so it is specific to the request: hand the attempt over,
 * but do not mark the model unavailable for every other worker.
 */
const REQUEST_SPECIFIC_REFUSAL = /invalid model name/i;

/** Stands in for the session default of a run that names no model. */
const UNNAMED_MODEL: ModelRef = { provider: "session", id: "default" };

/** How long a provider that refused connections is skipped when choosing a reviewer. */
const UNREACHABLE_PROVIDER_COOLDOWN_MS = 5 * 60_000;

const sameModel = (a: ModelRef, b: ModelRef): boolean => modelKey(a) === modelKey(b);

/**
 * Reviewer independence is a property of the model FAMILY: two ids of one
 * family are one author. A model whose family cannot be established counts as
 * the same family, so it is never recorded as independent.
 */
const sameFamily = (a: ModelRef, b: ModelRef): boolean => sameFamilyId(a.id, b.id);

/** Upper bound on routed candidates examined while looking for a different family. */
const MAX_FAMILY_PROBES = 16;

/** Bound a takeover even when refreshed discovery keeps returning new failing models. */
const MAX_MODEL_TAKEOVER_ATTEMPTS = 16;

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
  if (!model) return outcome;
  const unnamed = !outcome.usage?.model || outcome.usage.model === "unknown";
  return {
    ...outcome,
    model: { provider: model.provider, id: model.id },
    ...(unnamed ? { usage: { ...outcome.usage, model: modelKey(model) } } : {}),
  };
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

/** No review was dispatched: keep this a routing failure rather than a candidate defect. */
function unavailableReviewer(role: string): WorkerRun {
  return {
    result: {
      status: "blocked",
      summary: `Review blocked: no eligible ${role} model satisfies the configured routing requirements.`,
      error: "transient:model_unavailable",
      claims: [],
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
      details: {},
    },
    usage: null,
  };
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
      // A failed run has no usage; it still names the model it attempted.
      model: result.usage?.model ?? (ranOn(result) ? modelKey(ranOn(result) as ModelRef) : "unknown"),
    },
  };
  // Surface the worker's machine-readable failure marker (e.g.
  // `transient:server_unavailable`) so the scheduler can classify a non-throwing
  // failure and route a transient infrastructure failure into the time-based
  // resilience window instead of immediately failing the task.
  if (!completed) outcome.error = result.result.error ?? result.result.summary;
  // A deliberate `partial` report keeps its done list so the broker can
  // checkpoint it instead of treating the run as a plain failure.
  const details = result.result.details as
    | { partial?: unknown; done?: unknown; already_satisfied?: { reason?: unknown; proof?: unknown } }
    | undefined;
  if (!completed && result.result.status === "blocked" && details?.partial === true) {
    outcome.partial = {
      done: Array.isArray(details.done) ? details.done.filter((d): d is string => typeof d === "string") : [],
    };
  }
  // An `already_satisfied` no-op is a RESULT, not a failure, so it must survive
  // into durable state; the worker guard already refuses an assertion without
  // both fields, and the tool trims them, so re-checking here only guards
  // against a backend that produced the shape by some other route.
  const asserted = details?.already_satisfied;
  if (completed && typeof asserted?.reason === "string" && typeof asserted.proof === "string") {
    const reason = asserted.reason.trim();
    const proof = asserted.proof.trim();
    if (reason && proof) outcome.alreadySatisfied = { reason, proof };
  }
  if (result.toolCalls !== undefined) outcome.toolCalls = result.toolCalls;
  return outcome;
}

export function realBackends(opts: RealBackendsOptions) {
  /** The mission id and build options every mission verify stage run is given (R-BUILD wiring). */
  const missionBuild = (missionId: string | undefined): Pick<VerifyRunOptions, "missionId" | "build"> =>
    missionId ? { missionId, ...(opts.build ? { build: opts.build } : {}) } : {};
  /** The quarantine every mission verify run is judged by. Base (baseline) runs are not: they describe the base commit. */
  const quarantined: Pick<VerifyRunOptions, "quarantine"> = opts.quarantine ? { quarantine: opts.quarantine } : {};
  /** Providers that refused connections, with the time their cooldown ends. */
  const unreachableProviders = new Map<string, number>();
  const cooling = (provider: string): boolean => {
    const until = unreachableProviders.get(provider);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    unreachableProviders.delete(provider);
    return false;
  };
  /**
   * Place a role on the best live model of the session registry: not excluded,
   * not on a provider cooling after refused connections, not recorded
   * unavailable; different family from the producers first, then larger context.
   */
  const registryRoute = async (
    role: string,
    exclude: readonly ModelRef[],
    producers: readonly ModelRef[],
    extraRequires: readonly string[] = [],
  ): Promise<ModelRoute | undefined> => {
    let models: readonly RegistryModel[];
    try {
      models = (await opts.registryModels?.()) ?? [];
    } catch {
      return undefined;
    }
    const live = models.filter(
      (model) => !opts.isModelUnavailable?.(model) && registryModelSupportsRole(model, role, extraRequires),
    );
    const patterns = opts.enabledModels?.();
    const scoped = filterEnabledModels(live, patterns);
    const rank = (pool: readonly RegistryModel[]) =>
      rankRegistryModels(pool, { exclude, producers, skipProvider: cooling })[0];
    let best = rank(scoped);
    let outside = "";
    if (!best && scoped.length < live.length) {
      best = rank(live);
      outside = `; nothing enabled by ${patterns?.join(", ")} is live`;
    }
    if (!best) return undefined;
    const coolingProviders = [...new Set(models.map((model) => model.provider))].filter(cooling);
    const why = coolingProviders.length > 0 ? ` (${coolingProviders.join(", ")} on cooldown)` : "";
    return {
      provider: best.provider,
      id: best.id,
      registryNotice: `${role}: no routing candidate; chose ${modelKey(best)} from the model registry${why}${outside}`,
    };
  };
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
  /**
   * Place the attempt on `route` and arm the operator-switch check for it: the
   * attempt is superseded when the mission's pin names a model other than the
   * one this attempt runs on — unless the router already refused that pin for
   * this role, or the pin was cleared (a running attempt is not restarted just
   * to return to automatic routing).
   */
  const arm = (
    req: WorkerRequest,
    route: ModelRoute | undefined,
    missionId: string | undefined,
    unservable: string | null = null,
  ): void => {
    if (route) req.modelOverride = { provider: route.provider, id: route.id };
    else delete req.modelOverride;
    req.operatorPinned = route?.operatorPin === true;
    if (!missionId || !opts.currentOperatorPin) return;
    const running = route ? modelKey(route) : null;
    const refused = route?.pinRefused ?? unservable;
    req.modelSuperseded = () => {
      const selected = opts.currentOperatorPin?.(missionId);
      // Registry fallbacks have no router pinRefused metadata. A confirmed
      // unavailable pin is still the failed choice, not a new operator switch.
      if (!selected || opts.isModelUnavailable?.(selected)) return false;
      const pin = modelKey(selected);
      return pin !== running && pin !== refused;
    };
  };
  const requiresReviewRoute = (role: string): boolean => {
    const routerRole = routerRoleFor(role);
    return !!(opts.routeModel || opts.registryModels) && !!routerRole && ROLE_REQUIREMENTS[routerRole].independent;
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
      /**
       * Hand the attempt to the next route when the provider fails it (an
       * unreachable host, a 5xx, or a 400 whose grammar/sampler/schema the
       * server cannot compile) instead of failing the task on that route.
       */
      failoverOnProviderError?: boolean;
      /** Told when a model's provider refused the connection with no output, so routing can avoid it for a while. */
      onProviderUnreachable?: (model: ModelRef) => void;
      /**
       * Implementer work: an attempt that failed on the provider before any
       * tool call ran has no side effects, so it moves to another eligible
       * model, unless the operator pinned this one (the pin is then waited
       * on by the scheduler, not abandoned).
       */
      failoverWhenNoToolCalls?: boolean;
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
    if (!route && requiresReviewRoute(req.role)) return { run: unavailableReviewer(req.role), route };
    if (plan.announceWarnings && route?.warning) announce(route.warning);
    if (route?.pinNotice) announce(route.pinNotice);
    const switches: string[] = [];
    if (route?.registryNotice) {
      switches.push(route.registryNotice);
      announce(route.registryNotice);
    }
    arm(req, route, plan.context.missionId);
    let run = await runWorker(req, input);
    // The model the attempt ran on: the route; unrouted, the model the worker
    // names, else the session model (normally the executor's default).
    let model: ModelRef | undefined = route ?? ranOn(run) ?? opts.reviewFallbackModel;
    const tried: ModelRef[] = [];
    while (!input.signal.aborted) {
      const error = outcomeOf(run).error ?? "";
      if (error === MODEL_SUPERSEDED) {
        const next = await plan.repick(tried);
        if (!next && requiresReviewRoute(req.role)) return { run: unavailableReviewer(req.role), route: undefined };
        // The operator's choice resolves to the model already running: nothing
        // changes, so keep the session and carry on — no restart, no switch.
        if (next && route && modelKey(next) === modelKey(route)) {
          route = next;
          arm(req, route, plan.context.missionId, pinKeyOf(plan.context.missionId));
          run = await runWorker(req, input);
          model = route;
          continue;
        }
        const notice = `operator switched models — ${req.role} moves from ${model ? modelKey(model) : "the default model"} to ${next ? modelKey(next) : "automatic routing"} at this inference boundary`;
        switches.push(notice);
        announce(notice);
        if (plan.announceWarnings && next?.warning) announce(next.warning);
        if (next?.pinNotice) announce(next.pinNotice);
        if (model && next) plan.onSwitch?.(model, next);
        // Routing could not place the role on the new pin (the placement did
        // not change): run where routing says, and do not supersede again for
        // that same pin — otherwise this would spin.
        const unchanged = (next ? modelKey(next) : null) === (route ? modelKey(route) : null);
        route = next;
        req.sessionId = plan.freshSessionId();
        arm(req, route, plan.context.missionId, unchanged ? pinKeyOf(plan.context.missionId) : null);
        run = await runWorker(req, input);
        model = route ?? ranOn(run) ?? opts.reviewFallbackModel;
        continue;
      }
      // An unrouted run that names no model still failed on the provider: the
      // takeover hands it to the first eligible route rather than giving up.
      if (!model && !(plan.failoverOnProviderError === true && PROVIDER_FAULT_MARKERS.has(error))) break;
      const gone = MODEL_GONE_MARKERS.has(error);
      const noToolCalls = plan.failoverWhenNoToolCalls === true && run.toolCalls === 0;
      // An operator-pinned reviewer is waited on, not abandoned, unless its host
      // is confirmed dead (connection refused / unresolvable, zero output).
      const pinnedGateFault =
        plan.failoverOnProviderError === true &&
        req.operatorPinned === true &&
        PROVIDER_FAULT_MARKERS.has(error) &&
        !PROVIDER_REQUEST_REFUSAL.test(run.result.summary) &&
        run.result.details?.connect_refused !== true;
      const pinnedWait = (noToolCalls && req.operatorPinned === true) || pinnedGateFault;
      const capacity = !gone && !pinnedWait && MODEL_CAPACITY_MARKERS.has(error);
      const providerFault =
        !gone &&
        !capacity &&
        !pinnedWait &&
        ((plan.failoverOnProviderError === true &&
          (PROVIDER_FAULT_MARKERS.has(error) || PROVIDER_REQUEST_REFUSAL.test(run.result.summary))) ||
          (noToolCalls && PROVIDER_FAULT_MARKERS.has(error)));
      if (!gone && !capacity && !providerFault) break;
      const failed: ModelRef = model ?? UNNAMED_MODEL;
      if (providerFault && error === "transient:network" && run.toolCalls === 0 && run.result.details?.connect_level) {
        const attempted = model ?? opts.reviewFallbackModel;
        if (attempted) plan.onProviderUnreachable?.(attempted);
      }
      const reason = run.result.summary;
      // A gone model is gateway-confirmed and leaves routing for a TTL; a
      // capacity-exhausted one is transient, so it stays eligible everywhere
      // except this attempt's own walk past the tried set.
      if (gone && !REQUEST_SPECIFIC_REFUSAL.test(reason))
        opts.onModelUnavailable?.(failed, { ...plan.context, reason });
      tried.push(failed);
      if (tried.length >= MAX_MODEL_TAKEOVER_ATTEMPTS) {
        const notice = `model takeover exhausted after ${tried.length} model attempts; last failure on ${modelKey(failed)}`;
        switches.push(notice);
        announce(notice);
        break;
      }
      const next = await plan.next(tried);
      if (!next || tried.some((known) => sameModel(known, next))) break;
      const notice = providerFault
        ? `model ${modelKey(failed)} failed the request (${reason.slice(0, 200)}) — switched ${req.role} to ${modelKey(next)}`
        : gone
          ? `model ${modelKey(failed)} is no longer served — switched ${req.role} to ${modelKey(next)}`
          : `model ${modelKey(failed)} has no capacity right now — switched ${req.role} to ${modelKey(next)}`;
      switches.push(notice);
      announce(notice);
      if (next.registryNotice) {
        switches.push(next.registryNotice);
        announce(next.registryNotice);
      }
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
  const routedPlan = async (
    role: string,
    context: { missionId?: string; taskId?: string },
    prefix: string,
    /** The task's execution requirements (P3): model override + capabilities. */
    requirements?: Record<string, unknown>,
  ) => {
    // P3: the task's own routing requirement. The model override applies only
    // to the initial placement (a failed required model must not block
    // failover); capability requirements are task-intrinsic and stay in
    // effect for the whole execution. An operator switch (repick) outranks
    // the task's model override.
    const req = requirements as { model?: unknown; capabilities?: unknown } | undefined;
    const taskOverride = typeof req?.model === "string" && req.model.length > 0 ? req.model : undefined;
    const extraRequires = Array.isArray(req?.capabilities)
      ? (req.capabilities.filter((c): c is string => typeof c === "string" && c.length > 0) as string[])
      : undefined;
    const requirementOpts = {
      ...(taskOverride ? { taskOverride } : {}),
      ...(extraRequires?.length ? { extraRequires } : {}),
    };
    return {
      // An unrouted role runs on the session default; when that provider is
      // cooling, the registry places it on a live model instead.
      initial: await (async () => {
        const routed = await opts.routeModel?.(role, { missionId: context.missionId, ...requirementOpts });
        const fallback = opts.reviewFallbackModel;
        if (!routed && requiresReviewRoute(role)) return registryRoute(role, [], [], extraRequires);
        if (routed ? !cooling(routed.provider) : !fallback || !cooling(fallback.provider)) return routed;
        return (await registryRoute(role, routed ? [routed] : [], [], extraRequires)) ?? routed;
      })(),
      next: async (tried: ModelRef[]) => {
        // Failover: the required model already failed, so drop the override
        // but keep the task's capability requirements in force.
        const routed = await opts.routeModel?.(role, {
          exclude: tried,
          replacement: true,
          missionId: context.missionId,
          ...(extraRequires?.length ? { extraRequires } : {}),
        });
        if (routed && !cooling(routed.provider)) return routed;
        return (await registryRoute(role, routed ? [...tried, routed] : tried, [], extraRequires)) ?? routed;
      },
      onProviderUnreachable: (model: ModelRef) =>
        unreachableProviders.set(model.provider, Date.now() + UNREACHABLE_PROVIDER_COOLDOWN_MS),
      repick: async (tried: ModelRef[]) =>
        // An operator switch outranks the task's model override; capabilities stay.
        opts.routeModel?.(role, {
          ...(tried.length > 0 ? { exclude: tried } : {}),
          missionId: context.missionId,
          ...(extraRequires?.length ? { extraRequires } : {}),
        }),
      freshSessionId: () => id(prefix),
      context,
      announceWarnings: true,
      failoverWhenNoToolCalls: role === "implementer",
    };
  };
  return {
    agent: {
      async runAgent(input: {
        role: string;
        repoId?: string;
        objective: string;
        contextRef?: string;
        worktree?: string | null;
        isolatedWorktree?: boolean;
        assignedWorktree?: WorkerRequest["assignedWorktree"];
        modelRequirements?: Record<string, unknown>;
        recovery?: CheckpointRecoveryContext;
        deliverables?: readonly string[];
        baseRef?: string;
        wallClock?: { startedAt: number; budgetMs: number };
        missionId?: string;
        taskId?: string;
        sessionId?: string;
        signal: AbortSignal;
        onActivity?: (event: WorkerActivity) => void;
      }): Promise<ExecutionOutcome> {
        const bound = await repository(input.repoId);
        const req: WorkerRequest = {
          role: (input.role as WorkerRequest["role"]) ?? "implementer",
          missionId: input.missionId,
          baseRef: input.baseRef,
          wallClock: input.wallClock,
          task: input.objective,
          context: input.contextRef,
          tools: [...IMPLEMENTER_TOOLS],
          tolerantFileTools: true,
          cwd: input.worktree ?? bound.cwd,
          // Role budget; the executor clamps it to 70% of the routed model's
          // window and compacts at 60% of the result (issue #180).
          maxContextTokens: ROLE_BUDGETS[(input.role as WorkerRequest["role"]) ?? "implementer"]?.hardMaxTokens,
          // No duration cap: the broker owns liveness (activity-based) and any
          // opt-in limit. This only carries an explicit operator override.
          timeoutMs: workerTimeoutMs(),
          // A mission worker waits for inference capacity however long it takes.
          unboundedInferenceWait: true,
          // Only the broker's word makes a directory an isolated worktree; the
          // fallback (no worktree) runs in the user's checkout.
          isolatedWorktree: input.isolatedWorktree === true && !!input.worktree,
          assignedWorktree: input.assignedWorktree,
          recovery: input.recovery,
          deliverables: input.deliverables,
          // Every delegated implementation/recovery run is a fresh session;
          // carrying the identity through the public worker request makes its
          // separation from the later reviewer independently auditable.
          sessionId: input.sessionId ?? id("WKS"),
        };
        // Place the worker on the model the capability router chose for this
        // role (honours `policy.routing.roles`); fall back to the executor
        // default when routing is unavailable or the role is unknown.
        // A model the gateway no longer serves is handed over to the next
        // eligible one in this same execution.
        const { run, model } = await runWithModelTakeover(
          req,
          input,
          await routedPlan(
            req.role,
            { missionId: input.missionId, taskId: input.taskId },
            "WKS",
            input.modelRequirements,
          ),
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
        missionId?: string;
        taskId?: string;
        signal: AbortSignal;
        onActivity?: (event: WorkerActivity) => void;
      }): Promise<ExecutionOutcome> {
        const bound = await repository(input.repoId);
        const req: WorkerRequest = {
          role: "scout",
          missionId: input.missionId,
          task: input.objective,
          context: input.contextRef,
          tools: ["ledger_read", "repo_search", "symbol", "tests_for"],
          cwd: bound.cwd,
          unboundedInferenceWait: true,
        };
        // A scout follows the mission's operator pin like every other worker.
        const { run, model } = await runWithModelTakeover(
          req,
          input,
          await routedPlan(req.role, { missionId: input.missionId, taskId: input.taskId }, "WKS"),
        );
        return withModel(outcomeOf(run), model);
      },
    },
    validation: {
      candidateScoped: true,
      async runValidation(input: {
        missionId?: string;
        repoId?: string;
        objective: string;
        worktree?: string | null;
        /** The commit the candidate was built on; failures already red there are inherited, not introduced. */
        baseSha?: string;
        testRequirement?: string;
        acceptanceCriteria?: Array<{ acceptanceId: string; criterion: string }>;
        signal: AbortSignal;
        onActivity?: (event: WorkerActivity) => void;
      }): Promise<ExecutionOutcome> {
        input.signal.throwIfAborted();
        const repo = await repository(input.repoId);
        const cwd = input.worktree ?? repo.cwd;
        const profile = await opts.verifier.detect(cwd);
        input.signal.throwIfAborted();
        const run = async (): Promise<{ value: JudgedVerification; passed: boolean }> => {
          const firstOutcome = await opts.verifier.run(cwd, profile, opts.artifacts, {
            signal: input.signal,
            ...missionBuild(input.missionId),
            ...quarantined,
          });
          const judged = repo.git
            ? await subtractBaselineFailures({
                git: repo.git,
                verifier: opts.verifier,
                artifacts: opts.artifacts,
                baseSha: input.baseSha,
                cwd,
                profile,
                outcome: firstOutcome,
                signal: input.signal,
                runOptions: missionBuild(input.missionId),
                ...quarantined,
              })
            : undefined;
          // The judged outcome: the candidate's re-run when it had stopped at an inherited failure.
          const outcome = judged?.outcome ?? firstOutcome;
          const passed = judged ? judged.passed : outcome.passed;
          return {
            passed,
            value: {
              passed,
              outcome,
              warnings: [...(outcome.warnings ?? []), ...(judged?.warnings ?? [])],
              inheritedFailures: judged?.inheritedFailures ?? [],
            },
          };
        };
        // The suite ran at integration on this very commit: reuse that result.
        const verified = repo.git
          ? await verifyOnce(
              { cwd, commonDir: await repo.git.commonDir(), profile, baseSha: input.baseSha },
              run,
              input.signal,
            )
          : { value: (await run()).value, runId: "", reused: false };
        const { outcome, passed, warnings, inheritedFailures } = verified.value;
        if (verified.reused) {
          input.onActivity?.({
            kind: "execution",
            stage: "validation",
            phase: "started",
            summary: `${VERIFY_CACHE_NOTICE} validation reused verification run ${verified.runId} for this candidate commit`,
            meaningfulProgress: false,
          });
        }
        const artifactRefs = outcome.evidence.flatMap((e) => e.artifacts).filter(Boolean);
        const artifactState = await artifactContentHashes(opts.artifacts, artifactRefs);
        // A repo with no detectable checks: nothing ran, nothing FAILED. It
        // passes with a warning (a failure would spawn repair work no
        // implementer can satisfy) unless a criterion requires tests.
        const testsRequired = outcome.noTargets ? input.testRequirement : undefined;
        return {
          executionId: "validation",
          exitStatus: passed && !testsRequired ? "succeeded" : "failed",
          ...(testsRequired ? { error: testsRequired } : {}),
          summary: testsRequired
            ? testsRequired
            : outcome.noTargets
              ? `validation passed with warning: ${NO_TARGETS_WARNING}`
              : passed
                ? `validation passed (${outcome.stages.length} stages)${inheritedFailures.length ? `; warning: ${warnings.join("; ")}` : ""}`
                : `validation failed at ${outcome.failedStage ?? "unknown"}`,
          warnings,
          ...(inheritedFailures.length ? { inheritedFailures } : {}),
          artifactRefs,
          artifactHashes: artifactState.hashes,
          usage: { stages: outcome.stages.length },
          validationEvidence: {
            command:
              profile.stages.map((stage) => [stage.command, ...stage.args].join(" ")).join(" && ") || "<no-target>",
            profile: profile.name,
            exitCode: passed && !outcome.noTargets ? 0 : (outcome.stages.find((stage) => !stage.passed)?.exitCode ?? 1),
            testSummary: {
              ...(verified.reused ? { reused: true, originalRunId: verified.runId } : {}),
              stages: outcome.stages.map((stage) => ({
                name: stage.stage.name,
                exitCode: stage.exitCode,
                passed: stage.passed,
                durationMs: stage.durationMs,
              })),
              failedStage: outcome.failedStage,
              warnings,
              ...(inheritedFailures.length ? { inheritedFailures } : {}),
            },
            noTargets: outcome.noTargets,
            accessible: artifactState.allAccessible,
            // A suite that ran green proves the criteria that are about tests.
            acceptanceResults:
              passed && !outcome.noTargets
                ? testCriteriaPassed(input.acceptanceCriteria ?? [], outcome.stages, inheritedFailures)
                : [],
          },
        };
      },
      /** True when `runValidation` would reuse a stored integration result (review may then run alongside it). */
      async willReuse(input: { repoId?: string; worktree?: string | null; baseSha?: string }): Promise<boolean> {
        const repo = await repository(input.repoId);
        if (!repo.git || !input.worktree) return false;
        try {
          const profile = await opts.verifier.detect(input.worktree);
          return await hasCachedVerification({
            cwd: input.worktree,
            commonDir: await repo.git.commonDir(),
            profile,
            baseSha: input.baseSha,
          });
        } catch {
          return false;
        }
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
        /** The recorded candidate commit the worktree must stay on. */
        candidateSha?: string;
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
          missionId: input.missionId,
          task: `${input.objective}${(input.acceptanceCriteria ?? [])
            .map((criterion) => `\nAcceptance criterion ${criterion.acceptanceId}: ${criterion.criterion}`)
            .join("")}`,
          context: input.contextRef,
          tools: REVIEWER_TOOLS,
          cwd: input.worktree ?? bound.cwd,
          // The role's table budget; the executor clamps it to 70% of the
          // routed model's context window (issue #180), so a 32k-slot model is
          // never handed a fixed 64k.
          maxContextTokens: ROLE_BUDGETS.reviewer.hardMaxTokens,
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
        const independentOfProducers = (model: ModelRef): boolean =>
          modelFamily(model.id) !== undefined && !producers.some((m) => sameFamily(m, model));
        const fallbackEligible = async (tried: ModelRef[]): Promise<boolean> => {
          if (!fallback) return false;
          // Standalone callers keep their session default. Configured routing
          // must accept that exact model; absence of metadata is not approval.
          if (!opts.registryModels) {
            if (!opts.routeModel) return true;
            const route = await opts.routeModel(req.role, {
              exclude: tried,
              missionId: input.missionId,
              taskOverride: modelKey(fallback),
            });
            return !!route && sameModel(route, fallback);
          }
          try {
            const model = (await opts.registryModels()).find((model) => sameModel(model, fallback));
            return !!model && registryModelSupportsRole(model, req.role);
          } catch {
            return false;
          }
        };
        const pickReviewer = async (tried: ModelRef[]): Promise<ModelRoute | undefined> => {
          // Prefer a model of a different family on a reachable provider; remember
          // the first sibling of a producer's family (or unknown family), and the
          // first model of a provider that recently refused connections, in case
          // nothing better exists.
          const passedOver: ModelRef[] = [];
          let sibling: ModelRoute | undefined;
          let unreachable: ModelRoute | undefined;
          for (let probe = 0; probe < MAX_FAMILY_PROBES; probe++) {
            const candidate = await opts.routeModel?.(req.role, {
              exclude: [...producers, ...tried, ...passedOver],
              missionId: input.missionId,
            });
            if (!candidate) break;
            if (cooling(candidate.provider)) unreachable ??= candidate;
            else if (independentOfProducers(candidate)) return candidate;
            else sibling ??= candidate;
            passedOver.push({ provider: candidate.provider, id: candidate.id });
          }
          // Routing offered no independent live model: the registry may have one.
          const registry = await registryRoute(req.role, [...producers, ...tried], producers);
          if (registry && independentOfProducers(registry)) return registry;
          if (sibling) return sibling;
          if (registry) return registry;
          if (
            fallback &&
            !tried.some((m) => sameModel(m, fallback)) &&
            !opts.isModelUnavailable?.(fallback) &&
            !cooling(fallback.provider) &&
            (await fallbackEligible(tried))
          ) {
            return { ...fallback, warning: reducedIndependence(fallback, "no distinct reviewer model is available") };
          }
          if (producers.length > 0) {
            const producer = await opts.routeModel?.(req.role, { exclude: tried, missionId: input.missionId });
            if (producer && !cooling(producer.provider)) return producer;
            return unreachable ?? producer;
          }
          return unreachable;
        };
        const reviewWarning = (route: ModelRoute): string | undefined => {
          if (route.warning) return route.warning;
          if (producers.some((m) => sameModel(m, route))) {
            return reducedIndependence(route, "the only reviewer model left produced this work");
          }
          if (modelFamily(route.id) === undefined) {
            return reducedIndependence(route, "the reviewer model's family cannot be established");
          }
          return producers.some((m) => sameFamily(m, route))
            ? reducedIndependence(route, "the only reviewer models left share a model family with this work's producer")
            : undefined;
        };
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
        if (!initial && requiresReviewRoute(req.role)) return outcomeOf(unavailableReviewer(req.role));
        const initialWarning = initial
          ? reviewWarning(initial)
          : "Warning: no distinct reviewer model is available; reviewing with the current worker model in a fresh session with reduced independence.";
        if (initialWarning) notify(initialWarning);
        // A reviewer model the gateway no longer serves is handed over too, and
        // every switch says whether the review is still independent.
        // The reviewer has bash: the candidate it judges must come back untouched.
        const guard = await guardReviewWorktree(req.cwd, input.candidateSha);
        if (!guard && req.cwd) {
          input.onActivity?.({
            kind: "execution",
            stage: "review",
            phase: "started",
            summary: `Warning: ${req.cwd} is not a git checkout; the reviewer mutation guard is skipped.`,
            meaningfulProgress: false,
          });
        }
        const takeover = await runWithModelTakeover(req, input, {
          initial,
          next: pickReviewer,
          repick: pickReviewer,
          freshSessionId: () => id("RVS"),
          failoverOnProviderError: true,
          onProviderUnreachable: (model) =>
            unreachableProviders.set(model.provider, Date.now() + UNREACHABLE_PROVIDER_COOLDOWN_MS),
          context: { missionId: input.missionId, taskId: input.taskId },
          onSwitch: (_from, to) =>
            notify(
              reviewWarning(to) ??
                `Reviewer moved to ${modelKey(to)}; the review stays independent of the model that produced the work.`,
            ),
        });
        const run = takeover.run;
        if (takeover.model && run.result.status === "completed") unreachableProviders.delete(takeover.model.provider);
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
        const invalidReasons: string[] = [];
        if (verdict !== "approve" && verdict !== "request_changes") invalidReasons.push("verdict");
        if (!Array.isArray(raw) || !raw.every(validRawReviewFinding)) invalidReasons.push("findings");
        if (!Array.isArray(structured?.missingTests) || !structured.missingTests.every(validRawMissingTest))
          invalidReasons.push("missing_tests");
        if (!Array.isArray(structured?.specGaps) || !structured.specGaps.every(validRawSpecGap))
          invalidReasons.push("spec_gaps");
        outcome.findings.push(
          ...(Array.isArray(structured?.missingTests) ? structured.missingTests : []).map((entry) => {
            const record = entry as Record<string, unknown>;
            return { severity: record.severity, category: "missing_tests", summary: record.description };
          }),
          ...(Array.isArray(structured?.specGaps) ? structured.specGaps : []).map((entry) => {
            const record = entry as Record<string, unknown>;
            return { severity: record.severity, category: "spec_gaps", summary: record.detail ?? record.requirement };
          }),
        );
        const normalizedFindings = outcome.findings.flatMap((finding) => {
          try {
            return [
              {
                severity: normalizeReviewSeverity(finding.severity, finding.category),
                summary: String(finding.summary ?? "review finding"),
                status: finding.status === "resolved" ? ("resolved" as const) : ("open" as const),
              },
            ];
          } catch {
            invalidReasons.push("finding severity");
            return [];
          }
        });
        // Small models mangle IDs; a slip there must not void the whole review.
        const acceptanceWarnings: string[] = [];
        const acceptanceProblems: string[] = [];
        const acceptanceResults = validateAcceptanceResults(
          structured?.acceptanceResults,
          (input.acceptanceCriteria ?? []).map((criterion) => criterion.acceptanceId),
          { tolerant: true, warnings: acceptanceWarnings, problems: acceptanceProblems },
        );
        // An approval with no acceptance evidence is meaningless; a request_changes
        // verdict stands on its findings and stays valid whatever acceptance_results holds.
        if (acceptanceProblems.length > 0 && verdict === "approve") invalidReasons.push("acceptance_results");
        for (const warning of acceptanceWarnings) {
          normalizedFindings.push({ severity: "minor", summary: `acceptance_results: ${warning}`, status: "open" });
        }
        const mutation = guard ? await guard.check() : undefined;
        if (mutation) invalidReasons.push(mutation);
        // A `file:line` the reviewer cites is a checkable assertion about the
        // candidate, so it gets resolved against the candidate commit before the
        // verdict is recorded (issue #508). Findings and acceptance details are the
        // reviewer's assertions, so those are the texts resolved. An approval whose
        // citations do not resolve is downgraded: the review still says what it
        // found, but a guess cannot carry `approve`.
        const citationRoot = req.cwd || input.worktree || undefined;
        let citationReport: CitationReport | undefined;
        if (citationRoot) {
          const assertionText = [
            ...normalizedFindings.map((finding) => finding.summary),
            ...acceptanceResults.map((result) => result.detail),
          ].join("\n");
          const reader = input.candidateSha
            ? gitObjectReader(citationRoot, input.candidateSha)
            : fileSystemReader(citationRoot);
          citationReport = await resolveCitations(assertionText, reader, {
            atRef: input.candidateSha ?? "worktree",
          });
          if (verdict === "approve" && citationReport.unresolved.length > 0) {
            normalizedFindings.push({
              severity: "major",
              summary: `citations: ${citationSummary(citationReport)}; an approval may not rest on references that do not resolve`,
              status: "open",
            });
          }
        }
        if (guard?.removedIgnored.length) {
          input.onActivity?.({
            kind: "execution",
            stage: "review",
            phase: "started",
            summary: `Removed ignored files the reviewer's commands wrote: ${guard.removedIgnored.slice(0, 5).join(", ")}`,
            meaningfulProgress: false,
          });
        }
        const outputValid = invalidReasons.length === 0;
        const artifactEvidence = await artifactContentHashes(opts.artifacts, outcome.artifactRefs);
        outcome.reviewEvidence = {
          reviewerSessionId: req.sessionId ?? reviewerSessionId,
          model: modelRoute?.id ?? "",
          provider: modelRoute?.provider ?? "",
          verdict:
            verdict === "approve" && !(citationReport && citationReport.unresolved.length > 0)
              ? "approve"
              : "request_changes",
          independenceMode: independent ? "independent" : "same_model_reduced",
          findings: normalizedFindings,
          outputValid,
          accessible: artifactEvidence.allAccessible,
          acceptanceResults,
          ...(citationReport
            ? {
                citationReport: {
                  atRef: citationReport.atRef,
                  checked: citationReport.checked,
                  resolved: citationReport.resolved,
                  unresolved: citationReport.unresolved,
                },
              }
            : {}),
        };
        outcome.artifactHashes = artifactEvidence.hashes;
        // A review whose output could not be read says nothing about the
        // candidate: fail the attempt as an invalid gate output so the review
        // re-runs (see classifyGateFailure) instead of spawning implementer repair.
        if (!outputValid && outcome.exitStatus === "succeeded") {
          outcome.exitStatus = "failed";
          outcome.error = `${INVALID_WORKER_OUTPUT_PREFIX}: ${
            mutation ?? `the reviewer's review_result was missing or malformed (${invalidReasons.join(", ")})`
          }`;
          // An unreadable approval says nothing, so its half-parsed findings must not become
          // repair work. A request_changes verdict is the reviewer's own statement: its
          // findings stay on the mission record and drive repair even if the envelope was sloppy.
          if (verdict !== "request_changes" || mutation) outcome.findings = [];
        }
        return outcome;
      },
    },
    process: {
      async runProcess(input: {
        missionId?: string;
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
        const outcome = await opts.verifier.run(cwd, profile, opts.artifacts, {
          signal: input.signal,
          ...missionBuild(input.missionId),
          ...quarantined,
        });
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
        missionId?: string;
        repoId?: string;
        objective: string;
        handoffs: IntegrationHandoff[];
        candidate?: WorktreeInfo;
        candidateLifecycle?: CandidateLifecycle;
        integrationRun?: IntegrationRunRecord;
        authority?: import("./ownership.ts").DispatchAuthority;
        testRequirement?: string;
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
          const git = repo.git;
          const integrationBase = input.candidateLifecycle?.baseSha ?? (input.candidate ? undefined : base);
          const verified = await verifyOnce(
            { cwd: candidateCwd, commonDir: await git.commonDir(), profile: checks, baseSha: integrationBase },
            async () => {
              const firstResult = await opts.verifier.run(candidateCwd, checks, opts.artifacts, {
                signal: input.signal,
                ...missionBuild(input.missionId),
                ...quarantined,
              });
              // Failures already red on the base commit are inherited, not introduced.
              const judged = await subtractBaselineFailures({
                git,
                verifier: opts.verifier,
                artifacts: opts.artifacts,
                baseSha: integrationBase,
                cwd: candidateCwd,
                profile: checks,
                outcome: firstResult,
                signal: input.signal,
                runOptions: missionBuild(input.missionId),
                ...quarantined,
              });
              return {
                passed: judged.passed,
                value: {
                  passed: judged.passed,
                  outcome: judged.outcome,
                  warnings: [...(judged.outcome.warnings ?? []), ...judged.warnings],
                  inheritedFailures: judged.inheritedFailures,
                },
              };
            },
            input.signal,
          );
          const result = verified.value.outcome;
          const checksPassed = verified.value.passed;
          const warnings = verified.value.warnings;
          const judged = { inheritedFailures: verified.value.inheritedFailures };
          if (input.candidateLifecycle) {
            await repo.git.completeCandidateCheck(
              input.candidateLifecycle,
              "integration-verifier",
              checksPassed,
              input.authority,
              input.integrationRun,
            );
          }
          const artifactRefs = result.evidence.flatMap((e) => e.artifacts).filter(Boolean);
          const artifactState = await artifactContentHashes(opts.artifacts, artifactRefs);
          // Failure visibility: the verifier result names the failed stage (or
          // that nothing was verifiable); without it the integration failure
          // record carried only "checks: fail" and the actual cause (e.g. a
          // broken import in the worktree) was undiagnosable from the store.
          const testsRequired = result.noTargets ? input.testRequirement : undefined;
          const checkFailure =
            testsRequired ??
            (checksPassed ? undefined : `verification failed at stage: ${result.failedStage ?? "unknown"}`);
          const warningNote = warnings.length ? `; warning: ${warnings.join("; ")}` : "";
          return {
            executionId: "integration",
            exitStatus: checkFailure ? "failed" : "succeeded",
            summary: `integrated ${merged.join(", ") || "nothing"}${recoveredNote} into ${target.branch}; checks: ${checkFailure ? "fail" : "pass"}${warningNote}`,
            ...(checkFailure ? { error: checkFailure } : {}),
            noTargets: result.noTargets,
            warnings,
            ...(judged.inheritedFailures.length ? { inheritedFailures: judged.inheritedFailures } : {}),
            // The verifier ran stages and they failed: a code defect, not a merge conflict.
            ...(checkFailure && !testsRequired && !result.noTargets ? { checksFailed: true } : {}),
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
