/**
 * `pi-engineering plan --store <dir>`: the standalone planning entry (T03).
 *
 * Unlike `mission submit` (the AutoSpec-gated external contract in
 * externalEntry.ts, off unless PI_AUTOSPEC_ENABLED), this needs no flag and no
 * external system. It takes a local goal, builds the plan, assesses
 * complexity/risk, applies the skip | offer | require plan-review policy and
 * records every step in the mission store. It stops BEFORE any worker is
 * spawned and reports whether implementation may start.
 *
 *   pi-engineering plan --store <dir> [--review skip|offer|require --reason <why> [--operator <name>]]
 *     stdin: {goal, title?, repository?, baseRef?, idempotencyKey?, tasks?}
 *
 * No network, no AutoSpec, GitHub, Herdr or InferWeave. Plannotator is optional
 * and reached only through an injected adapter; the CLI configures none, so
 * `require` without one blocks (fail closed) and `offer` records the skip.
 * Exit codes: 0 may proceed, 1 blocked, 2 invalid request, 3 store error.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHerdrPlannotatorTransport } from "../platform/HerdrPlannotatorTransport.ts";
import { PlannotatorAdapter } from "../platform/Plannotator.ts";
import { JsonlEventStore } from "../platform/eventstore/jsonl.ts";
import { assertRootMissionAllowed } from "./missionMode.ts";
import { MissionStore } from "./missionStore.ts";
import type { PlanTaskInput } from "./orchestrator.ts";
import {
  PLAN_REVIEW_MODES,
  type PlanLedger,
  type PlanReviewMode,
  type PlanReviewPolicyConfig,
  PlanReviewPolicyError,
  canonicalPlanText,
} from "./planRecords.ts";
import { type PlanGateInput, type PlanGateResult, gatePlanBeforeWorkers } from "./planReview.ts";
import { loadPlanReviewSettings } from "./planReviewConfig.ts";

export interface StandalonePlanIo {
  write?: (text: string) => void;
  error?: (text: string) => void;
}

export interface StandalonePlanDeps
  extends Pick<PlanGateInput, "adapter" | "emitter" | "replan" | "now" | "maxRevisions"> {
  /** Policy modes by risk class; the CLI flags add an override on top. */
  policy?: PlanReviewPolicyConfig;
  /** Directory whose `.pi/engineering.yaml` is the repo layer (default: the process cwd). */
  cwd?: string;
}

const USAGE =
  "usage: pi-engineering plan --store <dir> [--review skip|offer|require --reason <why> [--operator <name>]] [--plannotator-command <abs path>]   (JSON request on stdin)\n";

class RequestError extends Error {}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new RequestError(`${name} needs a value`);
  return v;
}

/** One implementer task for the goal: the deterministic standalone default (no model call). */
export function singleTaskPlan(goal: string): PlanTaskInput {
  return {
    kind: "agent",
    role: "implementer",
    objective: goal,
    mutates_repo: true,
    write_domains: ["**"],
    isolation: "worktree",
    depends_on: [],
    priority: 0,
    execution_requirements: {},
    acceptance_ids: [],
    deliverables: ["implementation", "targeted-tests"],
    checkpoint_policy: { activity_milestone: 5, before_deadline_ms: 30_000 },
    max_attempts: 3,
    failure_policy: "retry",
  };
}

function parseTasks(raw: unknown, goal: string): PlanTaskInput[] {
  if (raw === undefined) return [singleTaskPlan(goal)];
  if (!Array.isArray(raw) || raw.length === 0) throw new RequestError("tasks must be a non-empty array");
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object") throw new RequestError(`tasks[${i}] must be an object`);
    const t = entry as Record<string, unknown>;
    if (typeof t.objective !== "string" || !t.objective.trim())
      throw new RequestError(`tasks[${i}].objective is required`);
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const mutates = t.mutates_repo !== false;
    return {
      ...singleTaskPlan(t.objective),
      ...(typeof t.task_id === "string" ? { task_id: t.task_id } : {}),
      role: typeof t.role === "string" ? t.role : mutates ? "implementer" : "investigator",
      mutates_repo: mutates,
      write_domains: mutates ? (strings(t.write_domains).length ? strings(t.write_domains) : ["**"]) : [],
      isolation: mutates ? "worktree" : "none",
      depends_on: strings(t.depends_on),
      acceptance_ids: strings(t.acceptance_ids),
    } as PlanTaskInput;
  });
}

/** Run the plan gate against a store and return the structured result. Library entry point. */
const REQUEST_HASH_PREFIX = "__pi_request_hash:";

export async function planStandalone(
  store: MissionStore & PlanLedger,
  request: { missionId: string; goal: string; tasks: PlanTaskInput[] },
  deps: StandalonePlanDeps = {},
): Promise<PlanGateResult> {
  return gatePlanBeforeWorkers({
    ...deps,
    ...(deps.policy ? { policy: deps.policy } : {}),
    missionId: request.missionId,
    goal: request.goal,
    plan: async () => request.tasks,
    // Bind the gate to the plan that will actually run.
    current: request.tasks,
    ledger: store,
  });
}

