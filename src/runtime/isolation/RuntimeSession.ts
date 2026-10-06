/**
 * The Pi Engineering session: one UUID per Pi process, registered in the
 * machine registry, heartbeating, and unregistered on graceful exit.
 *
 * All mutable session state lives on `globalThis`, so an in-process reload of
 * Pi Engineering (a fresh module graph in the same process) continues the SAME
 * logical session — same id, same registry generation, one heartbeat timer —
 * instead of looking like a second session: no false stale ownership, no
 * duplicate event writer, no orphaned runtime state.
 *
 * Objects on `globalThis` were created by whichever module graph created them,
 * so a reload must hand them over explicitly or the OLD code keeps running:
 * the first `ensureRegistered()` from a new module graph re-opens the registry
 * with that graph's RuntimeRegistry (same file, same registration) and makes
 * that graph's code the heartbeat/exit driver. SessionEventStore writers are
 * re-created by the new graph because a reload closes the old generation's
 * namespaces first; a writer some other caller keeps open across a reload
 * stays the old instance until it is closed.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ExclusiveFileLock } from "../../platform/eventstore/fileLock.ts";
import type { LeaseOwner } from "./LeaseManager.ts";
import { type ReconciliationReport, RecoveryManager } from "./RecoveryManager.ts";
import { RuntimeRegistry, type SessionBindingUpdate } from "./RuntimeRegistry.ts";
import { type ProcessIdentity, currentProcessIdentity } from "./processIdentity.ts";
import { emitRuntimeEvent, setRuntimeEventLog } from "./runtimeEvents.ts";
import { resolveRegistryLocation, resolveStateRoot, sessionRuntimeDir } from "./stateDir.ts";

export type RuntimeHealth = "healthy" | "degraded" | "recovering" | "rebound" | "isolated" | "failed";

export interface SessionBindingInfo extends SessionBindingUpdate {
  repoName: string | null;
  kind: string;
}

interface SessionGlobalState {
  sessionId: string;
  startedAt: string;
  pid: number;
  registry: RuntimeRegistry | null;
  registryFile: string | null;
  generationId: string | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  lastHeartbeatMs: number | null;
  health: RuntimeHealth;
  healthReason: string | null;
  binding: SessionBindingInfo | null;
  lastReconciliation: ReconciliationReport | null;
  exitHookInstalled: boolean;
  metadata: Record<string, unknown>;
  registering: { file: string; promise: Promise<RuntimeRegistry | null> } | null;
  /**
   * The newest module graph's entry point for timer and exit-hook work. The
   * timer and the hook outlive a reload; they call through this, never through
   * the class that happened to install them.
   */
  driver: (() => RuntimeSession) | null;
  /** Module URL of the code currently driving heartbeats (diagnostics, tests). */
  driverModule: string | null;
}

const SESSION_KEY = Symbol.for("pi-engineering.runtime-session.v2");

export const DEFAULT_HEARTBEAT_MS = 10_000;

