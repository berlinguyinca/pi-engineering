/**
 * Lower-priority background memory workers (Observer / Reflector / Dropper).
 *
 * These run at priority classes P3/P4 and are routed through the ModelRouter
 * (capability: cheap/fast) and scheduled through the Scheduler with backpressure
 * so they can never preempt or starve P0–P2 engineering work. They operate only
 * on their OWN session store (strict isolation) and record results as memory
 * entries with source refs.
 */

import { newRunId } from "../core/ids.ts";
import { type ModelProvider, ModelRouter } from "../routing/ModelRouter.ts";
import type { ScheduledOutcome, Scheduler } from "../sched/Scheduler.ts";
import type { MemoryStore } from "./MemoryStore.ts";
import { type SessionContext, memoryWorkerIdentity, newSessionIdentity } from "./SessionStore.ts";
import { MEMORY_WORKER_PRIORITIES, type MemoryWorkerRole } from "./types.ts";

export interface MemoryWorkerResult {
  role: MemoryWorkerRole;
  storeKey: string;
  entriesAdded: number;
  summary: string;
}

/** A worker session factory: open a fresh memory store for the given context. */
export interface MemoryStoreFactory {
  open(ctx: SessionContext): MemoryStore;
}

export interface MemoryWorkerOptions {
  storeFactory: MemoryStoreFactory;
  scheduler: Scheduler;
  router: ModelRouter;
  /** Providers the router may select among (cheap/fast memory work). */
  providers: ModelProvider[];
  /**
   * A task body that produces memory text from a role + parent context. In
   * production this is a worker execution; in tests it is injected deterministically.
   */
  runInference: (role: MemoryWorkerRole, contextText: string) => Promise<string>;
  /** Route table: role → provider id (defaults to router selection). */
  routes: Record<MemoryWorkerRole, string>;
}

/**
 * Run one background memory worker for a parent session. The worker observes
 * only the parent identity's OWN session and writes to its own (child) session.
 */
export async function runMemoryWorker(
  opts: MemoryWorkerOptions,
  role: MemoryWorkerRole,
  parent: SessionContext,
): Promise<MemoryWorkerResult> {
  const parentStore = opts.storeFactory.open(parent);
  const parentIdentity = parentStore.identity;
  const childIdentity = memoryWorkerIdentity(parentIdentity, role);
  const childStore = opts.storeFactory.open(childIdentity);
  const providerId = opts.routes[role];
  // Route through the ModelRouter for a cheap/fast capability (scout). The
  // configured route id is preferred; otherwise the router picks the best
  // eligible provider. Memory inference never requires a distinct model.
  let provider = opts.providers.find((p) => p.id === providerId && p.quota > 0);
  if (!provider) {
    const routed = opts.router.route("scout");
    provider = routed?.provider ?? opts.providers[0];
  }
  if (!provider) throw new Error(`no provider for memory role ${role} (${providerId})`);

  const priority = MEMORY_WORKER_PRIORITIES[role];
  // Recall the parent's working memory as the context for this worker.
  const contextText = parentStore
    .recall(20)
    .map((e) => `[${e.priority}] ${e.text}`)
    .join("\n");

  const run: () => Promise<string> = () => opts.runInference(role, contextText);

  // Schedule at the worker's priority class: background inference is bounded by
  // the scheduler's concurrency cap, so it can never saturate resources.
  const outcome: ScheduledOutcome<string> = await opts.scheduler.schedule({
    id: `${role}-${newRunId().slice(4)}`,
    source: `memory-${priority}`,
    weight: priority === "P3" ? 1 : 0.5,
    run,
  });
  const text = outcome.value;

  const entry =
    role === "observer"
      ? childStore.observe(text, [parentIdentity.runId, provider.id], priority)
      : role === "reflector"
        ? childStore.reflect(text, [parentIdentity.runId, provider.id], priority)
        : childStore.drop(text, [parentIdentity.runId, provider.id], priority);

  return { role, storeKey: childStore.key, entriesAdded: 1, summary: entry.text };
}

/** Convenience: build a ModelRouter over memory-capable providers. */
export function buildMemoryRouter(providers: ModelProvider[]): ModelRouter {
  return new ModelRouter({ providers });
}
