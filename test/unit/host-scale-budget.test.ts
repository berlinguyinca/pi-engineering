/**
 * The host-scaled run budget used by `orchestration-broker-recovery.test.ts`
 * (ci pipeline 311, 2026-11-18: a fixed 6s budget on a host ~5x slower than an
 * idle one turned an ordering property into a red test).
 *
 * What is pinned here is the SCALING CONTRACT, deterministically: the budget is
 * floored so a fast host pays nothing, proportional so a slow host stretches the
 * window, capped so a wedged host still fails, and the unit it scales from is a
 * measurement of real durable work — it moves when the host moves.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { measureRoundTripMs, scaledBudgetMs } from "../support/hostScale.ts";

const floor = (unitMs: number): number => scaledBudgetMs(unitMs);

test("a fast host pays the floor: scaling adds no wall-clock cost", () => {
  assert.equal(floor(1), 6_000);
  assert.equal(floor(300), 6_000);
});

test("a slow host gets a proportionally longer window", () => {
  // 1.5s per durable round-trip is roughly what pipeline 311's host needed for
  // the checkpoint sequence that expired against the old fixed 5s.
  assert.equal(floor(1_500), 30_000);
  assert.equal(floor(1_500) / 1_500, floor(3_000) / 3_000);
});

test("a wedged host is capped, so the test still fails instead of hanging", () => {
  assert.equal(floor(10_000), 120_000);
  assert.equal(floor(1_000_000), 120_000);
});

test("the unit is a measurement: competing for the event loop moves it", async () => {
  const root = await mkdtemp(`${tmpdir()}/host-scale-test-`);
  const artifacts = await ArtifactStore.create(root);
  try {
    const idle = await measureRoundTripMs(artifacts);

    // Block the loop in 60ms slices while the same measurement runs. The
    // measurement awaits artifact writes and finding writes on this loop, so it
    // must observe the contention rather than report a constant.
    let stop = false;
    const hogging = (async () => {
      const until = (ms: number): void => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          /* burn the slice */
        }
      };
      while (!stop) {
        until(60);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
    const loaded = await measureRoundTripMs(artifacts);
    stop = true;
    await hogging;

    assert.ok(
      loaded.unitMs >= 60,
      `a blocked event loop must show up in the measurement (idle ${idle.unitMs}ms, loaded ${loaded.unitMs}ms)`,
    );
    assert.ok(
      loaded.unitMs > idle.unitMs,
      `the measured unit must track the host (idle ${idle.unitMs}ms, loaded ${loaded.unitMs}ms)`,
    );
    assert.ok(scaledBudgetMs(loaded.unitMs) >= scaledBudgetMs(idle.unitMs));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
