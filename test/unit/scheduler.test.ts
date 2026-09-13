import assert from "node:assert/strict";
import { test } from "node:test";
import { Scheduler } from "../../src/sched/Scheduler.ts";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("scheduler: limits concurrency (backpressure)", async () => {
  const s = new Scheduler({ concurrency: 2 });
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, (_, i) => ({
    id: `t${i}`,
    source: "a",
    run: async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(20);
      active--;
      return i;
    },
  }));
  const out = await s.scheduleAll(tasks);
  assert.equal(peak, 2);
  assert.equal(out.length, 6);
});

test("scheduler: fairness — a heavy source cannot starve a light source", async () => {
  const s = new Scheduler({ concurrency: 1 });
  const order: string[] = [];
  const tasks = [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `heavy${i}`,
      source: "heavy",
      run: async () => {
        order.push(`heavy${i}`);
        await delay(5);
      },
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `light${i}`,
      source: "light",
      run: async () => {
        order.push(`light${i}`);
        await delay(5);
      },
    })),
  ];
  await s.scheduleAll(tasks);
  // With weighted round-robin, light tasks interleave with heavy ones.
  const lightPositions = order.map((x, i) => (x.startsWith("light") ? i : -1)).filter((i) => i >= 0);
  assert.ok(lightPositions[0]! < 5, `light source was starved: ${order.join(",")}`);
});

test("scheduler: queued count reflects backpressure", async () => {
  const s = new Scheduler({ concurrency: 1 });
  const gate = (async () => {})(); // not used; just keep simple
  void gate;
  let release: (() => void) | undefined;
  const blocker = new Promise<void>((r) => {
    release = r;
  });
  const first = s.schedule({
    id: "block",
    source: "a",
    run: async () => {
      await blocker;
    },
  });
  const second = s.schedule({ id: "wait", source: "a", run: async () => "done" });
  await delay(5);
  assert.equal(s.inFlight, 1);
  assert.equal(s.queued, 1);
  release!();
  await first;
  assert.equal((await second).value, "done");
  await s.drain();
});

test("scheduler: speculative execution runs copies of the same task and keeps the first success", async () => {
  const s = new Scheduler({ concurrency: 4 });
  const ctl = new AbortController();
  let calls = 0;
  const val = await s.speculative(
    3,
    async () => {
      calls++;
      await delay(5);
      return `v${calls}`;
    },
    ctl.signal,
  );
  assert.match(val, /^v/);
  assert.equal(calls, 3, "all copies launched (bounded by concurrency)");
});

test("scheduler: speculative never launches more copies than concurrency", async () => {
  const s = new Scheduler({ concurrency: 2 });
  let calls = 0;
  await s.speculative(10, async () => {
    calls++;
    await delay(1);
    return "x";
  });
  assert.equal(calls, 2, "speculation is bounded by concurrency");
});

test("scheduler: deficit round-robin never starves the light source", async () => {
  const s = new Scheduler({ concurrency: 1 });
  const order: string[] = [];
  const tasks = [
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `heavy${i}`,
      source: "heavy",
      weight: 3,
      run: async () => {
        order.push(`heavy${i}`);
        await delay(1);
      },
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `light${i}`,
      source: "light",
      weight: 1,
      run: async () => {
        order.push(`light${i}`);
        await delay(1);
      },
    })),
  ];
  await s.scheduleAll(tasks);
  const firstLight = order.findIndex((x) => x.startsWith("light"));
  assert.ok(firstLight >= 0 && firstLight < 4, `light source was starved: ${order.join(",")}`);
});

test("scheduler: drain waits for all work", async () => {
  const s = new Scheduler({ concurrency: 1 });
  let done = 0;
  const tasks = Array.from({ length: 4 }, (_, i) => ({
    id: `d${i}`,
    source: "a",
    run: async () => {
      await delay(10);
      done++;
    },
  }));
  const p = s.scheduleAll(tasks);
  await p;
  assert.equal(done, 4);
  await s.drain();
});