export async function runStandalonePlan(
  argv: string[],
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
  io: StandalonePlanIo = {},
  deps: StandalonePlanDeps = {},
): Promise<number> {
  // Optional AutoSpec DAG source (T04): loaded only when asked for, and refused
  // unless autospec.dag.enabled is set in Pi's own config.
  if (argv.includes("--from-autospec")) {
    const { runAutoSpecPlan } = await import("../integrations/autospec/planCli.ts");
    return runAutoSpecPlan(argv, env, io, deps);
  }
  const out = io.write ?? ((t: string) => process.stdout.write(t));
  const err = io.error ?? ((t: string) => process.stderr.write(t));

  let dir: string;
  let body: Record<string, unknown>;
  let policy: PlanReviewPolicyConfig | undefined = deps.policy;
  let pluggedAdapter: PlannotatorAdapter | undefined;
  try {
    assertRootMissionAllowed(env);
    const store = flag(argv, "--store");
    if (!store) throw new RequestError("--store <dir> is required");
    dir = resolve(store);
    const parsed: unknown = JSON.parse(stdin);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new RequestError("the request must be a JSON object");
    body = parsed as Record<string, unknown>;
    const command = flag(argv, "--plannotator-command");
    if (command !== undefined) {
      pluggedAdapter = new PlannotatorAdapter({
        transport: createHerdrPlannotatorTransport({ command }),
        requireDigestEcho: true,
      });
    }
    const review = flag(argv, "--review");
    if (review !== undefined) {
      if (!PLAN_REVIEW_MODES.includes(review as PlanReviewMode))
        throw new RequestError(`--review must be one of ${PLAN_REVIEW_MODES.join("|")}`);
      policy = {
        ...policy,
        override: {
          mode: review as PlanReviewMode,
          reason: flag(argv, "--reason") ?? "",
          operator: flag(argv, "--operator"),
        },
      };
    }
  } catch (error) {
    err(
      `${error instanceof SyntaxError ? "the request on stdin is not valid JSON" : (error as Error).message}\n${USAGE}`,
    );
    return 2;
  }
  if (typeof body.goal !== "string" || !body.goal.trim()) {
    err(`goal is required\n${USAGE}`);
    return 2;
  }
  const goal = body.goal;
  let tasks: PlanTaskInput[];
  try {
    tasks = parseTasks(body.tasks, goal);
  } catch (error) {
    err(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const key = typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : goal;
  const missionId = `MSN-local-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
  // The whole submitted request, canonically: the same key must mean the same request.
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify([
        canonicalPlanText(goal, tasks),
        body.title ?? null,
        body.repository ?? null,
        body.baseRef ?? null,
      ]),
    )
    .digest("hex");
  const hashSentinel = `${REQUEST_HASH_PREFIX}${requestHash}`;

  let backend: JsonlEventStore;
  try {
    await mkdir(dir, { recursive: true });
    backend = await JsonlEventStore.open(join(dir, "orchestration.jsonl"));
  } catch (error) {
    err(`cannot open the store in ${dir}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
  try {
    const store = MissionStore.open(backend);
    if (!store.getMission(missionId)) {
      store.createMission({
        mission_id: missionId,
        title: typeof body.title === "string" && body.title ? body.title : goal.slice(0, 80),
        goal,
        user_request: goal,
        repository: typeof body.repository === "string" && body.repository ? body.repository : ".",
        base_ref: typeof body.baseRef === "string" && body.baseRef ? body.baseRef : "HEAD",
        constraints: [hashSentinel],
        risk_profile: "medium",
        workflow_class: "engineering",
      });
    } else if (!store.getMission(missionId)?.constraints.includes(hashSentinel)) {
      // Reusing a key with a different request must not return the first plan's go-ahead.
      err(
        "IDEMPOTENCY_CONFLICT: this idempotencyKey (or goal) was already used with a different request; use a new idempotencyKey for a changed plan\n",
      );
      out(
        `${JSON.stringify({ result: "conflict", code: "IDEMPOTENCY_CONFLICT", missionId, reason: "the idempotency key belongs to a different request" })}\n`,
      );
      return 2;
    }
    let result: PlanGateResult;
    let notes: string[] = [];
    try {
      const configured =
        deps.adapter === undefined && deps.policy === undefined && !pluggedAdapter
          ? await loadPlanReviewSettings(deps.cwd ?? process.cwd(), { env })
          : null;
      notes = configured?.configNotes ?? [];
      const fromConfig: PlanReviewPolicyConfig | undefined = configured?.policy;
      const mergedPolicy: PlanReviewPolicyConfig | undefined =
        policy || fromConfig
          ? { ...fromConfig, ...policy, ...(policy?.override ? { override: policy.override } : {}) }
          : undefined;
      result = await planStandalone(
        store,
        { missionId, goal, tasks },
        {
          ...deps,
          ...(mergedPolicy ? { policy: mergedPolicy } : {}),
          ...(pluggedAdapter
            ? { adapter: pluggedAdapter }
            : configured?.adapter
              ? { adapter: configured.adapter }
              : {}),
          ...(configured?.maxRevisions ? { maxRevisions: configured.maxRevisions } : {}),
        },
      );
    } catch (error) {
      if (error instanceof PlanReviewPolicyError) {
        err(`${error.message}\n${USAGE}`);
        return 2;
      }
      throw error;
    }
    await store.flush();
    out(
      `${JSON.stringify({
        result: result.status === "proceed" ? "may_proceed" : "blocked",
        missionId,
        revision: result.revision,
        planDigest: result.planDigest,
        riskClass: result.riskClass,
        complexityScore: result.complexityScore,
        mode: result.mode,
        tasks: tasks.map((t, i) => ({
          taskId: t.task_id ?? `t${i + 1}`,
          role: t.role,
          mutates: t.mutates_repo,
          writeDomains: t.write_domains,
        })),
        ...(notes.length ? { configNotes: notes } : {}),
        ...(result.status === "proceed"
          ? { outcome: result.outcome, taskCount: result.tasks.length }
          : { code: result.code }),
        reason: result.reason,
      })}\n`,
    );
    return result.status === "proceed" ? 0 : 1;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  } finally {
    backend.close();
  }
}