function heartbeatIntervalMs(): number {
  const raw = Number(process.env.PI_ENGINEERING_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw >= 50 ? raw : DEFAULT_HEARTBEAT_MS;
}

function globalState(): SessionGlobalState {
  const holder = globalThis as unknown as Record<symbol, SessionGlobalState | undefined>;
  let state = holder[SESSION_KEY];
  // A session identity belongs to exactly one process.
  if (state && state.pid === process.pid && !("driver" in state)) {
    // Created by a module graph that predates the driver hand-over.
    (state as SessionGlobalState).driver = null;
    (state as SessionGlobalState).driverModule = null;
  }
  if (!state || state.pid !== process.pid) {
    state = {
      sessionId: randomUUID(),
      startedAt: new Date().toISOString(),
      pid: process.pid,
      registry: null,
      registryFile: null,
      generationId: null,
      heartbeatTimer: null,
      lastHeartbeatMs: null,
      health: "healthy",
      healthReason: null,
      binding: null,
      lastReconciliation: null,
      exitHookInstalled: false,
      metadata: {},
      registering: null,
      driver: null,
      driverModule: null,
    };
    holder[SESSION_KEY] = state;
  }
  return state;
}

/** Stable session identity for this process (survives in-process reloads). */
export function currentSessionIdentity(): { sessionId: string; startedAt: string; pid: number } {
  const state = globalState();
  return { sessionId: state.sessionId, startedAt: state.startedAt, pid: state.pid };
}

function isCorruptDatabase(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a database|malformed|corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(message);
}

/**
 * Open the registry; a database that is not a database / malformed is moved
 * aside (kept for diagnostics, with its -wal/-shm) and a fresh one created.
 * The registry only describes live processes, so nothing durable is lost —
 * the next reconciliation rebuilds ownership from process state.
 */
export async function openRegistryWithRecovery(file: string, sessionId: string): Promise<RuntimeRegistry> {
  try {
    return RuntimeRegistry.open(file);
  } catch (error) {
    if (!isCorruptDatabase(error)) throw error;
  }
  // Serialize repair so a concurrent session never quarantines the fresh
  // database another one just created.
  let repairLock: ExclusiveFileLock | null = null;
  try {
    repairLock = await ExclusiveFileLock.acquire(`${file}.repair`);
  } catch {
    repairLock = null;
  }
  try {
    return quarantineAndReopen(file, sessionId);
  } finally {
    repairLock?.release();
  }
}

function quarantineAndReopen(file: string, sessionId: string): RuntimeRegistry {
  try {
    return RuntimeRegistry.open(file);
  } catch (error) {
    if (!isCorruptDatabase(error)) throw error;
    const recoveryDir = join(dirname(file), "recovery");
    mkdirSync(recoveryDir, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const quarantine = join(recoveryDir, `${basename(file, ".db")}-corrupt-${stamp}-${process.pid}.db`);
    try {
      renameSync(file, quarantine);
    } catch (renameError) {
      // A concurrent session already moved it aside; just open the fresh one.
      if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
      return RuntimeRegistry.open(file);
    }
    for (const suffix of ["-wal", "-shm"]) {
      try {
        renameSync(`${file}${suffix}`, `${quarantine}${suffix}`);
      } catch {
        // Absent sidecar.
      }
    }
    emitRuntimeEvent("runtime.recovering", {
      session_id: sessionId,
      phase: "registry_corrupt",
      quarantine,
      reason: error instanceof Error ? error.message : String(error),
    });
    return RuntimeRegistry.open(file);
  }
}

export function registryFileFor(stateRoot: string): string {
  return resolveRegistryLocation(stateRoot).file;
}

export class RuntimeSession {
  private readonly state: SessionGlobalState;
  readonly process: ProcessIdentity;

  private constructor(state: SessionGlobalState) {
    this.state = state;
    this.process = currentProcessIdentity();
  }

  /** The session of this process. Cheap; safe to call from anywhere. */
  static current(): RuntimeSession {
    const session = new RuntimeSession(globalState());
    setRuntimeEventLog(join(session.sessionDir(), "runtime.jsonl"));
    return session;
  }

  get sessionId(): string {
    return this.state.sessionId;
  }

  get startedAt(): string {
    return this.state.startedAt;
  }

  get generationId(): string | null {
    return this.state.generationId;
  }

  get health(): { state: RuntimeHealth; reason: string | null } {
    return { state: this.state.health, reason: this.state.healthReason };
  }

  get binding(): SessionBindingInfo | null {
    return this.state.binding ? { ...this.state.binding } : null;
  }

  get lastHeartbeatMs(): number | null {
    return this.state.lastHeartbeatMs;
  }

  get lastReconciliation(): ReconciliationReport | null {
    return this.state.lastReconciliation;
  }

  stateRoot(): string {
    return resolveStateRoot();
  }

  /** Session scope: unbound/fallback runtime state and the debug log. */
  sessionDir(): string {
    return sessionRuntimeDir(this.stateRoot(), this.sessionId);
  }

  leaseOwner(): LeaseOwner {
    return { sessionId: this.sessionId, process: this.process };
  }

  setHealth(health: RuntimeHealth, reason: string | null = null): void {
    this.state.health = health;
    this.state.healthReason = reason;
  }

  /**
   * Register in the machine registry (idempotent), run startup
   * reconciliation once per registry, and start heartbeating. Returns null —
   * and marks the session degraded — when no registry can be opened; callers
   * keep working with local fallbacks.
   */
  ensureRegistered(): Promise<RuntimeRegistry | null> {
    const file = registryFileFor(this.stateRoot());
    const state = this.state;
    if (state.registry && state.registryFile === file && state.generationId) {
      this.takeOver();
      return Promise.resolve(state.registry);
    }
    // Single-flight: concurrent runtime opens in one process register once.
    if (state.registering?.file === file) return state.registering.promise;
    const promise = this.register(file).finally(() => {
      if (state.registering?.promise === promise) state.registering = null;
    });
    state.registering = { file, promise };
    return promise;
  }

  private async register(file: string): Promise<RuntimeRegistry | null> {
    const state = this.state;
    if (state.registry && state.registryFile !== file) this.shutdown("relocated");
    let registry: RuntimeRegistry;
    try {
      registry = await openRegistryWithRecovery(file, this.sessionId);
    } catch (error) {
      this.setHealth(
        "degraded",
        `runtime registry unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      emitRuntimeEvent("runtime.degraded", { session_id: this.sessionId, reason: state.healthReason });
      return null;
    }
    try {
      const record = registry.register({
        sessionId: this.sessionId,
        process: this.process,
        startedAt: this.startedAt,
        binding: state.binding ?? undefined,
        metadata: state.metadata,
        state: "starting",
      });
      state.registry = registry;
      state.registryFile = file;
      state.generationId = record.generationId;
      state.lastHeartbeatMs = record.lastHeartbeatMs;
      emitRuntimeEvent("session.registered", {
        session_id: this.sessionId,
        generation_id: record.generationId,
        pid: this.process.pid,
      });
      this.setHealth("recovering");
      emitRuntimeEvent("runtime.recovering", { session_id: this.sessionId, phase: "startup_reconciliation" });
      state.lastReconciliation = new RecoveryManager(registry, {
        selfSessionId: this.sessionId,
        stateRoot: this.stateRoot(),
      }).reconcile();
      registry.setState(this.sessionId, record.generationId, "healthy");
      this.setHealth("healthy");
      emitRuntimeEvent("runtime.started", { session_id: this.sessionId, generation_id: record.generationId });
      this.state.driver = () => RuntimeSession.current();
      this.state.driverModule = import.meta.url;
      this.startHeartbeat();
      this.installExitHook();
      return registry;
    } catch (error) {
      registry.close();
      state.registry = null;
      state.registryFile = null;
      state.generationId = null;
      this.setHealth(
        "degraded",
        `runtime registry unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      emitRuntimeEvent("runtime.degraded", { session_id: this.sessionId, reason: state.healthReason });
      return null;
    }
  }

  /**
   * Make THIS module graph's code the session's driver: re-open the registry
   * with this graph's RuntimeRegistry class (same file and registration; the
   * old instance is closed) and route the heartbeat and exit hook through
   * this graph. A no-op when this graph already drives the session.
   */
  private takeOver(): void {
    const state = this.state;
    state.driver = () => RuntimeSession.current();
    state.driverModule = import.meta.url;
    const current = state.registry;
    if (!current || current instanceof RuntimeRegistry || !state.registryFile) return;
    try {
      state.registry = RuntimeRegistry.open(state.registryFile);
      emitRuntimeEvent("runtime.reload_takeover", { session_id: this.sessionId, module: import.meta.url });
    } catch {
      // Keep the working (older) instance rather than none.
      return;
    }
    try {
      (current as { close(): void }).close();
    } catch {
      // Already closed.
    }
  }

  /** The open registry, if this session is registered. */
  registry(): RuntimeRegistry | null {
    return this.state.registry;
  }

  private startHeartbeat(): void {
    if (this.state.heartbeatTimer) clearInterval(this.state.heartbeatTimer);
    const state = this.state;
    const timer = setInterval(() => {
      // Through the driver: after a reload the NEW module graph's code runs
      // (see takeOver), not the class that installed this timer.
      (state.driver ?? (() => RuntimeSession.current()))().heartbeat();
    }, heartbeatIntervalMs());
    timer.unref?.();
    this.state.heartbeatTimer = timer;
  }

  private installExitHook(): void {
    if (this.state.exitHookInstalled) return;
    this.state.exitHookInstalled = true;
    const state = this.state;
    // node:sqlite is synchronous, so a graceful unregister fits in 'exit'.
    process.once("exit", () => {
      try {
        (state.driver ?? (() => RuntimeSession.current()))().shutdown("process_exit");
      } catch {
        // Ungraceful paths are repaired by the next startup reconciliation.
      }
    });
  }

  /**
   * Prove liveness. If the registry no longer recognizes this generation (we
   * were declared dead while suspended, or the row vanished), re-register under
   * a NEW generation instead of resurrecting the old one.
   */
  heartbeat(): boolean {
    const { registry, generationId } = this.state;
    if (!registry || !generationId) return false;
    try {
      if (registry.heartbeat(this.sessionId, generationId)) {
        this.state.lastHeartbeatMs = Date.now();
        if (this.state.health === "recovering" || this.state.health === "rebound") this.setHealth("healthy");
        emitRuntimeEvent("session.heartbeat", { session_id: this.sessionId });
        return true;
      }
      this.setHealth("recovering", "registry generation superseded; re-registering");
      const record = registry.register({
        sessionId: this.sessionId,
        process: this.process,
        startedAt: this.startedAt,
        binding: this.state.binding ?? undefined,
        metadata: this.state.metadata,
      });
      this.state.generationId = record.generationId;
      this.state.lastHeartbeatMs = record.lastHeartbeatMs;
      this.setHealth("healthy");
      emitRuntimeEvent("session.recovered", {
        session_id: this.sessionId,
        previous_generation: generationId,
        generation_id: record.generationId,
      });
      return true;
    } catch (error) {
      this.setHealth("degraded", `heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  setMetadata(metadata: Record<string, unknown>): void {
    this.state.metadata = { ...this.state.metadata, ...metadata };
    const { registry, generationId } = this.state;
    if (registry && generationId) {
      try {
        registry.setMetadata(this.sessionId, generationId, this.state.metadata);
      } catch {
        // Metadata is descriptive only.
      }
    }
  }

  /** Record the current binding (worktree) of this session. */
  recordBinding(binding: SessionBindingInfo, beforeCommit?: () => void): boolean {
    const { registry, generationId } = this.state;
    if (registry && generationId) {
      const committed = registry.rebind(this.sessionId, generationId, binding, beforeCommit);
      if (!committed) return false;
    } else {
      beforeCommit?.();
    }
    this.state.binding = { ...binding };
    return true;
  }

  /**
   * Bind (first time) or rebind this session to a worktree runtime.
   *
   * Transactional: the registry attachment and the session pointer change in
   * one SQLite transaction, and the in-memory binding moves only after it
   * commits. On failure the previous binding stays fully in force — the
   * session is never half-attached to two runtimes.
   */
  bindTo(info: SessionBindingInfo): { changed: boolean; from: string | null; error?: string } {
    const previous = this.state.binding;
    if (previous?.worktreeId === info.worktreeId) return { changed: false, from: previous.worktreePath };
    const fields = {
      session_id: this.sessionId,
      worktree_id: info.worktreeId,
      from: previous?.worktreePath ?? null,
      to: info.worktreePath,
    };
    let committed = false;
    try {
      committed = this.recordBinding(info);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitRuntimeEvent("runtime.rebind_failed", { ...fields, reason: message });
      return { changed: false, from: previous?.worktreePath ?? null, error: message };
    }
    if (!committed) {
      emitRuntimeEvent("runtime.rebind_failed", { ...fields, reason: "registry generation superseded" });
      return { changed: false, from: previous?.worktreePath ?? null, error: "registry generation superseded" };
    }
    if (previous) {
      this.setHealth("rebound");
      emitRuntimeEvent("runtime.rebound", fields);
    } else {
      emitRuntimeEvent("runtime.bound", fields);
    }
    return { changed: true, from: previous?.worktreePath ?? null };
  }

  /** Graceful shutdown: unregister, release leases, stop heartbeating. Idempotent. */
  shutdown(reason = "shutdown"): void {
    const state = this.state;
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
    const { registry, generationId } = state;
    state.registry = null;
    state.registryFile = null;
    state.generationId = null;
    if (!registry || !generationId) return;
    try {
      registry.unregister(this.sessionId, generationId);
      emitRuntimeEvent("runtime.stopped", { session_id: this.sessionId, reason });
    } catch {
      // Startup reconciliation of the next session repairs this.
    } finally {
      registry.close();
    }
  }
}
