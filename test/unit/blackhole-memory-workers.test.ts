import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore } from "../../src/blackhole/MemoryStore.ts";
import { newSessionIdentity } from "../../src/blackhole/SessionStore.ts";
import { type MemoryStoreFactory, runMemoryWorker } from "../../src/blackhole/memoryWorkers.ts";
import { ModelRouter } from "../../src/routing/ModelRouter.ts";
import type { Capability } from "../../src/routing/ModelRouter.ts";
import { Scheduler } from "../../src/sched/Scheduler.ts";

const MEM_CAPS: Capability[] = ["cheap", "fast", "scout"];
const MEM_PROVIDERS = [{ id: "mem", name: "mem", capabilities: MEM_CAPS, quota: Number.POSITIVE_INFINITY }];

function factory(): MemoryStoreFactory {
  return { open: (c) => new MemoryStore(newSessionIdentity(c)) };
}

test("memory workers: observer runs at P3 and records to its own isolated store", async () => {
  const scheduler = new Scheduler({ concurrency: 2 });
  const router = new ModelRouter({ providers: MEM_PROVIDERS });
  const parent = { project: "p", workItem: "wi", role: "implementer" };
  const result = await runMemoryWorker(
    {
      storeFactory: factory(),
      scheduler,
      router,
      providers: MEM_PROVIDERS,
      runInference: async (_role, ctx) => `observed: ${ctx.slice(0, 40)}`,
      routes: { observer: "mem", reflector: "mem", dropper: "mem" },
    },
    "observer",
    parent,
  );
  assert.equal(result.role, "observer");
  assert.equal(result.entriesAdded, 1);
  assert.match(result.summary, /observed/);
  // The observer's store is keyed separately from the parent's.
  assert.notEqual(result.storeKey, parent.workItem);
});

test("memory workers: background inference is bounded by scheduler concurrency (backpressure)", async () => {
  const scheduler = new Scheduler({ concurrency: 1 });
  const router = new ModelRouter({ providers: MEM_PROVIDERS });
  const providers = MEM_PROVIDERS;
  let active = 0;
  let maxActive = 0;
  const parent = { project: "p", workItem: "wi", role: "implementer" };
  const tasks = ["observer", "reflector", "dropper"] as const;
  await Promise.all(
    tasks.map((role) =>
      runMemoryWorker(
        {
          storeFactory: factory(),
          scheduler,
          router,
          providers,
          runInference: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            return "inferred";
          },
          routes: { observer: "mem", reflector: "mem", dropper: "mem" },
        },
        role,
        parent,
      ),
    ),
  );
  assert.ok(maxActive <= 1, `concurrency cap violated: ${maxActive} active`);
});
