import type { WorkerResult, WorkerRole, WorkerUsage } from "../core/types.ts";

/** A delegated task for a fresh-context worker (INV-002, §12). */
export interface WorkerRequest {
  role: WorkerRole;
  task: string;
  /** Additional verified context lines (context firewall, §17). */
  context?: string;
  /** Tool allowlist (role-specific tool schemas, §8.3). */
  tools: string[];
  /** Opening user message for the fresh session (defaults to the generic kickoff). */
  kickoff?: string;
  /** Working directory (candidate worktree or repo root). */
  cwd: string;
  /** Wall-clock budget in ms. */
  timeoutMs?: number;
  /** Hard context-token budget; the session is aborted once exceeded (spec §10.6). */
  maxContextTokens?: number;
  /**
   * Explicit model selection produced by the capability router. When absent the
   * executor falls back to its construction-time model.
   */
  modelOverride?: { provider: string; id: string };
  /**
   * Replace the role prompt entirely. Used by the engineering lifecycle, which
   * owns prompts for its own specialist roles (spec §11).
   */
  systemPromptOverride?: string;
  /** Image attachments for vision-capable roles (spec §16). */
  images?: WorkerImage[];
  /**
   * Which terminating tool the session must call. `review_result` carries the
   * structured review verdict used by the engineering lifecycle (spec §14).
   */
  resultTool?: "worker_result" | "review_result";
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
  /** Payload of the terminating tool when it is not a plain worker_result. */
  structured?: unknown;
  usage: WorkerUsage | null;
  error?: string;
  /** Number of tool executions performed by the worker session (context telemetry). */
  toolCalls?: number;
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
