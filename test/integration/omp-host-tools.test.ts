/**
 * PE custom tools as OMP host tools, proved against a REAL omp (gated on OMP_BIN; offline scripted model).
 * Tools execute in PE: a tool call through omp must return exactly what the same tool returns when PE runs
 * it directly, and the per-role allowlist decides what the model is offered.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OmpWorkerExecutor } from "../../src/omp/OmpWorkerExecutor.ts";
import { OMP_HOME_ENV, OMP_MODEL_ENV } from "../../src/omp/selectWorker.ts";
import { MISSION_DEPTH_ENV } from "../../src/orchestration/missionMode.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { realOmpEnv, startOfflineOmp } from "../support/ompOffline.ts";
import type { ScriptReply, ScriptTurn } from "../support/scriptedModelServer.ts";

const real = realOmpEnv();
const skip = real ? false : "UNVERIFIED: OMP_BIN not set; no real omp available";

const READ_ONLY = ["read", "grep", "find", "ls", "ledger_read", "artifact_read", "repo_search", "symbol", "tests_for"];
const done = {
  status: "completed",
  summary: "ok",
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
  details: {},
};

describe("PE tools exposed to a real omp worker as host tools", { skip }, () => {
  it("repo_search, symbol, ledger_read and artifact_read return what PE returns, under the role allowlist", async () => {
    const fx = await makeFixtureRepo();
    let artifactUri = "";
    const calls: Array<[string, Record<string, unknown>]> = [
      ["repo_search", { query: "add", limit: 5 }],
      ["symbol", { path: "src/add.js", limit: 10 }],
      ["ledger_read", { kind: "decision" }],
      ["artifact_read", { uri: "" }],
    ];
    const script = (turn: ScriptTurn): ScriptReply => {
      const n = turn.priorCalls.length;
      if (n < calls.length) {
        const [name, args] = calls[n]!;
        return {
          kind: "tool",
          name,
          args: name === "artifact_read" ? { uri: artifactUri } : args,
        };
      }
      return n === calls.length ? { kind: "tool", name: "worker_result", args: done } : { kind: "text", text: "done" };
    };
    const offline = await startOfflineOmp(script);
    const rt = await EngineeringRuntime.open({
      cwd: fx.root,
      worker: new OmpWorkerExecutor({
        launch: {
          command: real!.bin,
          args: real!.args.split(/\s+/).filter(Boolean),
        },
        model: offline.env[OMP_MODEL_ENV],
        home: offline.env[OMP_HOME_ENV],
        env: offline.env,
      }),
      verifier: new CommandVerifier(),
    });
    try {
      artifactUri = (await rt.artifacts.put("log", "host-tools", "artifact body line", "a log")).uri;
      const run = await rt.worker.run({
        role: "scout",
        task: "inspect",
        tools: READ_ONLY,
        cwd: fx.root,
      });
      assert.equal(run.result.status, "completed", run.error);
      const turn = offline.server.turns.filter((t) => t.toolNames.length > 0).at(-1)!;
      for (const name of ["repo_search", "symbol", "ledger_read", "artifact_read", "worker_result"]) {
        assert.ok(turn.toolNames.includes(name), `${name} offered`);
      }
      assert.ok(
        !turn.toolNames.includes("write") && !turn.toolNames.includes("bash"),
        "role allowlist excludes writers",
      );
      for (const [i, [name, args]] of calls.entries()) {
        const tool = rt.coreTools.find((t) => t.name === name)!;
        const direct = await tool.execute(
          "direct",
          (name === "artifact_read" ? { uri: artifactUri } : args) as never,
          undefined,
          undefined,
          { cwd: fx.root } as never,
        );
        const expected = direct.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.equal(turn.toolResults[i], expected, `${name} result through omp equals PE direct`);
      }
      assert.match(turn.toolResults[1]!, /add/);
      assert.match(turn.toolResults[3]!, /artifact body line/);
    } finally {
      await rt.close();
      await offline.close();
      await fx.cleanup();
    }
  });

  it("a tool outside the request allowlist is not offered to the model", async () => {
    const fx = await makeFixtureRepo();
    const offline = await startOfflineOmp((turn) =>
      turn.priorCalls.length === 0
        ? { kind: "tool", name: "worker_result", args: done }
        : { kind: "text", text: "done" },
    );
    const rt = await EngineeringRuntime.open({
      cwd: fx.root,
      worker: new OmpWorkerExecutor({
        launch: {
          command: real!.bin,
          args: real!.args.split(/\s+/).filter(Boolean),
        },
        model: offline.env[OMP_MODEL_ENV],
        home: offline.env[OMP_HOME_ENV],
        env: offline.env,
      }),
      verifier: new CommandVerifier(),
    });
    try {
      await rt.worker.run({
        role: "scout",
        task: "inspect",
        tools: ["read", "repo_search"],
        cwd: fx.root,
      });
      const turn = offline.server.turns.find((t) => t.toolNames.length > 0)!;
      assert.ok(turn.toolNames.includes("repo_search"));
      for (const name of ["symbol", "ledger_read", "artifact_read", "tests_for", "mission", "write", "bash"]) {
        assert.ok(!turn.toolNames.includes(name), `${name} must not be offered`);
      }
    } finally {
      await rt.close();
      await offline.close();
      await fx.cleanup();
    }
  });

  it("an isolated worktree gets PE's confined pe_write instead of omp's write; bash runs one mission-depth deeper", async () => {
    const fx = await makeFixtureRepo();
    const outside = join(tmpdir(), `pe-escape-${process.pid}.txt`);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["pe_write", { path: outside, content: "escaped" }],
      ["pe_write", { path: "src/inside.js", content: "ok" }],
      ["bash", { command: `printenv ${MISSION_DEPTH_ENV}` }],
    ];
    const offline = await startOfflineOmp((turn) => {
      const n = turn.priorCalls.length;
      if (n < calls.length) return { kind: "tool", name: calls[n]![0], args: calls[n]![1] };
      return n === calls.length ? { kind: "tool", name: "worker_result", args: done } : { kind: "text", text: "done" };
    });
    const rt = await EngineeringRuntime.open({
      cwd: fx.root,
      worker: new OmpWorkerExecutor({
        launch: {
          command: real!.bin,
          args: real!.args.split(/\s+/).filter(Boolean),
        },
        model: offline.env[OMP_MODEL_ENV],
        home: offline.env[OMP_HOME_ENV],
        env: offline.env,
      }),
      verifier: new CommandVerifier(),
    });
    try {
      await rt.worker.run({
        role: "implementer",
        task: "write",
        tools: ["read", "write", "bash"],
        cwd: fx.root,
        isolatedWorktree: true,
      });
      assert.equal(existsSync(outside), false, "the write outside the worktree must be refused");
      assert.equal(readFileSync(join(fx.root, "src", "inside.js"), "utf8"), "ok");
      const turn = offline.server.turns.filter((t) => t.toolNames.length > 0).at(-1)!;
      assert.match(turn.toolResults[0]!, /outside assigned worktree/);
      assert.match(turn.toolResults[2]!, /^1\s*$/m);
      assert.ok(turn.toolNames.includes("pe_write") && !turn.toolNames.includes("write"), "confined write only");
      assert.ok(turn.toolNames.includes("bash"));
    } finally {
      rmSync(outside, { force: true });
      await rt.close();
      await offline.close();
      await fx.cleanup();
    }
  });
});
