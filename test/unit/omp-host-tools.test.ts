import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { OmpWorkerExecutor } from "../../src/omp/OmpWorkerExecutor.ts";
import { buildHostTools, isCheckpointTool, replacementName, toHostToolSpec } from "../../src/omp/hostTools.ts";
import { ompToolsFor } from "../../src/omp/rpcTranslate.ts";
import {
  FallbackWorkerExecutor,
  OMP_WORKER_ENV,
  acceptsCustomTools,
  selectOmpWorker,
} from "../../src/omp/selectWorker.ts";
import type { WorkerActivity, WorkerExecutor, WorkerRequest } from "../../src/workers/WorkerExecutor.ts";

const FAKE = fileURLToPath(new URL("../support/fakeOmpRpc.mjs", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("../fixtures/omp-frames/agent-turn-write-then-worker-result.jsonl", import.meta.url),
);
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "omp-ht-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const echo = defineTool({
  name: "echo_tool",
  label: "Echo",
  description: "echoes",
  parameters: Type.Object({ text: Type.String() }),
  async execute(_id, params, _signal, _update, ctx) {
    return {
      content: [
        {
          type: "text",
          text: `${params.text}@${(ctx as { cwd: string }).cwd}`,
        },
      ],
      details: { n: 1 },
    };
  },
}) as unknown as ToolDefinition;
const boom = defineTool({
  name: "boom_tool",
  label: "Boom",
  description: "throws",
  parameters: Type.Object({}),
  async execute() {
    throw new Error("kaboom");
  },
}) as unknown as ToolDefinition;
const soft = defineTool({
  name: "soft_tool",
  label: "Soft",
  description: "isError result",
  parameters: Type.Object({}),
  async execute() {
    return {
      content: [{ type: "text", text: "nope" }],
      details: { found: false },
      isError: true,
    };
  },
}) as unknown as ToolDefinition;

const req = (over: Partial<WorkerRequest> = {}): WorkerRequest => ({
  role: "scout",
  task: "t",
  tools: ["echo_tool", "boom_tool", "soft_tool", "secret_tool"],
  cwd: tmp(),
  ...over,
});

describe("buildHostTools", () => {
  it("applies the request allowlist and never offers result tools", async () => {
    const plan = await buildHostTools(req({ tools: ["echo_tool", "worker_result"] }), [echo, boom]);
    assert.deepEqual([...plan.tools.keys()], ["echo_tool"]);
    assert.equal(plan.replaced.size, 0);
  });

  it("offers claim_deliverable and checkpoint_progress only with declared deliverables", async () => {
    const tools = ["claim_deliverable", "checkpoint_progress"];
    assert.equal((await buildHostTools(req({ tools }), [])).tools.size, 0);
    const plan = await buildHostTools(req({ tools, deliverables: ["A"] }), []);
    assert.deepEqual([...plan.tools.keys()].sort(), ["checkpoint_progress", "claim_deliverable"]);
  });

  it("an isolated worktree replaces write/edit with pe_ twins and reports what to switch off", async () => {
    const plan = await buildHostTools(req({ tools: ["read", "write", "edit"], isolatedWorktree: true }), []);
    assert.deepEqual([...plan.tools.keys()].sort(), ["pe_edit", "pe_write"]);
    assert.deepEqual([...plan.replaced].sort(), ["edit", "write"]);
    assert.equal(replacementName("read"), "pe_read");
    assert.equal(plan.tools.get("pe_write")?.name, "pe_write");
  });

  it("tolerant file tools replace read and edit; without isolation no write twin appears", async () => {
    const plan = await buildHostTools(req({ tools: ["read", "write", "edit"], tolerantFileTools: true }), []);
    assert.deepEqual([...plan.tools.keys()].sort(), ["pe_edit", "pe_read"]);
  });

  it("a replaced read does not leave `ls` re-enabling omp's built-in read: ls is served host-side", async () => {
    const plan = await buildHostTools(req({ tools: ["read", "ls"], tolerantFileTools: true }), []);
    assert.deepEqual([...plan.tools.keys()].sort(), ["pe_ls", "pe_read"]);
    assert.deepEqual([...plan.replaced].sort(), ["ls", "read"]);
    const builtin = ompToolsFor(["read", "ls"].filter((n) => !plan.replaced.has(n))).builtin;
    assert.deepEqual(builtin, [], "omp's own read stays off");
    const untouched = await buildHostTools(req({ tools: ["read", "ls"] }), []);
    assert.equal(untouched.tools.size, 0, "without a read replacement ls keeps its omp mapping");
  });

  it("toHostToolSpec carries PE's schema and description verbatim", () => {
    const spec = toHostToolSpec(echo);
    assert.deepEqual(spec.parameters, JSON.parse(JSON.stringify(echo.parameters)));
    assert.equal(spec.description, "echoes");
    assert.equal(spec.loadMode, "essential");
    assert.equal(isCheckpointTool("claim_deliverable"), true);
    assert.equal(isCheckpointTool("echo_tool"), false);
  });
});

