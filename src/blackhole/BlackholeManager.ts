/**
 * BlackholeManager — orchestrates session memory lifecycle.
 *
 * Owns the adapter, the session registry, the background memory worker
 * scheduler/router, promotion, and telemetry. Emits ledger events for every
 * lifecycle transition so the EventStore/PostgreSQL remains the authoritative
 * system of record while Blackhole only accelerates in-session recall.
 */

import type { Actor } from "../core/types.ts";
import type { Ledger } from "../ledger/Ledger.ts";
import type { ModelProvider, ModelRouter } from "../routing/ModelRouter.ts";
import { Scheduler } from "../sched/Scheduler.ts";
import type { BlackholeAdapter } from "./BlackholeAdapter.ts";
import { MemoryStore } from "./MemoryStore.ts";
import { type DurableMemoryProvider, InMemoryDurableMemory } from "./OpenViking.ts";
import { type SessionContext, newSessionIdentity } from "./SessionStore.ts";
import { resolveBlackholeConfig } from "./config.ts";
import {
  type MemoryStoreFactory,
  type MemoryWorkerOptions,
  buildMemoryRouter,
  runMemoryWorker,
} from "./memoryWorkers.ts";
import { type PromotionDecision, decidePromotion } from "./promotion.ts";
import type { SessionIdentity } from "./types.ts";
import {
  type BlackholeConfig,
  type BlackholeManagerState,
  type MemoryEntry,
  type MemoryWorkerRole,
  sessionKey,
} from "./types.ts";

export interface BlackholeManagerOptions {
  ledger: Ledger;
  config?: import("./config.ts").PartialBlackholeConfig;
  adapter?: BlackholeAdapter;
  durable?: DurableMemoryProvider;
  /** Providers for background memory inference (cheap/fast). Defaults to empty. */
  providers?: ModelProvider[];
  runInference?: MemoryWorkerOptions["runInference"];
  now?: () => string;
}

/**
 * Emit a blackhole event into the ledger. The ledger's public `emitEvent` is a
 * passthrough so Blackhole stays a normal event source (EventStore authoritative).
 */
async function emit(
  ledger: Ledger,
  type: string,
  actor: Actor,
  payload: Record<string, unknown>,
  workItemId: string | null = null,
): Promise<void> {
  await ledger.emitEvent(type as never, workItemId, actor, payload);
}

export class BlackholeManager {
  readonly config: BlackholeConfig;
  adapter: BlackholeAdapter;
  readonly durable: DurableMemoryProvider;
  readonly scheduler: Scheduler;
  readonly router: ModelRouter;
  readonly providers: ModelProvider[];
  readonly warnings: string[];

  private readonly ledger: Ledger;
  private readonly runInference: MemoryWorkerOptions["runInference"];
  private readonly sessions = new Map<string, { store: MemoryStore; lastAccess: number }>();
  private memoryWorkersRun = { observer: 0, reflector: 0, dropper: 0 };
  private readonly now: () => string;

  private constructor(opts: BlackholeManagerOptions, resolved: ReturnType<typeof resolveBlackholeConfig>) {
    this.config = resolved.config;
    this.warnings = resolved.warnings;
    this.ledger = opts.ledger;
    this.durable = opts.durable ?? new InMemoryDurableMemory();
    this.scheduler = new Scheduler({ concurrency: this.config.memoryWorkerConcurrency });
    this.providers = opts.providers ?? [];
    this.router = buildMemoryRouter(this.providers);
    this.runInference = opts.runInference ?? defaultInference;
    this.now = opts.now ?? (() => new Date().toISOString());
    // Adapter is loaded asynchronously in open(); a default placeholder until then.
    this.adapter = opts.adapter ?? (null as unknown as BlackholeAdapter);
  }

  static async open(opts: BlackholeManagerOptions): Promise<BlackholeManager> {
    const resolved = resolveBlackholeConfig(opts.config);
    const mgr = new BlackholeManager(opts, resolved);
    mgr.adapter = opts.adapter ?? (await loadAdapter(resolved.config));
    // Fail-closed version validation (spec §2): a drifted installed package must
    // never silently run. If a real pi-blackhole is present but does not match
    // the requested/pinned version, we DISABLE the manager and record a failure
    // event rather than use an unvalidated provider. Absence of the package is
    // not an error (builtin fallback keeps core standalone).
    let action: string;
    let provider: string;
    const { validateBlackholePackage } = await import("./versioning.ts");
    const { validation } = await validateBlackholePackage({
      enabled: resolved.config.enabled,
      requestedVersion: resolved.config.version,
    });
    if (resolved.config.enabled && validation.ok) {
      mgr.config.enabled = true;
      action = "started";
      provider = validation.provider;
    } else {
      // Fail-closed: drift or disabled → no session memory.
      mgr.config.enabled = false;
      action = resolved.config.enabled ? "blocked-version-drift" : "disabled";
      provider = "disabled";
      if (resolved.config.enabled) {
        resolved.warnings.push(`Blackhole disabled: ${validation.reason}`);
      }
    }
    await emit(
      opts.ledger,
      "blackhole.lifecycle",
      { type: "system" },
      {
        action,
        version: resolved.config.version,
        provider,
        reason: validation.reason,
        warnings: resolved.warnings,
      },
    );
    return mgr;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  private sessionEntry(key: string, identity: SessionIdentity): MemoryStore {
    const nowMs = Date.now();
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastAccess = nowMs;
      return existing.store;
    }
    const store = this.adapter.openSession(identity);
    this.sessions.set(key, { store, lastAccess: nowMs });
    return store;
  }

