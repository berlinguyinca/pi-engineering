/**
 * Machine-local runtime state location.
 *
 * Coordination state (session registry, leases, per-session event streams) is
 * machine-scoped and ephemeral in nature, so it lives under the XDG state
 * directory rather than inside a source repository:
 *
 *   $PI_ENGINEERING_STATE_DIR            (explicit override; tests use this)
 *   $XDG_STATE_HOME/pi-engineering
 *   ~/.local/state/pi-engineering
 *
 * Layout:
 *
 *   <root>/registry.db                 SQLite (WAL) session registry + leases
 *   <root>/worktrees/<worktree-id>/    one namespace per git worktree
 *       events/<session-id>.jsonl      one append stream per session
 *       recovery/                      quarantined evidence (never deleted)
 *   <root>/sessions/<session-id>/      session scope (unbound / fallback)
 *       runtime.jsonl                  structured runtime diagnostics
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const STATE_DIR_ENV = "PI_ENGINEERING_STATE_DIR";
export const ORCHESTRATION_DIR_ENV = "PI_ENGINEERING_ORCHESTRATION_DIR";

export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[STATE_DIR_ENV]?.trim();
  if (explicit) return resolve(explicit);
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg) return join(resolve(xdg), "pi-engineering");
  return join(homedir(), ".local", "state", "pi-engineering");
}

/** Expert override for the orchestration namespace of every worktree. */
export function resolveOrchestrationOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[ORCHESTRATION_DIR_ENV]?.trim();
  return value ? resolve(value) : null;
}

export function worktreeRuntimeDir(stateRoot: string, worktreeId: string): string {
  return join(stateRoot, "worktrees", worktreeId);
}

export function sessionRuntimeDir(stateRoot: string, sessionId: string): string {
  return join(stateRoot, "sessions", sessionId);
}
