/**
 * The narrow, stable boundary between the RuntimeHost and dynamically loaded
 * runtime generations (spec §3, §8, §18).
 *
 * Everything that crosses this boundary is plain data or a duck-typed object
 * owned by the Host. A generation is imported from its own directory, so a
 * class it imports is a DIFFERENT class from the Host's copy of the same file:
 * nothing here may rely on `instanceof` or module-level singletons shared with
 * the Host.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The runtime API this code base speaks. Bump on an incompatible contract change. */
export const PI_ENGINEERING_RUNTIME_API = 1;

/** Runtime API versions this Host can drive. */
export const HOST_SUPPORTED_RUNTIME_APIS: readonly number[] = [1];

export type RuntimeQuiesceReason = "reload" | "update" | "rollback" | "shutdown";

export type RuntimeOperationType =
  | "inference"
  | "tool"
  | "verification"
  | "git"
  | "deployment"
  | "state_transaction"
  | "command"
  | "migration";

/** One operation the runtime is in the middle of (spec §22). */
export interface ActiveRuntimeOperation {
  id: string;
  generation: number;
  type: RuntimeOperationType;
  /** Human label, e.g. the tool or command name. */
  label: string;
  /** An interruptible operation does not hold a safe point. */
  interruptible: boolean;
  startedAt: string;
}

export interface OperationHandle {
  readonly id: string;
  end(): void;
}

/** What a generation may use to declare operations. */
export interface OperationTracker {
  begin(type: RuntimeOperationType, label: string, opts?: { interruptible?: boolean }): OperationHandle;
  active(): ActiveRuntimeOperation[];
}

export interface SafePointOptions {
  signal?: AbortSignal;
  /** Give up after this long. Absent: wait until cancelled. */
  timeoutMs?: number;
  /** Called whenever the set of blocking operations changes. */
  onWaiting?: (blocking: ActiveRuntimeOperation[]) => void;
}

export type SafePointResult =
  | { reached: true; waitedMs: number }
  | { reached: false; reason: "cancelled" | "timeout"; blocking: ActiveRuntimeOperation[]; waitedMs: number };

/** Small transient handover state; durable stores stay authoritative (spec §24). */
export interface RuntimeSnapshot {
  generation: number;
  activeMissionIds: string[];
  pendingMissionIds: string[];
  /** Missions parked waiting for inference capacity; must survive handover (spec §41). */
  inferenceWaitMissionIds?: string[];
  selectedModels?: Record<string, string>;
  runtimePreferences?: Record<string, unknown>;
  createdAt: string;
}

export interface RuntimeHealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RuntimeHealth {
  healthy: boolean;
  checks: RuntimeHealthCheck[];
}

/** The contract every runtime generation implements (spec §3). */
export interface EngineeringRuntime {
  start(): Promise<void>;
  quiesce(reason: RuntimeQuiesceReason): Promise<void>;
  waitForSafePoint(options?: SafePointOptions): Promise<SafePointResult>;
  snapshot(): Promise<RuntimeSnapshot>;
  stop(): Promise<void>;
  health(): Promise<RuntimeHealth>;
  /** Undo quiesce when a handover is abandoned before the runtime was stopped. */
  resume?(): Promise<void>;
}

/** A disposable resource owned by one generation (spec §4). */
export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface ResourceOwner {
  add(resource: Disposable | (() => void | Promise<void>), label?: string): void;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  size(): number;
}

export interface RuntimeInfo {
  version: string;
  commit: string | null;
  /** Directory the generation's code was imported from. */
  root: string;
  /** Where that directory came from: the package checkout, an installed version, ... */
  source: string;
}

/** Everything the Host hands to a new generation. */
export interface RuntimeContext {
  generation: number;
  /** A generation-scoped ExtensionAPI: registrations route through the Host, actions are fenced. */
  pi: ExtensionAPI;
  resources: ResourceOwner;
  operations: OperationTracker;
  /** False once a newer generation has taken over. */
  isActive(): boolean;
  /** The previous generation's snapshot, when this is a handover. */
  restore?: RuntimeSnapshot;
  info: RuntimeInfo;
  /** The latest Pi context the Host has seen, for replaying session lifecycle. */
  latestContext(): unknown;
  /**
   * Pi's session lifecycle. The Host routes `session_start`/`session_shutdown`
   * itself; a generation started mid-session replays `session_start` to set
   * up, and replays `session_shutdown` when stopped mid-session.
   */
  session: {
    active(): boolean;
    replay(event: "session_start" | "session_shutdown", payload: unknown): Promise<string[]>;
  };
  log(event: string, fields?: Record<string, unknown>): void;
}

/** What a dynamically imported runtime entry exports (spec §8). */
export interface EngineeringRuntimeModule {
  runtimeApi: number;
  createRuntime(context: RuntimeContext): Promise<EngineeringRuntime>;
}

export function isEngineeringRuntimeModule(value: unknown): value is EngineeringRuntimeModule {
  const mod = value as Partial<EngineeringRuntimeModule> | null;
  return (
    typeof mod === "object" &&
    mod !== null &&
    typeof mod.runtimeApi === "number" &&
    Number.isInteger(mod.runtimeApi) &&
    typeof mod.createRuntime === "function"
  );
}

/** A callback or action from a generation that is no longer active. */
export class StaleGenerationError extends Error {
  readonly generation: number;
  constructor(generation: number, what: string) {
    super(`pi-engineering runtime generation ${generation} is no longer active (${what})`);
    this.name = "StaleGenerationError";
    this.generation = generation;
  }
}
