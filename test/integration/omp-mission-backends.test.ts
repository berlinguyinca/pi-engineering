/**
 * The production mission worker path on a REAL omp (gated on OMP_BIN; offline scripted model).
 * The mission goldens use stub BrokerBackends that never reach a WorkerExecutor, so this is where the OMP
 * worker meets missions: `realBackends` runs agent and review tasks through `opts.worker`, which is the
 * same executor `EngineeringRuntime` selects under the omp flags.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { selectOmpWorker } from "../../src/omp/selectWorker.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { engineerModelScript, realOmpEnv, startOfflineOmp } from "../support/ompOffline.ts";
import type { ModelScript } from "../support/scriptedModelServer.ts";

const skip = realOmpEnv() ? false : "UNVERIFIED: OMP_BIN not set; no real omp available";
const REVIEW = {
  verdict: "request_changes",
  summary: "changes required",
  findings: [
    { severity: "high", title: "missing null check", detail: "add() does not guard its inputs", file: "src/add.js" },
  ],
  missing_tests: [],
  spec_gaps: [],
  acceptance_results: [],
};
const ADD_OK = "export function add(a, b) {\n  return a + b;\n}\n";

describe("mission backends on the omp worker (real omp)", { skip }, () => {
  it("agent and review tasks run on omp processes through realBackends", async () => {
    const fx = await makeFixtureRepo();
    const inner = engineerModelScript({ implement: ADD_OK });
    // The mission reviewer's terminating tool is the structured review_result (not worker_result details).
    const script: ModelScript = (turn) =>
      /# Role: reviewer/.test(turn.system) && turn.toolNames.includes("review_result") && turn.priorCalls.length === 0
        ? { kind: "tool", name: "review_result", args: REVIEW }
        : inner(turn);
    const offline = await startOfflineOmp(script);
    try {
      const picked = await selectOmpWorker(
        () => ({
          run: async () => {
            throw new Error("the legacy executor must never run");
          },
        }),
        offline.env,
      );
      assert.equal(picked?.selection.path, "omp");
      const backends = realBackends({
        worker: picked!.executor,
        verifier: {} as never,
        artifacts: {} as never,
        git: null,
        cwd: fx.root,
      });
      const signal = new AbortController().signal;
      const agent = await backends.agent.runAgent({
        role: "implementer",
        objective: "implement add",
        worktree: fx.root,
        signal,
      });
      assert.equal(agent.exitStatus, "succeeded", agent.error);
      assert.equal(await readFile(join(fx.root, "src", "add.js"), "utf8"), ADD_OK);

      const review = await backends.review.runReview({ objective: "review add", worktree: fx.root, signal });
      assert.equal(review.exitStatus, "succeeded", review.error);
      assert.equal(review.findings?.length, 1);
      assert.match(JSON.stringify(review.findings), /missing null check/);
    } finally {
      await offline.close();
      await fx.cleanup();
    }
  });
});