describe("OmpWorkerExecutor host tool calls (real child speaking the rpc protocol)", () => {
  const run = async (calls: unknown[], r: WorkerRequest, tools: ToolDefinition[] = [echo, boom, soft]) => {
    const results = join(tmp(), "results.jsonl");
    const executor = new OmpWorkerExecutor({
      launch: { command: process.execPath, args: [FAKE] },
      env: {
        ...process.env,
        FAKE_OMP_MODE: "calls",
        FAKE_OMP_FIXTURE: FIXTURE,
        FAKE_OMP_CALLS: JSON.stringify(calls),
        FAKE_OMP_RESULTS: results,
        FAKE_OMP_FINAL: JSON.stringify({ status: "completed", summary: "fin" }),
      },
      startTimeoutMs: 2_000,
    });
    executor.setCustomTools(tools);
    const out = await executor.run(r);
    const frames = readFileSync(results, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { out, frames };
  };

  it("registers the allowlisted tools with PE's schemas and executes them host side with the run cwd", async () => {
    const r = req();
    const { out, frames } = await run([["echo_tool", { text: "hi" }]], r);
    assert.equal(out.result.status, "completed");
    const set = frames.find((f) => f.type === "set_host_tools") as {
      tools: Array<{ name: string; parameters: unknown }>;
    };
    assert.deepEqual(
      set.tools.map((t) => t.name),
      ["worker_result", "echo_tool", "boom_tool", "soft_tool"],
    );
    assert.deepEqual(set.tools[1]?.parameters, JSON.parse(JSON.stringify(echo.parameters)));
    const result = frames.find((f) => f.id === "h0") as {
      isError?: boolean;
      result: { content: Array<{ text: string }> };
    };
    assert.equal(result.result.content[0]?.text, `hi@${r.cwd}`);
    assert.equal(result.isError, undefined);
  });

  it("a throwing tool and an isError result both come back as host tool errors", async () => {
    const { frames } = await run(
      [
        ["boom_tool", {}],
        ["soft_tool", {}],
      ],
      req(),
    );
    const [a, b] = ["h0", "h1"].map(
      (id) =>
        frames.find((f) => f.id === id) as {
          isError?: boolean;
          result: { content: Array<{ text: string }> };
        },
    );
    assert.equal(a?.isError, true);
    assert.equal(a?.result.content[0]?.text, "kaboom");
    assert.equal(b?.isError, true);
    assert.equal(b?.result.content[0]?.text, "nope");
  });

  it("a tool outside the allowlist or never registered is an unknown host tool", async () => {
    const secret = defineTool({
      name: "secret_tool",
      label: "s",
      description: "s",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "leak" }], details: {} };
      },
    }) as unknown as ToolDefinition;
    const { frames } = await run([["secret_tool", {}]], req({ tools: ["echo_tool"] }), [echo, secret]);
    const res = frames.find((f) => f.id === "h0") as {
      isError?: boolean;
      result: { content: Array<{ text: string }> };
    };
    assert.equal(res.isError, true);
    assert.match(res.result.content[0]?.text ?? "", /unknown host tool secret_tool/);
  });

  it("claim_deliverable reports its claims through onActivity as a checkpoint", async () => {
    const seen: WorkerActivity[] = [];
    await run(
      [["claim_deliverable", { deliverables: ["Alpha"] }]],
      req({
        tools: ["claim_deliverable"],
        deliverables: ["Alpha"],
        onActivity: (e) => seen.push(e),
      }),
      [],
    );
    const checkpoint = seen.find((e) => e.kind === "checkpoint");
    assert.equal(checkpoint?.meaningfulProgress, true);
    assert.equal(checkpoint?.claims?.[0]?.deliverable, "Alpha");
  });

  it("an inactivity timeout does not fire while a host tool call is in flight, and re-arms afterwards", async () => {
    const slow = defineTool({
      name: "slow_tool",
      label: "Slow",
      description: "slow",
      parameters: Type.Object({}),
      async execute() {
        await new Promise((r) => setTimeout(r, 900));
        return { content: [{ type: "text", text: "done" }], details: {} };
      },
    }) as unknown as ToolDefinition;
    const { out } = await run([["slow_tool", {}]], req({ tools: ["slow_tool"], timeoutMs: 300 }), [slow]);
    assert.equal(out.result.status, "completed", out.error);
  });

  it("an inactivity timeout still fires when omp goes silent with no host call in flight", async () => {
    const executor = new OmpWorkerExecutor({
      launch: { command: process.execPath, args: [FAKE] },
      env: { ...process.env, FAKE_OMP_MODE: "hang-after-prompt", FAKE_OMP_FIXTURE: FIXTURE },
      startTimeoutMs: 2_000,
    });
    const out = await executor.run(req({ tools: ["read"], timeoutMs: 300 }));
    assert.equal(out.result.status, "failed");
    assert.match(out.error ?? "", /no omp frame for 300ms/);
  });

  it("an aborted run does not deliver the result of a host call that was still executing", async () => {
    let sawAbort: boolean | undefined;
    const slow = defineTool({
      name: "slow_tool",
      label: "Slow",
      description: "slow",
      parameters: Type.Object({}),
      async execute(_id, _p, signal) {
        await new Promise((r) => setTimeout(r, 400));
        sawAbort = signal?.aborted;
        return { content: [{ type: "text", text: "late" }], details: {} };
      },
    }) as unknown as ToolDefinition;
    const ac = new AbortController();
    const results = join(tmp(), "results.jsonl");
    const executor = new OmpWorkerExecutor({
      launch: { command: process.execPath, args: [FAKE] },
      env: {
        ...process.env,
        FAKE_OMP_MODE: "calls",
        FAKE_OMP_FIXTURE: FIXTURE,
        FAKE_OMP_CALLS: JSON.stringify([["slow_tool", {}]]),
        FAKE_OMP_RESULTS: results,
      },
      startTimeoutMs: 2_000,
    });
    executor.setCustomTools([slow]);
    const pending = executor.run(req({ tools: ["slow_tool"], signal: ac.signal, timeoutMs: 60_000 }));
    setTimeout(() => ac.abort(), 150);
    const out = await pending;
    assert.match(out.error ?? "", /aborted by owner/);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(sawAbort, true, "the tool saw the run's abort signal");
  });

  it("every host tool executes through the omp path with a real worktree-bound context", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "a.txt"), "alpha\n");
    const r = req({
      cwd,
      tools: ["read", "ls", "write", "edit", "claim_deliverable", "checkpoint_progress"],
      tolerantFileTools: true,
      isolatedWorktree: true,
      deliverables: ["Alpha"],
    });
    const { out, frames } = await run(
      [
        ["pe_read", { path: "src/a.txt" }],
        ["pe_ls", { path: "src" }],
        ["pe_write", { path: "src/b.txt", content: "beta\n" }],
        ["pe_edit", { path: "src/a.txt", edits: [{ oldText: "alpha", newText: "gamma" }] }],
        ["claim_deliverable", { deliverables: ["Alpha"] }],
        [
          "checkpoint_progress",
          { claims: [{ deliverable: "Alpha", candidate_sha: "abc123", evidence_paths: ["src/a.txt"] }] },
        ],
      ],
      r,
      [],
    );
    assert.equal(out.result.status, "completed", out.error);
    const results = frames.filter((f) => typeof f.id === "string" && /^h\d$/.test(f.id as string));
    const errors = results.filter((f) => f.isError === true).map((f) => JSON.stringify(f));
    assert.equal(results.length, 7, "six tool calls plus the result tool");
    assert.deepEqual(errors, [], "every host tool succeeds against the worker cwd");
    assert.equal(readFileSync(join(cwd, "src", "b.txt"), "utf8"), "beta\n");
    assert.match(readFileSync(join(cwd, "src", "a.txt"), "utf8"), /gamma/);
  });

  it("every worker process carries the mission-depth marker one deeper", async () => {
    const log = join(tmp(), "log.jsonl");
    const executor = new OmpWorkerExecutor({
      launch: { command: process.execPath, args: [FAKE] },
      env: {
        ...process.env,
        PI_MISSION_DEPTH: "2",
        FAKE_OMP_MODE: "replay",
        FAKE_OMP_FIXTURE: FIXTURE,
        FAKE_OMP_LOG: log,
      },
    });
    await executor.run(req({ tools: ["read"] }));
    assert.equal((JSON.parse(readFileSync(log, "utf8").trim()) as { depth: string }).depth, "3");
  });
});

