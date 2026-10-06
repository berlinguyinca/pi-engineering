import type { WorkerResult, WorkerRole, WorkerUsage } from "../core/types.ts";
import type { CheckpointRecoveryContext } from "../orchestration/broker.ts";
import type { CheckpointProgressClaim } from "./checkpointProgressTool.ts";

/** Bounded, operator-safe live state from a worker session. */
export interface WorkerActivity {
  kind: "state" | "tool" | "heartbeat" | "execution" | "checkpoint";
  summary: string;
  phase?: "started" | "completed" | "failed" | "canceled";
  stage?: "agent" | "process" | "review" | "integration" | "validation" | "research";
  toolName?: string;
  meaningfulProgress: boolean;
  elapsedMs?: number;
  lastActivityMs?: number;
  claims?: CheckpointProgressClaim[];
}

/** A delegated task for a fresh-context worker (INV-002, §12). */
export interface WorkerRequest {
  role: WorkerRole;
  task: string;
  /** Additional verified context lines (context firewall, §17). */
  context?: string;
  /** Tool allowlist (role-specific tool schemas, §8.3). */
  tools: string[];
  /** Working directory (candidate worktree or repo root). */
  cwd: string;
  /**
   * Inactivity guard in ms for standalone runs (no owner `signal`): the session
   * is aborted only after this long with no session event at all. It is not a
   * total-duration budget.
   */
  timeoutMs?: number;
  /**
   * Mission workers: wait for inference capacity with no elapsed cap (the
   * interactive turn keeps its horizon). Only cancellation ends the wait.
   */
  unboundedInferenceWait?: boolean;
  /** Hard context-token budget; the session is aborted once exceeded (spec §10.6). */
  maxContextTokens?: number;
  /** Opening user message for the fresh session (defaults to the generic kickoff). */
  kickoff?: string;
  /**
   * Explicit model selection produced by the capability router. When absent the
   * executor falls back to its construction-time model.
   */
  modelOverride?: { provider: string; id: string };
  /** Replace the role prompt entirely (specialist roles own their prompts). */
  systemPromptOverride?: string;
  /** Image attachments for vision-capable roles. */
  images?: WorkerImage[];
  /**
   * Which terminating tool the session must call. `review_result` carries a
   * structured review verdict.
   */
  resultTool?: "worker_result" | "review_result";
  /** Run this worker session belongs to (observability ids), when known. */
  runId?: string;
  /** Work item the session is scoped to (observability ids), if any. */
  workItemId?: string | null;
  /** Stable session identity (observability ids); generated when omitted. */
  sessionId?: string;
  /**
   * True only when `cwd` is a worktree the broker allocated for this worker.
   * Gates the commit-discipline instruction: a worker running in the user's
   * own checkout (any fallback path) must never be told to commit there.
   */
  isolatedWorktree?: boolean;
  /** Store-verified immutable checkpoint context for a fresh recovery worker. */
  recovery?: Readonly<CheckpointRecoveryContext>;
  /** Broker-declared deliverables eligible for candidate-bound checkpoint progress. */
  deliverables?: readonly string[];
  /** Live bounded activity; never includes prompts, model text, tool arguments, or secrets. */
  onActivity?: (event: WorkerActivity) => void;
  /** Abort the active model session when the owning execution is canceled. */
  signal?: AbortSignal;
}

/** An image passed to a vision-capable worker session. */
export interface WorkerImage {
  /** base64 payload without a data: prefix. */
  data: string;
  mimeType: string;
  /** Optional human-readable label used in the prompt. */
  label?: string;
}

export interface WorkerRun {
  result: WorkerResult;
  usage: WorkerUsage | null;
  error?: string;
  /** Number of tool executions performed by the worker session (context telemetry). */
  toolCalls?: number;
  /** Payload of the terminating tool when it is not a plain worker_result. */
  structured?: unknown;
}

/**
 * Fresh-context worker execution (spec §12).
 *
 * Implementations must run each task in a fresh session with no inherited
 * reasoning. The real implementation uses Pi's SDK; tests use a fake.
 */
export interface WorkerExecutor {
  run(req: WorkerRequest): Promise<WorkerRun>;
}
