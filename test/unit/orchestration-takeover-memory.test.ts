/**
 * A scheduler relaunch of the same task must not re-walk the takeover list
 * from scratch: models its earlier walks found dead are carried (bounded by a
 * TTL), reset when the operator pin changes, and never applied to an
 * explicitly pinned model. See RETRY-OWNERS.md.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ModelRef, modelKey } from "../../src/lifecycle/types.ts";
import { type ModelRoute, realBackends } from "../../src/orchestration/realBackends.ts";
import type { WorkerRequest, WorkerRun } from "../../src/workers/WorkerExecutor.ts";

const M = (id: string): ModelRef => ({ provider: "gw", id });
const A = M("a");
const B = M("b");
const C = M("c");
const POOL = [A, B, C];

const failed = (): WorkerRun => ({
  result: {
    status: "failed",
    summary: "Worker failed: 503 no capacity",
    error: "transient:server_unavailable",
    claims: [],
    evidence_refs: [],
    new_hypotheses: [],
    proposed_tasks: [],
    details: {},
  },
  usage: null,
  toolCalls: 0,
});
const ok = (): WorkerRun => ({
  result: {
    status: "completed",
    summary: "done",
    claims: [],
    evidence_refs: [],
    new_hypotheses: [],
    proposed_tasks: [],
    details: {},
  },
  usage: null,
  toolCalls: 0,
});

function setup(extra: { pinOf?: () => ModelRef | null; pinned?: () => boolean; ttl?: number } = {}) {
  const dead = new Set([modelKey(A), modelKey(B)]);
  const seen: string[] = [];
  let now = 0;
  const backends = realBackends({
    worker: {
      async run(req: WorkerRequest) {
        const m = modelKey(req.modelOverride as ModelRef);
        seen.push(m);
        return dead.has(m) ? failed() : ok();
      },
    },
    verifier: {} as never,
    artifacts: { readContentByUri: async () => undefined } as never,
    git: null,
    cwd: "/repo",
    now: () => now,
    ...(extra.ttl !== undefined ? { takeoverMemoryTtlMs: extra.ttl } : {}),
    ...(extra.pinOf ? { currentOperatorPin: extra.pinOf } : {}),
    routeModel: async (_role, o): Promise<ModelRoute | undefined> => {
      const left = POOL.filter((m) => !(o?.exclude ?? []).some((x) => modelKey(x) === modelKey(m)));
      const first = left[0];
      return first ? { ...first, ...(extra.pinned?.() ? { operatorPin: true } : {}) } : undefined;
    },
  });
  const run = (taskId = "T1") =>
    backends.agent.runAgent({
      role: "implementer",
      objective: "x",
      missionId: "MSN-1",
      taskId,
      signal: new AbortController().signal,
    });
  return {
    seen,
    run,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("takeover memory across scheduler relaunches", () => {
  it("a relaunch starts after the models the task already found dead", async () => {
    const h = setup();
    await h.run();
    assert.deepEqual(h.seen, ["gw/a", "gw/b", "gw/c"], "first walk");
    h.seen.length = 0;
    await h.run();
    assert.deepEqual(h.seen, ["gw/c"], "relaunch skips a and b");
  });

  it("is per task: another task still walks from the top", async () => {
    const h = setup();
    await h.run("T1");
    h.seen.length = 0;
    await h.run("T2");
    assert.deepEqual(h.seen, ["gw/a", "gw/b", "gw/c"]);
  });

  it("forgets after the TTL", async () => {
    const h = setup({ ttl: 1000 });
    await h.run();
    h.seen.length = 0;
    h.advance(1001);
    await h.run();
    assert.deepEqual(h.seen, ["gw/a", "gw/b", "gw/c"], "expired: walks again");
  });

  it("a changed operator pin resets the memory", async () => {
    let pin: ModelRef | null = null;
    const h = setup({ pinOf: () => pin });
    await h.run();
    h.seen.length = 0;
    pin = C;
    await h.run();
    assert.deepEqual(h.seen, ["gw/a", "gw/b", "gw/c"], "new pin: nothing is excluded");
  });

  it("never excludes an explicitly pinned model", async () => {
    let pinned = false;
    const h = setup({ pinned: () => pinned });
    await h.run();
    h.seen.length = 0;
    pinned = true;
    await h.run();
    assert.equal(h.seen[0], "gw/a", "the pinned model is run, not swapped for a remembered-dead exclusion");
  });

  it("a pinned model that fails is not remembered", async () => {
    const h = setup({ pinned: () => true });
    await h.run();
    h.seen.length = 0;
    await h.run();
    assert.equal(h.seen[0], "gw/a");
  });

  it("memory disabled with ttl 0 keeps the old behaviour", async () => {
    const h = setup({ ttl: 0 });
    await h.run();
    h.seen.length = 0;
    await h.run();
    assert.deepEqual(h.seen, ["gw/a", "gw/b", "gw/c"]);
  });
});
