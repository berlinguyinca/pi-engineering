/**
 * RuntimeHost: owns exactly one active runtime generation and hands over
 * between generations transactionally (spec §3, §5, §6, §21, §32-§35).
 *
 * Handover order, and why it differs slightly from a naive reading of §6:
 *
 *   1. the candidate is IMPORTED first, while the old generation is still
 *      serving. A syntax error or an incompatible runtime API is caught with
 *      zero effect on the running runtime (§47);
 *   2. wait for a safe point with the gate OPEN (cancellable, nothing changed);
 *   3. close the gate, quiesce, re-check the safe point (drain stragglers);
 *   4. snapshot, stop the old generation, dispose its resources, retire it;
 *   5. hooks.beforeLoad (migration, pointer switch: update only);
 *   6. create + start + health-check the new generation;
 *   7. commit, open the gate (queued work resumes on the new generation).
 *
 * Any failure in 5-6 rolls back: the candidate is stopped and disposed,
 * hooks.onRollback restores state/pointers, and the PREVIOUS code is
 * re-imported from a fresh snapshot of its own immutable directory.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type ActiveRuntimeOperation,
  type EngineeringRuntime,
  type EngineeringRuntimeModule,
  HOST_SUPPORTED_RUNTIME_APIS,
  PI_ENGINEERING_RUNTIME_API,
  type RuntimeContext,
  type RuntimeHealth,
  type RuntimeSnapshot,
} from "./contract.ts";
import { type RuntimeSource, loadRuntimeSource, pruneGenerationSnapshots } from "./loader.ts";
import { OperationRegistry } from "./operations.ts";
import { type BridgeTarget, PiBridge } from "./piBridge.ts";
import { RuntimeResourceRegistry } from "./resources.ts";
import { type RuntimeEventFields, RuntimeTelemetry } from "./telemetry.ts";

export type HandoverKind = "reload" | "update" | "rollback";

export type HandoverPhase =
  | "preparing"
  | "waiting_safe_point"
  | "quiescing"
  | "snapshotting"
  | "stopping"
  | "migrating"
  | "activating"
  | "loading"
  | "restoring"
  | "health_check"
  | "committing"
  | "committed"
  | "rolling_back"
  | "rolled_back"
  | "failed"
  | "cancelled";

export interface HandoverHooks {
  /** After the old generation stopped, before the new one is created (migrate, switch pointer). */
  beforeLoad?(snapshot: RuntimeSnapshot): Promise<void>;
  /** During rollback, before the previous runtime is re-imported (restore checkpoint/pointer). */
  onRollback?(reason: string): Promise<void>;
  /** After the new generation passed health, before the gate opens. */
  onCommit?(): Promise<void>;
  /** Phase observer, e.g. the update journal. */
  onPhase?(phase: HandoverPhase): void | Promise<void>;
}

export interface HandoverRequest {
  kind: HandoverKind;
  source: RuntimeSource;
  signal?: AbortSignal;
  safePointTimeoutMs?: number;
  hooks?: HandoverHooks;
  fields?: RuntimeEventFields;
}

export interface HandoverResult {
  ok: boolean;
  kind: HandoverKind;
  phase: HandoverPhase;
  fromGeneration?: number;
  activeGeneration?: number;
  rolledBack: boolean;
  /** The old generation was never touched (failure before quiesce, or cancelled). */
  untouched: boolean;
  failure?: string;
  failedStage?: HandoverPhase;
  waitedForSafePoint: boolean;
  durationMs: number;
  snapshot?: RuntimeSnapshot;
  health?: RuntimeHealth;
}

export class RuntimeBusyError extends Error {
  constructor() {
    super("Pi Engineering runtime update already in progress.");
    this.name = "RuntimeBusyError";
  }
}

/** An in-flight handover: observable (phase, blocking ops) and cancellable until it touches the runtime. */
export class HandoverTask {
  phase: HandoverPhase = "preparing";
  blocking: ActiveRuntimeOperation[] = [];
  readonly startedAt = Date.now();
  readonly promise: Promise<HandoverResult>;
  private readonly controller = new AbortController();
  private readonly phaseListeners = new Set<(phase: HandoverPhase) => void>();

