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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { filesystemInfo, forcedNetworkFilesystem } from "./fsType.ts";

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

export interface RegistryLocation {
  file: string;
  /** Filesystem of the state directory. */
  stateFsType: string;
  /** Why the registry is not in the state dir, when it is not. */
  relocatedBecause: string | null;
}

function nearestExisting(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function localRuntimeRoot(env: NodeJS.ProcessEnv): string {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) return join(resolve(runtimeDir), "pi-engineering");
  let uid = "user";
  try {
    uid = String(userInfo().uid);
  } catch {
    // Keep the generic name.
  }
  return join(tmpdir(), `pi-engineering-${uid}`);
}

/**
 * Where the SQLite coordination registry lives. Normally `<state>/registry.db`;
 * when the state directory is on a network/distributed filesystem (NFS home,
 * BeeGFS, Lustre, SMB…), WAL and advisory locks are not trustworthy there, so
 * the registry moves to a machine-local runtime directory instead. Coordination
 * is machine-scoped anyway (it tracks local processes).
 */
export function resolveRegistryLocation(stateRoot: string, env: NodeJS.ProcessEnv = process.env): RegistryLocation {
  const fs = filesystemInfo(nearestExisting(stateRoot));
  if (fs.network || forcedNetworkFilesystem(env)) {
    const suffix = createHash("sha256").update(stateRoot).digest("hex").slice(0, 16);
    return {
      file: join(localRuntimeRoot(env), `registry-${suffix}.db`),
      stateFsType: fs.type,
      relocatedBecause: `state directory is on a network filesystem (${fs.type})`,
    };
  }
  return { file: join(stateRoot, "registry.db"), stateFsType: fs.type, relocatedBecause: null };
}
