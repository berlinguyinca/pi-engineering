import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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

/** An executor that runs the runtime's semantic tools (PiWorkerExecutor, OmpWorkerExecutor, FallbackWorkerExecutor). */
export interface CustomToolSink {
  setCustomTools(tools: ToolDefinition[]): void;
}

export const acceptsCustomTools = (worker: unknown): worker is CustomToolSink =>
  typeof (worker as Partial<CustomToolSink> | null)?.setCustomTools === "function";

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

  /** Both sides get the tools: the legacy executor may run any request the OMP worker could not start. */
  setCustomTools(tools: ToolDefinition[]): void {
    for (const side of [this.primary, this.legacy]) if (acceptsCustomTools(side)) side.setCustomTools(tools);
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
  const home = env[OMP_HOME_ENV]?.trim() || undefined;
  // Negotiate under the same HOME as the workers: a handshake under another HOME proves nothing about them.
  const negotiation = await negotiateOmp({
    launch: config.launch,
    timeoutMs: config.timeoutMs,
    env: home ? { ...env, HOME: home } : env,
    model,
  });
  if (negotiation.kind === "unavailable") {
    return { executor: legacy, selection: { path: "legacy", reason: `${negotiation.reason}: ${negotiation.detail}` } };
  }
  const omp = new OmpWorkerExecutor({
    launch: config.launch,
    model,
    home,
    env,
  });
  return { executor: new FallbackWorkerExecutor(omp, legacy), selection: { path: "omp" } };
}