  readonly kind: HandoverKind;

  constructor(kind: HandoverKind, run: (task: HandoverTask) => Promise<HandoverResult>, external?: AbortSignal) {
    this.kind = kind;
    if (external) {
      if (external.aborted) this.controller.abort();
      else external.addEventListener("abort", () => this.controller.abort(), { once: true });
    }
    this.promise = run(this);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Cancel while still waiting for a safe point. Later phases are not interruptible. */
  cancel(): boolean {
    if (this.phase !== "preparing" && this.phase !== "waiting_safe_point") return false;
    this.controller.abort();
    return true;
  }

  private readonly blockingListeners = new Set<(blocking: ActiveRuntimeOperation[]) => void>();

  setBlocking(blocking: ActiveRuntimeOperation[]): void {
    this.blocking = blocking;
    for (const listener of [...this.blockingListeners]) listener(blocking);
  }

  /** Called whenever the set of operations holding the safe point changes. */
  onBlocking(listener: (blocking: ActiveRuntimeOperation[]) => void): () => void {
    this.blockingListeners.add(listener);
    return () => this.blockingListeners.delete(listener);
  }

  setPhase(phase: HandoverPhase): void {
    this.phase = phase;
    for (const listener of [...this.phaseListeners]) listener(phase);
  }

  /** Resolves once the task leaves `preparing` (or finishes). */
  onPhase(listener: (phase: HandoverPhase) => void): () => void {
    this.phaseListeners.add(listener);
    return () => this.phaseListeners.delete(listener);
  }
}

interface LiveGeneration {
  generation: number;
  runtime: EngineeringRuntime;
  resources: RuntimeResourceRegistry;
  source: RuntimeSource;
  /** Directory the code was imported from (immutable unless `direct`). */
  dir: string;
  startedAt: number;
}

export interface RuntimeHostOptions {
  pi: ExtensionAPI;
  /** Where generation snapshots are materialized. */
  generationsDir: string;
  telemetry?: RuntimeTelemetry;
  supportedRuntimeApis?: readonly number[];
  /** Longest an event/command waits for a handover in progress before being dropped. */
  handoverWaitMs?: number;
}

export interface GenerationInfo {
  generation: number;
  source: RuntimeSource;
  dir: string;
  startedAt: number;
}

export class RuntimeHost implements BridgeTarget {
  readonly bridge: PiBridge;
  readonly operations = new OperationRegistry();
  readonly telemetry: RuntimeTelemetry;
  private counter = 0;
  private current: LiveGeneration | undefined;
  private starting: number | undefined;
  private readonly retired = new Set<number>();
  /** Resolves when a handover that has stopped the old generation finishes. */
  private switching: Promise<void> | null = null;
  private task: HandoverTask | null = null;
  private latestCtx: unknown;
  private sessionActive = false;
  private closed = false;
  private readonly supported: readonly number[];
  private readonly handoverWaitMs: number;
  /** Known-good code of the generation before the current one; the rollback target. */
  private previousGood: { source: RuntimeSource; dir: string } | undefined;
  lastHandover: HandoverResult | undefined;
  lastReloadAt: number | undefined;
  lastFailure: string | undefined;
  private readonly hostOps = new Map<string, { end(): void }>();

  private readonly opts: RuntimeHostOptions;

  constructor(opts: RuntimeHostOptions) {
    this.opts = opts;
    this.telemetry = opts.telemetry ?? new RuntimeTelemetry();
    this.supported = opts.supportedRuntimeApis ?? HOST_SUPPORTED_RUNTIME_APIS;
    this.handoverWaitMs = opts.handoverWaitMs ?? 120_000;
    this.bridge = new PiBridge(opts.pi, this, ["session_start", "session_shutdown"]);
    this.installHostHandlers();
  }

