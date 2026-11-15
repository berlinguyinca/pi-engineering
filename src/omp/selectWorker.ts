import type { WorkerExecutor, WorkerRequest, WorkerRun } from "../workers/WorkerExecutor.ts";
import { OmpWorkerExecutor, OmpWorkerUnavailable } from "./OmpWorkerExecutor.ts";
import { OMP_ADAPTER_ENV, resolveOmpAdapterConfig } from "./config.ts";
import { negotiateOmp } from "./negotiate.ts";

/** Second flag: the OMP-backed worker. Off unless set; the adapter flag must be on too. */
export const OMP_WORKER_ENV = "PI_ENGINEERING_OMP_WORKER";
export const OMP_MODEL_ENV = "PI_ENGINEERING_OMP_MODEL";
export const OMP_HOME_ENV = "PI_ENGINEERING_OMP_HOME";

const isOn = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");

export type WorkerSelection = { readonly path: "omp" } | { readonly path: "legacy"; readonly reason: string };

/** Message recorded (through `onActivity`) every time a run falls back; deterministic for a given reason. */
export const fallbackSummary = (reason: string): string =>
  `omp worker unavailable (${reason}); using legacy executor`.slice(0, 160);

/**
 * Runs on `primary`; if it reports itself unavailable before running anything,
 * runs on `legacy` instead and records why. A failure after the prompt was
 * sent is the primary's own result and is never silently re-run.
 */
export class FallbackWorkerExecutor implements WorkerExecutor {
  private readonly primary: WorkerExecutor;
  private readonly legacy: WorkerExecutor;

  constructor(primary: WorkerExecutor, legacy: WorkerExecutor) {
    this.primary = primary;
    this.legacy = legacy;
  }

  async run(req: WorkerRequest): Promise<WorkerRun> {
    try {
      return await this.primary.run(req);
    } catch (error) {
      if (!(error instanceof OmpWorkerUnavailable)) throw error;
      req.onActivity?.({ kind: "state", summary: fallbackSummary(error.detail), meaningfulProgress: false });
      return this.legacy.run(req);
    }
  }
}

/**
 * Choose the worker executor. Returns undefined when the flags are unset
 * (nothing changes). With both flags on, negotiates once; Unavailable yields
 * `legacy` plus the reason, available yields an OMP worker that still falls
 * back per run if the process cannot be started.
 */
export async function selectOmpWorker(
  makeLegacy: () => WorkerExecutor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ executor: WorkerExecutor; selection: WorkerSelection } | undefined> {
  if (!isOn(env[OMP_WORKER_ENV])) return undefined;
  const legacy = makeLegacy();
  const config = resolveOmpAdapterConfig(env);
  if (!config.enabled) {
    return { executor: legacy, selection: { path: "legacy", reason: `disabled: ${OMP_ADAPTER_ENV} not enabled` } };
  }
  const model = env[OMP_MODEL_ENV]?.trim() || undefined;
  const negotiation = await negotiateOmp({ launch: config.launch, timeoutMs: config.timeoutMs, env, model });
  if (negotiation.kind === "unavailable") {
    return { executor: legacy, selection: { path: "legacy", reason: `${negotiation.reason}: ${negotiation.detail}` } };
  }
  const omp = new OmpWorkerExecutor({
    launch: config.launch,
    model,
    home: env[OMP_HOME_ENV]?.trim() || undefined,
    env,
  });
  return { executor: new FallbackWorkerExecutor(omp, legacy), selection: { path: "omp" } };
}
