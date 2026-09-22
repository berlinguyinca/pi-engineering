/**
 * Runtime-neutral AgentRuntime contract (herdr spec 02).
 *
 * Pi-Engineering owns work/DAG/policy/review/repair. Herdr owns the persistent
 * process/agent runtime. This interface is the single seam through which ALL
 * external runtime access flows: the current (legacy) runtime and a future
 * HerdrAgentRuntime both implement it, so Pi-Engineering never couples to any
 * one runtime implementation.
 *
 * Design rules (spec 02, 00-master):
 *  - Runtime IDs are opaque strings; callers never parse them.
 *  - `AgentWorkerRequest` is declarative (role, capabilities, isolation,
 *    duration/persistence, review, context policy, permissions). The runtime
 *    decides HOW to satisfy it; Pi-Engineering decides WHY a worker exists.
 *  - No fixed context size (e.g. 260k). Context limits are discovered from
 *    runtime/InferWeave metadata and expressed as `ContextPolicy`.
 *  - Workers return a compact `AgentWorkerResult` plus artifact refs; raw
 *    transcripts are never automatically injected into parent context.
 *
 * Implementations: `LegacyAgentRuntime` (current runtime, Phase C) and
 * `HerdrAgentRuntime` (Phase D, behind a runtime selector). Contract tests in
 * `test/unit/agentruntime.test.ts` must pass for BOTH.
 */

import type { WorkerImage } from "../workers/WorkerExecutor.ts";

/** Opaque, runtime-neutral identifier. Callers must not parse its contents. */
export type RuntimeId = string;

/** Runtime identity reported via `capabilities`. */
export type RuntimeName = "legacy" | "herdr";

/** Normalized worker lifecycle vocabulary (spec 05). */
export type AgentStatus =
  | "CREATED"
  | "STARTING"
  | "READY"
  | "WORKING"
  | "WAITING"
  | "BLOCKED"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED"
  | "RECOVERING"
  | "LOST"
  | "TERMINATED";

/** Operations a runtime may advertise. */
export type AgentOperation =
  | "create"
  | "start"
  | "sendTask"
  | "get"
  | "list"
  | "boundedOutput"
  | "waitFor"
  | "interrupt"
  | "terminate"
  | "resume"
  | "attach"
  | "health"
  | "capabilities";

/** Isolation model requested by Pi-Engineering (spec 07). */
export type AgentIsolation = "none" | "worktree";

/** Worker duration/persistence class (spec 04). */
export type AgentDuration = "ephemeral" | "persistent";

/**
 * Context policy. Limits are DISCOVERED from runtime/InferWeave metadata, not
 * hard-coded. `maxRequestBytes` bounds the serialized request body so an
 * oversized request is transformed (split/summarize/materialize) BEFORE HTTP
 * submission — the architectural 413 fix, not a server limit bump (spec 06).
 */
export interface ContextPolicy {
  /** Discovered context token ceiling. */
  maxTokens?: number;
  /** Discovered serialized request-body byte ceiling. */
  maxRequestBytes?: number;
  /** Fraction of the ceiling kept as safety headroom (e.g. 0.85). */
  headroomRatio?: number;
}

/** Capabilities a worker requests of the runtime (spec 09). */
export type AgentCapability =
  | "coding"
  | "vision"
  | "long-context"
  | "review"
  | "reasoning"
  | "fast"
  | "simple"
  | "researcher"
  | "debugger";

/** Declarative worker request (spec 02, 04). */
export interface AgentWorkerRequest {
  role: string;
  objective: string;
  /** Requested capabilities; the runtime/InferWeave resolves placement. */
  capabilities?: AgentCapability[];
  /** Isolation requested (worktree vs none). */
  isolation?: AgentIsolation;
  /** Persistence class. */
  duration?: AgentDuration;
  /** Review expectation (Pi-Engineering policy; runtime does not decide). */
  review?: { required: boolean; independent?: boolean };
  /** Context budget policy. */
  contextPolicy?: ContextPolicy;
  /** Least-privilege permissions / scopes for this worker. */
  permissions?: string[];
  /** Working directory (worktree or repo root). */
  cwd?: string;
  /** Pre-allocated worktree path, if isolation=worktree. */
  worktree?: string | null;
  /** Explicit model override resolved by the capability router. */
  modelOverride?: { provider: string; id: string } | null;
  /** Image attachments for vision-capable roles. */
  images?: WorkerImage[];
  /** Wall-clock budget in ms. */
  timeoutMs?: number;
  /** Replace the role prompt entirely. */
  systemPromptOverride?: string;
  /** Which terminating tool the session must call. */
  resultTool?: "worker_result" | "review_result";
  /** Opening user message for a fresh session. */
  kickoff?: string;
}

/** Structured, artifact-first worker result (spec 06). */
export interface AgentWorkerResult {
  status: "completed" | "blocked" | "failed";
  /** Concise summary; never the full transcript. */
  summary: string;
  /** artifact:// refs to full outputs (lazily retrievable). */
  artifactRefs: string[];
  error?: string;
  /** Role-specific payload. */
  details?: Record<string, unknown>;
}

/** A runtime worker's observable state. */
export interface AgentWorker {
  id: RuntimeId;
  runtime: RuntimeName;
  status: AgentStatus;
  role: string;
  objective: string;
  worktree?: string | null;
  model?: string | null;
  created_at: string;
  updated_at: string;
  /** Current operation for operator visibility (spec 11). */
  currentOperation?: string;
  /** Compact bounded output for listing (spec 06). */
  boundedOutput?: string;
  result?: AgentWorkerResult | null;
}

/** Advertised runtime capabilities (spec 02, 03 negotiation). */
export interface AgentCapabilities {
  name: RuntimeName;
  version: string;
  persistent: boolean;
  worktrees: boolean;
  remoteHosts: boolean;
  recovery: boolean;
  boundedOutput: boolean;
  attach: boolean;
  /** Discovered context ceiling; undefined when unknown. Never a fixed 260k. */
  maxContextTokens?: number;
  operations: AgentOperation[];
}

export interface AgentHealth {
  runtime: RuntimeName;
  ok: boolean;
  activeWorkers: number;
  /** Free-form runtime telemetry. */
  detail: Record<string, unknown>;
}

/**
 * The runtime-neutral seam. Pi-Engineering code depends only on this interface.
 * `resumeOrReconcile` reconciles persisted worker state after a restart
 * (spec 13): it re-asserts the worker against the runtime and classifies it
 * (alive / resumable / completed-offline / failed / missing).
 */
export interface AgentRuntime {
  readonly capabilities: AgentCapabilities;
  create(req: AgentWorkerRequest): Promise<RuntimeId>;
  start(id: RuntimeId): Promise<AgentWorker>;
  sendTask(id: RuntimeId, task: string, req?: Partial<AgentWorkerRequest>): Promise<AgentWorker>;
  get(id: RuntimeId): Promise<AgentWorker | undefined>;
  list(): Promise<AgentWorker[]>;
  boundedOutput(id: RuntimeId, maxChars?: number): Promise<string>;
  waitFor(id: RuntimeId, timeoutMs?: number, signal?: AbortSignal): Promise<AgentWorker>;
  interrupt(id: RuntimeId): Promise<AgentWorker>;
  terminate(id: RuntimeId): Promise<boolean>;
  resumeOrReconcile(id: RuntimeId): Promise<AgentWorker>;
  attach(id: RuntimeId): Promise<AgentWorker>;
  health(): Promise<AgentHealth>;
}