  // ─── BridgeTarget ───────────────────────────────────────────────────────

  dispatchGeneration(): number | undefined | Promise<number | undefined> {
    if (this.switching) {
      const switching = this.switching;
      return withTimeout(switching, this.handoverWaitMs).then(() => this.current?.generation);
    }
    return this.current?.generation;
  }

  whenOpen(): Promise<void> {
    return this.operations.whenOpen();
  }

  track<T>(generation: number, type: "command" | "tool", label: string, work: () => Promise<T>): Promise<T> {
    return this.operations.track(generation, type, label, work);
  }

  isLive(generation: number): boolean {
    if (this.retired.has(generation)) return false;
    return generation === this.current?.generation || generation === this.starting;
  }

  // ─── Introspection ──────────────────────────────────────────────────────

  isGenerationActive(generation: number): boolean {
    return !this.closed && generation === this.current?.generation;
  }

  activeGeneration(): GenerationInfo | undefined {
    const c = this.current;
    return c ? { generation: c.generation, source: c.source, dir: c.dir, startedAt: c.startedAt } : undefined;
  }

  previousKnownGood(): { source: RuntimeSource; dir: string } | undefined {
    return this.previousGood;
  }

  pendingTask(): HandoverTask | null {
    return this.task;
  }

  latestContext(): unknown {
    return this.latestCtx;
  }

  isSessionActive(): boolean {
    return this.sessionActive;
  }

