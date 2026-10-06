/**
 * One-line wiring of the unified resilient layer onto a live runtime
 * (fault-tolerance spec §21/§23).
 *
 * Every inference path in this harness reaches a model through either a
 * `ModelRuntime.streamSimple` (worker sessions — planner, scout, implementer,
 * reviewer, specialist reviewer, challenge, tournament candidate, remediation
 * worker, spec verifier, background engineering — plus the vision, narration
 * and compaction helpers) or a provider-registry `streamSimple` (the
 * interactive engineering turn). This module is the single place those seams
 * are armed with the SAME stack:
 *
 *   InferWeave response-metadata capture → unified failure classifier →
 *   same-model retry policy honouring server timing → model-health penalty +
 *   model-scoped circuit breaker → RoleRouter capability fallback under the
 *   recorded RequiredModelEnvelope → mission WAITING_FOR_INFERENCE_CAPACITY
 *   with automatic resume → concise status line + structured telemetry.
 *
 * It extends the EXISTING gateway machinery (the retry pump and the shared
 * admission gate) rather than adding another retry loop, and it is idempotent,
 * so several call sites may arm the same runtime.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelCapabilityRegistry } from "../capability/registry.ts";
import type { RoleRouter } from "../capability/router.ts";
import type { AdmissionController } from "../gateway/AdmissionController.ts";
import { sharedAdmissionController } from "../gateway/config.ts";
import { gatewayHoldScope } from "../gateway/signals.ts";
import type { ModelRef } from "../lifecycle/types.ts";
import { createAssistantMessageEventStream, terminalAssistantMessage } from "./admissionTransport.ts";
import { currentInferenceInvocation } from "./inferenceContext.ts";
import { CircuitBreakerRegistry } from "./circuitBreaker.ts";
import { ModelHealthRegistry } from "./modelHealth.ts";
import type { ResilientStreamScheduler, ResilientStreamInstallOptions } from "./resilientStream.ts";
import { installResilientRuntime } from "./resilientStream.ts";
import { resolveInferenceResilienceConfig, type InferenceResilienceConfig } from "./resilienceConfig.ts";
import type { ExecutedActionTracker } from "./recovery.ts";
import { InferenceTelemetry } from "./telemetry.ts";

/** Process-wide resilient services, shared by every armed runtime. */
export interface ResilientServices {
  config: InferenceResilienceConfig;
  telemetry: InferenceTelemetry;
  health: ModelHealthRegistry;
  breakers: CircuitBreakerRegistry;
}

let shared: ResilientServices | undefined;

/** The shared services (created on first use; injectable for tests). */
export function resilientServices(
  opts: { env?: Record<string, string | undefined>; services?: Partial<ResilientServices> } = {},
): ResilientServices {
  if (shared && !opts.services) return shared;
  const config = resolveInferenceResilienceConfig(opts.env ?? (typeof process !== "undefined" ? process.env : {}));
  shared = {
    config,
    telemetry: opts.services?.telemetry ?? new InferenceTelemetry(),
    health: opts.services?.health ?? new ModelHealthRegistry({ config: { unavailabilityPenaltyMs: config.unavailabilityPenaltyMs } }),
    breakers:
      opts.services?.breakers ??
      new CircuitBreakerRegistry({
        failureThreshold: config.circuitFailures,
        windowMs: config.circuitWindowMs,
        cooldownMs: config.circuitCooldownMs,
      }),
  };
  return shared;
}

/** Forget the shared services (tests only). */
export function resetResilientServices(): void {
  shared = undefined;
}

