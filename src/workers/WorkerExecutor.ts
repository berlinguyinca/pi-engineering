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
}

export interface WorkerRun {
  result: WorkerResult;
  usage: WorkerUsage | null;
  error?: string;
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
