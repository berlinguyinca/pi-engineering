import type { WorkerResult, WorkerRole, WorkerUsage } from "../core/types.ts";

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
  /** Wall-clock budget in ms. */
  timeoutMs?: number;
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