describe("custom tool binding", () => {
  it("FallbackWorkerExecutor hands the tools to both executors that accept them", () => {
    const got: ToolDefinition[][] = [];
    const sink: WorkerExecutor & { setCustomTools(t: ToolDefinition[]): void } = {
      run: async () => ({ result: {} as never, usage: null }),
      setCustomTools: (t) => got.push(t),
    };
    const plain: WorkerExecutor = {
      run: async () => ({ result: {} as never, usage: null }),
    };
    new FallbackWorkerExecutor(sink, sink).setCustomTools([echo]);
    new FallbackWorkerExecutor(plain, sink).setCustomTools([boom]);
    assert.deepEqual(
      got.map((g) => g.map((t) => t.name)),
      [["echo_tool"], ["echo_tool"], ["boom_tool"]],
    );
    assert.equal(acceptsCustomTools(sink), true);
    assert.equal(acceptsCustomTools(plain), false);
    assert.equal(acceptsCustomTools(null), false);
  });
});

describe("process lifecycle", () => {
  it("negotiates once per open; every worker run is a fresh omp process", async () => {
    const log = join(tmp(), "log.jsonl");
    const env = {
      ...process.env,
      [OMP_WORKER_ENV]: "1",
      PI_ENGINEERING_OMP_ADAPTER: "1",
      PI_ENGINEERING_OMP_BIN: process.execPath,
      PI_ENGINEERING_OMP_BIN_ARGS: FAKE,
      PI_ENGINEERING_OMP_MODEL: "x/y",
      FAKE_OMP_MODE: "replay",
      FAKE_OMP_FIXTURE: FIXTURE,
      FAKE_OMP_LOG: log,
    };
    const picked = await selectOmpWorker(() => ({ run: async () => ({ result: {} as never, usage: null }) }), env);
    assert.equal(picked?.selection.path, "omp");
    const lines = () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { pid: number; argv: string[] });
    const negotiation = lines().length;
    assert.ok(negotiation >= 1 && negotiation <= 2, `negotiation processes: ${negotiation}`);
    for (let i = 0; i < 3; i++) await picked!.executor.run(req({ tools: ["read"], role: "implementer" }));
    const afterRuns = lines();
    assert.equal(afterRuns.length, negotiation + 3, "three runs add exactly three processes, no re-negotiation");
    const workers = afterRuns.slice(negotiation);
    assert.equal(new Set(workers.map((w) => w.pid)).size, 3, "each run is a distinct process");
    for (const w of workers) assert.ok(w.argv.includes("--no-session") && w.argv.includes("--config"));
  });
});