export interface WireResilientRuntimeOptions {
  /** Fallback role when the async invocation context is absent. */
  role?: string;
  /** Capability registry + RoleRouter: the pool and selection for fallback. */
  registry?: ModelCapabilityRegistry;
  router?: RoleRouter;
  /**
   * Shared admission gate: a reported wait is honoured process-wide. Defaults
   * to the process-wide controller every other caller already shares.
   */
  admission?: Pick<AdmissionController, "noteWaitAndSleep" | "noteCallerWaitAndSleep">;
  /** Mission scheduler: WAITING_FOR_INFERENCE_CAPACITY + auto-resume. */
  scheduler?: ResilientStreamScheduler;
  /** Concise user-visible status line (spec §26). */
  status?: (line: string) => void;
  /** Idempotency tracker for tool calls already executed by this worker. */
  actions?: ExecutedActionTracker;
  /**
   * Telemetry bus to publish on. Defaults to the shared bus every armed
   * runtime publishes to; pass a private one in tests or in a harness that
   * owns its own observability surface.
   */
  telemetry?: InferenceTelemetry;
  env?: Record<string, string | undefined>;
  config?: Partial<InferenceResilienceConfig>;
  /** Elapsed budget for one logical request (PI_GATEWAY_RETRY_WINDOW default). */
  maxElapsedMs?: number;
  /** Capacity probe cadence for the mission-level wait. */
  probeIntervalMs?: number;
  /** Only arm when enabled (PI_INFERENCE_RESILIENCE_ENABLED). */
  enabled?: boolean;
}

/**
 * Arm a worker/vision/background `ModelRuntime` with the resilient stack.
 *
 * Returns what happened so a caller can log it; never throws — an unarmed
 * runtime keeps Pi's own (shorter) retry, which is strictly worse than this
 * one but must not take the session down.
 */
export function wireResilientModelRuntime(
  runtime: ModelRuntime,
  opts: WireResilientRuntimeOptions,
): "installed" | "already-installed" | "disabled" {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  const services = resilientServices({ env });
  // The caller's env + explicit config decide. The shared services' resolved
  // config is NOT merged in: it came from a different environment (whatever
  // armed the runtime first) and would silently outrank this one's
  // PI_INFERENCE_* settings.
  const config = resolveInferenceResilienceConfig(env, opts.config);
  const enabled = opts.enabled ?? config.enabled;
  if (!enabled) return "disabled";
  const admission = opts.admission ?? sharedAdmissionController();
  const install: ResilientStreamInstallOptions = {
    role: opts.role ?? "worker",
    context: () => currentInferenceInvocation(),
    env,
    config,
    registry: opts.registry,
    router: opts.router,
    health: services.health,
    breakers: services.breakers,
    telemetry: opts.telemetry ?? services.telemetry,
    ...(opts.actions ? { actions: opts.actions } : {}),
    ...(opts.scheduler ? { scheduler: opts.scheduler } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.probeIntervalMs !== undefined ? { probeIntervalMs: opts.probeIntervalMs } : {}),
    refOf: (model) => {
      const m = model as { provider?: string; id?: string } | undefined;
      return { provider: String(m?.provider ?? ""), id: String(m?.id ?? "") };
    },
    resolveModel: (ref: ModelRef) => runtime.getModel(ref.provider, ref.id) as unknown,
    createStream: () => createAssistantMessageEventStream() as never,
    errorMessage: (model, error) =>
      terminalAssistantMessage(
        model as never,
        error instanceof Error ? error.message : String(error),
        "error",
      ) as never,
    signalOf: (options) => (options as { signal?: AbortSignal } | undefined)?.signal,
    // The same wait goes through the same gate every other caller uses, so a
    // saturated queue parks the process once instead of per session.
    hold: async (signal, abort, model) => {
      const m = model as { provider?: string; id?: string } | undefined;
      const scoped = { ...signal, provider: signal.provider ?? m?.provider, model: signal.model ?? m?.id };
      const holdOpts = {
        ...(m?.provider !== undefined ? { provider: m.provider } : {}),
        ...(m?.id !== undefined ? { model: m.id } : {}),
        ...(abort ? { signal: abort } : {}),
      };
      if (gatewayHoldScope(scoped) === "shared") await admission.noteWaitAndSleep(scoped, holdOpts);
      else await admission.noteCallerWaitAndSleep(scoped, holdOpts);
    },
    ...(opts.maxElapsedMs !== undefined ? { maxElapsedMs: opts.maxElapsedMs } : {}),
  };
  return installResilientRuntime(runtime as never, install) as "installed" | "already-installed";
}
