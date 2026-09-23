/**
 * Gateway admission configuration and the process-wide controller.
 *
 * One controller per process: the whole point is that every model caller in
 * this runtime — worker sessions, parallel tournament legs, the interactive
 * turn — backs off behind the SAME gate when a gateway reports saturation.
 */

import { emitTelemetry } from "../telemetry/sink.ts";
import { AdmissionController, type AdmissionEvent } from "./AdmissionController.ts";
import { describeAdmissionEvent } from "./admissionNotice.ts";

export interface GatewayAdmissionConfig {
  enabled: boolean;
  /** Concurrent model sessions allowed before a gateway says otherwise. */
  maxConcurrency: number;
  /** Slots held back for the operator's own interactive turn. */
  reservedSlots: number;
  /**
   * Legacy display/configuration field. Server minima are never shortened;
   * maxElapsedMs determines whether a retry chain can afford the wait.
   */
  maxWaitMs: number;
  /** Stagger window applied when a cooldown releases waiters. */
  jitterMs: number;
  /**
   * Retries a worker attempt may spend waiting out gateway backpressure.
   */
  maxRetries: number;
  /** Total monotonic time available to one interactive retry chain. */
  maxElapsedMs: number;
  /** Emit one structured telemetry line per admission event. */
  telemetry: boolean;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayAdmissionConfig = {
  enabled: true,
  maxConcurrency: 4,
  reservedSlots: 1,
  maxWaitMs: 300_000,
  jitterMs: 250,
  maxRetries: 8,
  maxElapsedMs: 300_000,
  telemetry: true,
};

function int(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value !== "false" && value !== "0";
}

/**
 * Resolve gateway config from the environment.
 *
 * Env vars:
 *   PI_GATEWAY_ADMISSION_ENABLED — "true"/"false" (default true)
 *   PI_GATEWAY_MAX_CONCURRENCY   — int, concurrent model sessions (default 4)
 *   PI_GATEWAY_RESERVED_SLOTS    — int, slots kept for the interactive turn (default 1)
 *   PI_GATEWAY_MAX_WAIT_MS       — int, cap on one honoured wait (default: none)
 *   PI_GATEWAY_JITTER_MS         — int, release stagger window (default 250)
 *   PI_GATEWAY_MAX_RETRIES       — int, gateway-wait retries per worker attempt (default: 8)
 *   PI_GATEWAY_MAX_ELAPSED_MS    — int, elapsed budget per interactive retry chain (default: 300000)
 *   PI_GATEWAY_TELEMETRY         — "true"/"false" (default true)
 */
export function resolveGatewayConfig(overrides?: Partial<GatewayAdmissionConfig>): GatewayAdmissionConfig {
  const cfg: GatewayAdmissionConfig = { ...DEFAULT_GATEWAY_CONFIG };
  const env = typeof process !== "undefined" && process.env ? process.env : {};

  cfg.enabled = bool(env.PI_GATEWAY_ADMISSION_ENABLED, cfg.enabled);
  cfg.maxConcurrency = Math.max(1, int(env.PI_GATEWAY_MAX_CONCURRENCY, cfg.maxConcurrency));
  cfg.reservedSlots = Math.max(0, int(env.PI_GATEWAY_RESERVED_SLOTS, cfg.reservedSlots));
  cfg.maxWaitMs = Math.max(0, int(env.PI_GATEWAY_MAX_WAIT_MS, cfg.maxWaitMs));
  cfg.jitterMs = Math.max(0, int(env.PI_GATEWAY_JITTER_MS, cfg.jitterMs));
  cfg.maxRetries = Math.max(0, int(env.PI_GATEWAY_MAX_RETRIES, cfg.maxRetries));
  cfg.maxElapsedMs = Math.max(0, int(env.PI_GATEWAY_MAX_ELAPSED_MS, cfg.maxElapsedMs));
  cfg.telemetry = bool(env.PI_GATEWAY_TELEMETRY, cfg.telemetry);

  if (overrides) Object.assign(cfg, overrides);
  return cfg;
}

/**
 * Report an admission event.
 *
 * Through the telemetry sink, not to stderr: inside Pi a raw write lands under
 * a frame the TUI drew and scrolls it by a row the TUI does not know about,
 * which is what put unwrapped JSON across the side panel and shifted the
 * characters beneath it. Headless, the sink's default still writes to stderr.
 */
export function emitAdmissionTelemetry(event: AdmissionEvent): void {
  emitTelemetry(describeAdmissionEvent(event));
}

let shared: AdmissionController | undefined;
let sharedConfig: GatewayAdmissionConfig | undefined;

/** The process-wide admission controller (created on first use). */
export function sharedAdmissionController(): AdmissionController {
  if (!shared) {
    const cfg = resolveGatewayConfig();
    sharedConfig = cfg;
    shared = new AdmissionController({
      maxConcurrency: cfg.maxConcurrency,
      reservedSlots: cfg.reservedSlots,
      maxWaitMs: cfg.maxWaitMs,
      jitterMs: cfg.jitterMs,
      ...(cfg.telemetry ? { onEvent: emitAdmissionTelemetry } : {}),
    });
  }
  return shared;
}

/** Config backing the shared controller. */
export function sharedGatewayConfig(): GatewayAdmissionConfig {
  if (!sharedConfig) sharedAdmissionController();
  return sharedConfig as GatewayAdmissionConfig;
}

/** Replace the process-wide controller (tests only). */
export function setSharedAdmissionController(
  controller: AdmissionController | undefined,
  config?: GatewayAdmissionConfig,
): void {
  shared = controller;
  sharedConfig = controller ? (config ?? resolveGatewayConfig()) : undefined;
}
