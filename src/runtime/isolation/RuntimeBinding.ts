/**
 * Where a runtime's orchestration namespace lives, and the fallbacks that keep
 * engineering features operational when the preferred location is unusable.
 *
 *   worktree         <state>/worktrees/<worktree-id>      (normal)
 *   override         $PI_ENGINEERING_ORCHESTRATION_DIR    (expert override)
 *   session-fallback <state>/sessions/<session-id>        (worktree dir unusable)
 *   memory           no durable namespace                 (nothing writable)
 *
 * Every kind still gets per-session writers: the override relocates the
 * namespace, it never reinstates a shared single writer.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { WorktreeIdentity } from "./WorktreeIdentity.ts";
import { emitRuntimeEvent } from "./runtimeEvents.ts";
import { resolveOrchestrationOverride, resolveStateRoot, sessionRuntimeDir, worktreeRuntimeDir } from "./stateDir.ts";

export type RuntimeBindingKind = "worktree" | "override" | "session-fallback" | "memory";

export interface RuntimeBinding {
  kind: RuntimeBindingKind;
  identity: WorktreeIdentity;
  /** Namespace root; null only for `memory`. */
  runtimeDir: string | null;
  eventsDir: string | null;
  recoveryDir: string | null;
  /** Legacy single-writer stores to import (non-destructively). */
  legacyFiles: string[];
  /** Why the preferred location was not used. */
  degradedReason: string | null;
}

function probeWritable(dir: string): string | null {
  try {
    mkdirSync(join(dir, "events"), { recursive: true });
    const probe = join(dir, `.probe-${process.pid}-${randomUUID()}`);
    writeFileSync(probe, "", { flag: "wx" });
    rmSync(probe, { force: true });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function uid(): string {
  try {
    return String(userInfo().uid);
  } catch {
    return "user";
  }
}

export function resolveRuntimeBinding(options: {
  identity: WorktreeIdentity;
  /** The repository work dir (`<root>/.pi-eng`) whose legacy store is migrated. */
  workDir: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): RuntimeBinding {
  const env = options.env ?? process.env;
  const override = resolveOrchestrationOverride(env);
  const stateRoot = resolveStateRoot(env);
  const legacyFiles = [join(options.workDir, "orchestration.jsonl")];
  if (override) legacyFiles.push(join(override, "orchestration.jsonl"));
  const preferred = override
    ? { kind: "override" as const, dir: override }
    : { kind: "worktree" as const, dir: worktreeRuntimeDir(stateRoot, options.identity.worktreeId) };
  const candidates: Array<{ kind: RuntimeBindingKind; dir: string }> = [
    preferred,
    { kind: "session-fallback", dir: sessionRuntimeDir(stateRoot, options.sessionId) },
    { kind: "session-fallback", dir: join(tmpdir(), `pi-engineering-${uid()}`, "sessions", options.sessionId) },
  ];
  const failures: string[] = [];
  for (const candidate of candidates) {
    const failure = probeWritable(candidate.dir);
    if (failure === null) {
      const degradedReason = failures.length > 0 ? failures.join("; ") : null;
      if (degradedReason) {
        emitRuntimeEvent("runtime.degraded", {
          session_id: options.sessionId,
          worktree_id: options.identity.worktreeId,
          binding: candidate.kind,
          reason: degradedReason,
        });
      }
      return {
        kind: candidate.kind,
        identity: options.identity,
        runtimeDir: candidate.dir,
        eventsDir: join(candidate.dir, "events"),
        recoveryDir: join(candidate.dir, "recovery"),
        legacyFiles: [...new Set(legacyFiles)],
        degradedReason,
      };
    }
    failures.push(`${candidate.dir}: ${failure}`);
  }
  emitRuntimeEvent("runtime.degraded", {
    session_id: options.sessionId,
    worktree_id: options.identity.worktreeId,
    binding: "memory",
    reason: failures.join("; "),
  });
  return {
    kind: "memory",
    identity: options.identity,
    runtimeDir: null,
    eventsDir: null,
    recoveryDir: null,
    legacyFiles: [...new Set(legacyFiles)],
    degradedReason: failures.join("; "),
  };
}