  async health(): Promise<RuntimeHealth> {
    if (!this.current) return { healthy: false, checks: [{ name: "active generation", ok: false }] };
    return this.healthOf(this.current);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Load the first generation. With `fallbacks`, a source that fails to load,
   * start or pass health is skipped for the next (crash recovery, §30).
   */
  async start(source: RuntimeSource, fallbacks: RuntimeSource[] = []): Promise<HandoverResult> {
    const started = Date.now();
    let failure = "";
    for (const candidate of [source, ...fallbacks]) {
      try {
        const live = await this.bringUp(candidate, undefined);
        this.current = live;
        this.starting = undefined;
        this.lastFailure = undefined;
        return this.finish({
          ok: true,
          kind: "reload",
          phase: "committed",
          activeGeneration: live.generation,
          rolledBack: candidate !== source,
          untouched: false,
          waitedForSafePoint: false,
          durationMs: Date.now() - started,
          ...(candidate !== source ? { failure } : {}),
        });
      } catch (error) {
        failure = `${candidate.label}: ${message(error)}`;
        this.lastFailure = failure;
      }
    }
    return this.finish({
      ok: false,
      kind: "reload",
      phase: "failed",
      rolledBack: false,
      untouched: true,
      failure,
      failedStage: "loading",
      waitedForSafePoint: false,
      durationMs: Date.now() - started,
    });
  }

  /** Begin a handover. Throws RuntimeBusyError if one is already running (in-process lock, §28). */
  begin(request: HandoverRequest): HandoverTask {
    if (this.task) throw new RuntimeBusyError();
    if (this.closed) throw new Error("pi-engineering runtime host is shut down");
    const task = new HandoverTask(request.kind, (t) => this.runHandover(t, request), request.signal);
    this.task = task;
    void task.promise.finally(() => {
      if (this.task === task) this.task = null;
    });
    return task;
  }

  /** Convenience: begin and await. */
  async handover(request: HandoverRequest): Promise<HandoverResult> {
    return this.begin(request).promise;
  }

  /** Pi's session is ending: the generation shuts down with it and the Host closes. */
  async shutdown(event: unknown, ctx: unknown): Promise<void> {
    if (this.closed) return;
    this.task?.cancel();
    this.sessionActive = false;
    const live = this.current;
    if (live) {
      await this.bridge.replay(live.generation, "session_shutdown", event, ctx);
      await this.retire(live);
    }
    this.current = undefined;
    this.closed = true;
  }

  /** Remove snapshot directories no generation can still import from. */
  async pruneSnapshots(): Promise<string[]> {
    const keep = [
      this.current?.dir,
      this.current ? knownGoodDir(this.current) : undefined,
      this.previousGood?.dir,
    ].filter((d): d is string => !!d);
    const removed = await pruneGenerationSnapshots(this.opts.generationsDir, keep);
    if (removed.length > 0) this.telemetry.emit("runtime.retention.pruned", { removed: removed.length });
    return removed;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private installHostHandlers(): void {
    const remember = (ctx: unknown) => {
      if (ctx) this.latestCtx = ctx;
    };
    this.bridge.onHostEvent("session_start", async (event, ctx) => {
      remember(ctx);
      this.sessionActive = true;
      const target = await this.dispatchGeneration();
      if (target !== undefined) await this.bridge.replay(target, "session_start", event, ctx);
    });
    this.bridge.onHostEvent("session_shutdown", (event, ctx) => this.shutdown(event, ctx));
    // Safe-point tracking from Pi's own lifecycle (spec §19): an assistant
    // message streaming is an inference; a tool executing is a tool.
    this.bridge.onHostEvent("message_start", (event, ctx) => {
      remember(ctx);
      if ((event as { message?: { role?: string } }).message?.role !== "assistant") return;
      this.beginHostOp("inference:stream", "inference", "assistant message");
    });
    this.bridge.onHostEvent("message_end", (event) => {
      if ((event as { message?: { role?: string } }).message?.role !== "assistant") return;
      this.endHostOp("inference:stream");
    });
    this.bridge.onHostEvent("tool_execution_start", (event, ctx) => {
      remember(ctx);
      const e = event as { toolCallId?: string; toolName?: string };
      this.beginHostOp(`tool:${e.toolCallId ?? "?"}`, "tool", e.toolName ?? "tool");
    });
    this.bridge.onHostEvent("tool_execution_end", (event) => {
      this.endHostOp(`tool:${(event as { toolCallId?: string }).toolCallId ?? "?"}`);
    });
    // A run that ends without the matching end events must not wedge a safe point.
    this.bridge.onHostEvent("agent_end", (_event, ctx) => {
      remember(ctx);
      for (const key of [...this.hostOps.keys()]) this.endHostOp(key);
    });
    this.bridge.onHostEvent("before_agent_start", (_event, ctx) => remember(ctx));
  }

  private beginHostOp(key: string, type: "inference" | "tool", label: string): void {
    this.endHostOp(key);
    this.hostOps.set(key, this.operations.begin(this.current?.generation ?? 0, type, label));
  }

  private endHostOp(key: string): void {
    this.hostOps.get(key)?.end();
    this.hostOps.delete(key);
  }

  noteContext(ctx: unknown): void {
    if (ctx) this.latestCtx = ctx;
  }

  /**
   * Load and start a generation. `importFrom` loads the code from a different
   * (immutable) directory while the generation keeps `source` as its logical
   * origin, so a later reload still reads the original source tree.
   */
  private async bringUp(
    source: RuntimeSource,
    restore: RuntimeSnapshot | undefined,
    importFrom?: string,
  ): Promise<LiveGeneration> {
    const generation = ++this.counter;
    const loadFrom = importFrom ? { ...source, root: importFrom, direct: false } : source;
    const loaded = await loadRuntimeSource(loadFrom, this.opts.generationsDir, generation, this.supported);
    this.telemetry.emit("runtime.generation.loaded", {
      new_generation: generation,
      to_version: source.version,
      to_commit: source.commit,
      runtime_api: loaded.module.runtimeApi,
    });
    return this.instantiate(generation, loaded.module, source, loaded.dir, restore);
  }

  private async instantiate(
    generation: number,
    module: EngineeringRuntimeModule,
    source: RuntimeSource,
    dir: string,
    restore: RuntimeSnapshot | undefined,
  ): Promise<LiveGeneration> {
    this.starting = generation;
    const resources = new RuntimeResourceRegistry();
    const pi = this.bridge.createGenerationApi(generation, (off) => resources.add(off, "event-bus subscription"));
    const context: RuntimeContext = {
      generation,
      pi,
      resources,
      operations: {
        begin: (type, label, o) => this.operations.begin(generation, type, label, o),
        active: () => this.operations.active().filter((op) => op.generation === generation),
      },
      isActive: () => this.isLive(generation),
      ...(restore ? { restore } : {}),
      info: { version: source.version, commit: source.commit, root: dir, source: source.label },
      latestContext: () => this.latestCtx,
      session: {
        active: () => this.sessionActive,
        replay: (event, payload) => this.bridge.replay(generation, event, payload, this.latestCtx),
      },
      log: (event, fields) => this.telemetry.emit("runtime.generation.started", { ...fields, note: event }),
    };
    let runtime: EngineeringRuntime | undefined;
    const live = (): LiveGeneration => ({
      generation,
      runtime: runtime as EngineeringRuntime,
      resources,
      source,
      dir,
      startedAt: Date.now(),
    });
    try {
      runtime = await module.createRuntime(context);
      await runtime.start();
      this.telemetry.emit("runtime.generation.started", { new_generation: generation, to_version: source.version });
      const health = await this.healthOf(live());
      if (!health.healthy) {
        const failed = health.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`);
        throw new Error(`health check failed: ${failed.join("; ")}`);
      }
      this.telemetry.emit("runtime.health.passed", { new_generation: generation });
      return live();
    } catch (error) {
      // load/start/restore failures are health failures too (§33: "start()
      // completed", "no initialization exception").
      this.telemetry.emit("runtime.health.failed", { new_generation: generation, failure_reason: message(error) });
      if (runtime) await runtime.stop().catch(() => {});
      await resources.disposeAll();
      this.retired.add(generation);
      this.bridge.dropGeneration(generation);
      if (this.starting === generation) this.starting = undefined;
      throw error;
    }
  }

  private async healthOf(live: LiveGeneration): Promise<RuntimeHealth> {
    const checks: RuntimeHealth["checks"] = [];
    let reported: RuntimeHealth;
    try {
      reported = await live.runtime.health();
    } catch (error) {
      reported = { healthy: false, checks: [{ name: "runtime health()", ok: false, detail: message(error) }] };
    }
    checks.push(...reported.checks);
    checks.push({ name: "runtime API compatible", ok: this.supported.includes(PI_ENGINEERING_RUNTIME_API) });
    // Listeners registered once: the generation's handlers fit inside the
    // slots Pi already has, so Pi never sees a second copy.
    let overflow = "";
    for (const name of ["agent_settled", "before_agent_start", "tool_call", "tool_result", "message_end"]) {
      const mine = this.bridge.generationHandlers(live.generation, name).length;
      if (this.bridge.hasPiEvents() && mine > this.bridge.realHandlerCount(name)) overflow += `${name} `;
    }
    checks.push({ name: "listeners registered once", ok: overflow === "", ...(overflow ? { detail: overflow } : {}) });
    return { healthy: reported.healthy && checks.every((c) => c.ok), checks };
  }

  private async retire(live: LiveGeneration): Promise<void> {
    try {
      await live.runtime.stop();
    } finally {
      await live.resources.disposeAll();
      this.retired.add(live.generation);
      this.bridge.dropGeneration(live.generation);
      for (const key of [...this.hostOps.keys()]) this.endHostOp(key);
    }
  }

  private async runHandover(task: HandoverTask, request: HandoverRequest): Promise<HandoverResult> {
    const started = Date.now();
    const old = this.current;
    const base: RuntimeEventFields = {
      ...request.fields,
      old_generation: old?.generation,
      from_version: old?.source.version,
      from_commit: old?.source.commit,
      to_version: request.source.version,
      to_commit: request.source.commit,
    };
    const phase = async (p: HandoverPhase) => {
      task.setPhase(p);
      await request.hooks?.onPhase?.(p);
    };
    const result = (r: Omit<HandoverResult, "kind" | "durationMs">): HandoverResult =>
      this.finish({ ...r, kind: request.kind, durationMs: Date.now() - started });
    if (request.kind === "reload") this.telemetry.emit("runtime.reload.started", base);

    // 1. Import the candidate while the old generation keeps serving (§47).
    const generation = ++this.counter;
    let loaded: { module: EngineeringRuntimeModule; dir: string };
    try {
      await phase("preparing");
      loaded = await loadRuntimeSource(request.source, this.opts.generationsDir, generation, this.supported);
      this.telemetry.emit("runtime.generation.loaded", {
        ...base,
        new_generation: generation,
        runtime_api: loaded.module.runtimeApi,
      });
    } catch (error) {
      await phase("failed");
      return result({
        ok: false,
        phase: "failed",
        failedStage: "loading",
        failure: message(error),
        rolledBack: false,
        untouched: true,
        waitedForSafePoint: false,
        ...(old ? { fromGeneration: old.generation, activeGeneration: old.generation } : {}),
      });
    }

    // 2. Safe point with the gate open: cancelling here changes nothing.
    let waited = false;
    if (old) {
      await phase("waiting_safe_point");
      const blockingNow = this.operations.blocking();
      if (blockingNow.length > 0) {
        waited = true;
        this.telemetry.emit("runtime.safe_point.waiting", {
          ...base,
          blocking: this.operations.summarize(blockingNow),
        });
      }
      const sp = await this.operations.waitForSafePoint({
        signal: task.signal,
        ...(request.safePointTimeoutMs !== undefined ? { timeoutMs: request.safePointTimeoutMs } : {}),
        onWaiting: (blocking) => task.setBlocking(blocking),
      });
      task.setBlocking([]);
      if (!sp.reached) {
        this.telemetry.emit("runtime.safe_point.cancelled", { ...base, reason: sp.reason });
        await phase("cancelled");
        return result({
          ok: false,
          phase: "cancelled",
          failedStage: "waiting_safe_point",
          failure: sp.reason === "timeout" ? "timed out waiting for a safe point" : "cancelled",
          rolledBack: false,
          untouched: true,
          waitedForSafePoint: true,
          fromGeneration: old.generation,
          activeGeneration: old.generation,
        });
      }
      this.telemetry.emit("runtime.safe_point.reached", { ...base, duration: sp.waitedMs });
    }

    // 3. Quiesce: no new work from here; queued work waits for the new generation.
    this.operations.closeGate(request.kind);
    let snapshot: RuntimeSnapshot | undefined;
    try {
      if (old) {
        await phase("quiescing");
        this.telemetry.emit("runtime.quiesce.started", base);
        await old.runtime.quiesce(request.kind);
        // Drain anything that started between the safe point and the gate.
        const drained = await this.operations.waitForSafePoint({ timeoutMs: request.safePointTimeoutMs ?? 300_000 });
        if (!drained.reached) throw new HandoverAbort("quiescing", "operations did not drain after quiesce");
        this.telemetry.emit("runtime.quiesce.completed", base);
        await phase("snapshotting");
        snapshot = await old.runtime.snapshot();
        this.telemetry.emit("runtime.snapshot.created", {
          ...base,
          mission_ids: [...snapshot.activeMissionIds, ...snapshot.pendingMissionIds],
        });
      }
    } catch (error) {
      // Nothing was stopped: resume the old generation where it was.
      await old?.runtime.resume?.().catch(() => {});
      this.operations.openGate();
      await phase("failed");
      return result({
        ok: false,
        phase: "failed",
        failedStage: error instanceof HandoverAbort ? error.stage : "quiescing",
        failure: message(error),
        rolledBack: false,
        untouched: true,
        waitedForSafePoint: waited,
        ...(old ? { fromGeneration: old.generation, activeGeneration: old.generation } : {}),
      });
    }

    // 4..7: from here the old generation is gone; failure means rollback.
    let releaseSwitch: () => void = () => {};
    this.switching = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    let stage: HandoverPhase = "stopping";
    try {
      if (old) {
        await phase("stopping");
        await this.retire(old);
        this.current = undefined;
      }
      if (request.hooks?.beforeLoad) {
        stage = "migrating";
        await request.hooks.beforeLoad(
          snapshot ?? { generation: 0, activeMissionIds: [], pendingMissionIds: [], createdAt: now() },
        );
      }
      stage = "loading";
      await phase("loading");
      stage = "restoring";
      await phase("restoring");
      stage = "health_check";
      await phase("health_check");
      const live = await this.instantiate(generation, loaded.module, request.source, loaded.dir, snapshot);
      stage = "committing";
      await phase("committing");
      await request.hooks?.onCommit?.();
      if (old) this.previousGood = { source: old.source, dir: knownGoodDir(old) };
      this.current = live;
      this.starting = undefined;
      this.lastReloadAt = Date.now();
      this.lastFailure = undefined;
      await phase("committed");
      const health = await this.healthOf(live);
      if (request.kind === "reload") {
        this.telemetry.emit("runtime.reload.completed", {
          ...base,
          new_generation: live.generation,
          duration: Date.now() - started,
        });
      }
      return result({
        ok: true,
        phase: "committed",
        rolledBack: false,
        untouched: false,
        waitedForSafePoint: waited,
        activeGeneration: live.generation,
        ...(old ? { fromGeneration: old.generation } : {}),
        ...(snapshot ? { snapshot } : {}),
        health,
      });
    } catch (error) {
      const failure = message(error);
      this.lastFailure = failure;
      await phase("rolling_back");
      const rolled = await this.rollbackTo(old, snapshot, request, failure, base);
      await phase(rolled ? "rolled_back" : "failed");
      return result({
        ok: false,
        phase: rolled ? "rolled_back" : "failed",
        failedStage: stage,
        failure,
        rolledBack: rolled,
        untouched: false,
        waitedForSafePoint: waited,
        ...(old ? { fromGeneration: old.generation } : {}),
        ...(this.current ? { activeGeneration: this.current.generation } : {}),
        ...(snapshot ? { snapshot } : {}),
      });
    } finally {
      this.switching = null;
      releaseSwitch();
      this.operations.openGate();
    }
  }

  /** Bring the previous code back (§35). True when a healthy generation is active again. */
  private async rollbackTo(
    old: LiveGeneration | undefined,
    snapshot: RuntimeSnapshot | undefined,
    request: HandoverRequest,
    failure: string,
    base: RuntimeEventFields,
  ): Promise<boolean> {
    this.telemetry.emit("runtime.rollback.started", {
      ...base,
      failure_reason: failure,
      rollback_version: old?.source.version,
    });
    try {
      await request.hooks?.onRollback?.(failure);
      if (!old) throw new Error("no previous runtime to roll back to");
      // The old directory is immutable unless it was imported directly; either
      // way a fresh snapshot gives fresh module identities for the old code.
      const live = await this.bringUp(old.source, snapshot, knownGoodDir(old));
      this.current = live;
      this.starting = undefined;
      this.telemetry.emit("runtime.rollback.completed", {
        ...base,
        new_generation: live.generation,
        rollback_version: old.source.version,
      });
      return true;
    } catch (error) {
      this.lastFailure = `${failure}; rollback failed: ${message(error)}`;
      this.telemetry.emit("runtime.rollback.failed", { ...base, failure_reason: this.lastFailure });
      return false;
    }
  }

  private finish(result: HandoverResult): HandoverResult {
    this.lastHandover = result;
    return result;
  }
}

class HandoverAbort extends Error {
  readonly stage: HandoverPhase;
  constructor(stage: HandoverPhase, message: string) {
    super(message);
    this.stage = stage;
  }
}

/** The immutable directory holding exactly the code a generation ran. */
function knownGoodDir(live: LiveGeneration): string {
  return live.source.direct ? (live.source.rollbackRoot ?? live.dir) : live.dir;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