  /**
   * Open a session-local memory store for a worker context. Strict isolation is
   * guaranteed by keying on the full SessionIdentity.
   */
  openSession(ctx: SessionContext): MemoryStore {
    if (!this.config.enabled) {
      // Disabled: return a throwaway store that is never populated/read so the
      // runtime behaves exactly as before (backward compatibility).
      const ident = newSessionIdentity(ctx);
      return new MemoryStore(ident, { compactionThreshold: this.config.compactionThreshold });
    }
    const identity = newSessionIdentity(ctx);
    return this.sessionEntry(sessionKey(identity), identity);
  }

  /** Open a memory store for a KNOWN identity (deterministic; for tests). */
  openSessionFor(identity: SessionIdentity): MemoryStore {
    if (!this.config.enabled)
      return new MemoryStore(identity, { compactionThreshold: this.config.compactionThreshold });
    return this.sessionEntry(sessionKey(identity), identity);
  }

  /** Recall the current working memory surface for a session (used by runWorker). */
  recall(identity: SessionIdentity, limit = 20): MemoryEntry[] {
    if (!this.config.enabled) return [];
    const key = sessionKey(identity);
    const entry = this.sessions.get(key);
    return entry ? entry.store.recall(limit) : [];
  }

  closeSession(store: MemoryStore): void {
    this.adapter.closeSession(store.key);
    this.sessions.delete(store.key);
  }

  /**
   * Session TTL GC: drop idle sessions (no access within sessionTtlMs) so
   * per-process session memory cannot grow unboundedly.
   */
  pruneIdleSessions(): number {
    const nowMs = Date.now();
    let removed = 0;
    for (const [key, s] of this.sessions) {
      if (nowMs - s.lastAccess > this.config.sessionTtlMs) {
        this.adapter.closeSession(key);
        this.sessions.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Run a background memory worker (P3/P4) for a parent session context. */
  async runMemoryWorker(
    role: MemoryWorkerRole,
    parent: SessionContext,
  ): Promise<{ entries: number; storeKey: string }> {
    if (!this.config.enabled) return { entries: 0, storeKey: "" };
    const factory: MemoryStoreFactory = { open: (c) => this.openSession(c) };
    const result = await runMemoryWorker(
      {
        storeFactory: factory,
        scheduler: this.scheduler,
        router: this.router,
        providers: this.providers,
        runInference: this.runInference,
        routes: this.config.routes,
      },
      role,
      parent,
    );
    this.memoryWorkersRun[role]++;
    await emit(
      this.ledger,
      "blackhole.memory_worker",
      { type: "system" },
      { role, priority: this.config.routes[role], entriesAdded: result.entriesAdded, storeKey: result.storeKey },
    );
    return { entries: result.entriesAdded, storeKey: result.storeKey };
  }

  /** Propose a promotion candidate (never auto-promoted). */
  async proposePromotion(opts: {
    store: MemoryStore;
    text: string;
    sourceRefs: string[];
    proposedBy: string;
    evidenceIds: string[];
  }): Promise<string> {
    const candidate = opts.store.proposePromotion(opts.text, opts.sourceRefs, opts.proposedBy, opts.evidenceIds);
    await emit(
      this.ledger,
      "blackhole.promotion.proposed",
      { type: "system" },
      { candidateId: candidate.id, text: candidate.text.slice(0, 200), evidenceIds: candidate.evidenceIds },
    );
    return candidate.id;
  }

  /** Decide a promotion candidate (evidence-gated; no auto-promotion). */
  async decidePromotion(
    store: MemoryStore,
    decision: PromotionDecision,
  ): Promise<{ state: string; promoted: boolean }> {
    const outcome = await decidePromotion({ store, durable: this.durable, decision, now: this.now });
    await emit(
      this.ledger,
      "blackhole.promotion.decided",
      { type: "system" },
      {
        candidateId: decision.candidateId,
        state: outcome.state,
        promoted: outcome.state === "promoted",
        decidedBy: decision.decidedBy,
        note: decision.note,
      },
    );
    return { state: outcome.state, promoted: outcome.state === "promoted" };
  }

  /** Compaction-quality degradation test hook: compact a session's store. */
  compact(store: MemoryStore): { removed: number; compactions: number } {
    const result = store.compact();
    return { removed: result.removed, compactions: store.compactionCount };
  }

  state(): BlackholeManagerState {
    this.pruneIdleSessions();
    const stores = [...this.sessions.values()].map((s) => s.store);
    const promo = stores.flatMap((s) => s.listPromotions());
    return {
      enabled: this.config.enabled,
      version: this.config.version,
      provider: this.config.enabled ? (this.adapter?.kind ?? "builtin") : "disabled",
      sessions: this.sessions.size,
      activeSessions: stores.filter((s) => s.size > 0).length,
      entries: stores.reduce((acc, s) => acc + s.size, 0),
      compactions: stores.reduce((acc, s) => acc + s.compactionCount, 0),
      promotionCandidates: promo.length,
      promoted: promo.filter((p) => p.state === "promoted").length,
      memoryWorkersRun: { ...this.memoryWorkersRun },
    };
  }
}

async function loadAdapter(config: BlackholeConfig): Promise<BlackholeAdapter> {
  const { loadBlackholeAdapter } = await import("./BlackholeAdapter.ts");
  return loadBlackholeAdapter(config);
}

async function defaultInference(_role: MemoryWorkerRole, contextText: string): Promise<string> {
  return `[no model] inferred from ${contextText.slice(0, 80) || "(empty)"}`;
}
