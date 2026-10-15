/**
 * Silent stream truncation through the REAL worker executor: a local
 * OpenAI-compatible HTTP server, pi-ai's own openai-completions provider, and
 * PiWorkerExecutor's retry layers.
 *
 * A gateway that closes the SSE stream before any `finish_reason` makes pi-ai
 * report "Stream ended without finish_reason" as an assistant-message error —
 * nothing is thrown. The executor must hand that to the transient layer for a
 * fresh-session retry, unless the session already delivered its terminating
 * result.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { isResilientRuntime } from "../../src/inference/resilientStream.ts";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

type Reply = (res: ServerResponse) => void;

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const body = {
    id: "chatcmpl-probe",
    object: "chat.completion.chunk",
    created: 0,
    model: "probe-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

function sse(res: ServerResponse, frames: string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) res.write(f);
  res.end("data: [DONE]\n\n");
}

/** A stream that ends with no finish_reason: the gateway's silent cut. */
const truncated: Reply = (res) => sse(res, [chunk({ role: "assistant", content: "" })]);

function toolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>): Reply {
  return (res) =>
    sse(res, [
      chunk({
        role: "assistant",
        tool_calls: calls.map((c, index) => ({
          index,
          id: `call_${index}`,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      }),
      chunk({}, "tool_calls"),
    ]);
}

const WORKER_RESULT = {
  status: "completed",
  summary: "done after a fresh session",
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
};

const REVIEW_RESULT = {
  verdict: "approve",
  summary: "no blocking defect",
  findings: [],
  missing_tests: [],
  spec_gaps: [],
  acceptance_results: [],
};

async function withProbe(
  replies: Reply[],
  body: (executor: PiWorkerExecutor, cwd: string, bodies: string[]) => Promise<void>,
) {
  const requests: number[] = [];
  const bodies: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d));
    req.on("end", () => {
      bodies.push(Buffer.concat(parts).toString("utf8"));
      requests.push(requests.length);
      const reply = replies[requests.length - 1];
      if (reply) reply(res);
      else res.writeHead(500).end("unexpected extra request");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-truncation-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "probe-model", contextWindow: 100_000, maxTokens: 4096 }],
        },
      },
    }),
  );
  writeFileSync(join(dir, "note.txt"), "hello\n");
  const executor = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: false }),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  try {
    await body(executor, dir, bodies);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return requests.length;
}

test("worker: a stream cut before any finish_reason is retried in a fresh session", async () => {
  const requests = await withProbe(
    [truncated, toolCalls([{ name: "worker_result", args: WORKER_RESULT }])],
    async (executor, cwd) => {
      const run = await executor.run({
        role: "implementer",
        task: "t",
        tools: [],
        cwd,
        modelOverride: { provider: "probe", id: "probe-model" },
      });
      assert.equal(run.result.status, "completed", run.result.summary);
      assert.equal(run.result.summary, WORKER_RESULT.summary);
      assert.equal(executor.transientTelemetry.exhausted, 0);
    },
  );
  assert.equal(requests, 2, "one truncated attempt, one fresh retry");
});

test("worker: the production checkpoint tool emits candidate-bound progress for two of three deliverables", async () => {
  await withProbe(
    [
      toolCalls([
        {
          name: "checkpoint_progress",
          args: {
            claims: [
              { deliverable: "implementation", candidate_sha: "abc123", evidence_paths: ["src/a.ts"] },
              { deliverable: "tests", candidate_sha: "abc123", evidence_paths: ["test/a.test.ts"] },
            ],
          },
        },
        { name: "worker_result", args: WORKER_RESULT },
      ]),
    ],
    async (executor, cwd) => {
      const activities: unknown[] = [];
      const run = await executor.run({
        role: "implementer",
        task: "implement and test",
        tools: ["checkpoint_progress"],
        cwd,
        deliverables: ["implementation", "tests", "docs"],
        isolatedWorktree: true,
        onActivity: (activity) => activities.push(activity),
        modelOverride: { provider: "probe", id: "probe-model" },
      });
      assert.equal(run.result.status, "completed");
      assert.deepEqual(
        activities.filter((activity: any) => activity.kind === "checkpoint"),
        [
          {
            kind: "checkpoint",
            summary: "Checkpoint progress recorded",
            meaningfulProgress: true,
            claims: [
              { deliverable: "implementation", candidateSha: "abc123", evidencePaths: ["src/a.ts"], artifactRefs: [] },
              { deliverable: "tests", candidateSha: "abc123", evidencePaths: ["test/a.test.ts"], artifactRefs: [] },
            ],
          },
        ],
      );
    },
  );
});

test("reviewer: a cut AFTER review_result was delivered does not re-run the review", async () => {
  // review_result arrives alongside a non-terminating tool, so the loop takes
  // one more turn — and that turn is cut. The verdict was already delivered, so
  // a fresh-session retry would throw it away and pay for the review twice.
  const requests = await withProbe(
    [
      toolCalls([
        { name: "review_result", args: REVIEW_RESULT },
        { name: "read", args: { path: "note.txt" } },
      ]),
      truncated,
    ],
    async (executor, cwd) => {
      const run = await executor.run({
        role: "reviewer",
        task: "review",
        tools: ["read"],
        cwd,
        resultTool: "review_result",
        modelOverride: { provider: "probe", id: "probe-model" },
      });
      assert.equal(run.result.status, "completed", run.result.summary);
      assert.equal((run.structured as { verdict?: string } | undefined)?.verdict, "approve");
    },
  );
  assert.equal(requests, 2, "the delivered verdict must not be thrown away and re-run in a fresh session");
});

test("worker: a cut AFTER a tool ran is not replayed in a fresh session (resume disabled)", async () => {
  // Replaying from a fresh session would re-run every tool (bash included)
  // under a brand-new wall-clock budget. Fail with a distinct, non-transient
  // marker instead so the cause is visible and no infra retry kicks in.
  const requests = await withProbe(
    [toolCalls([{ name: "read", args: { path: "note.txt" } }]), truncated],
    async (_executor, cwd) => {
      // Resuming disabled: the pre-resume settlement.
      const executor = new PiWorkerExecutor({
        agentDir: cwd,
        aps: false,
        gatewayConfig: resolveGatewayConfig({ enabled: false }),
        transientSleep: async () => {},
        transientRand: () => 0,
        streamResumeMax: 0,
      });
      const run = await executor.run({
        role: "implementer",
        task: "t",
        tools: ["read"],
        cwd,
        modelOverride: { provider: "probe", id: "probe-model" },
      });
      assert.equal(run.result.status, "failed");
      assert.equal(run.error, "truncated_after_progress");
      assert.match(run.result.summary, /Stream ended without finish_reason/);
    },
  );
  assert.equal(requests, 2, "no fresh-session replay after a tool ran");
});

/** A stream cut mid-message: some text is out, then no finish_reason. */
const cutMidMessage: Reply = (res) => sse(res, [chunk({ role: "assistant", content: "PARTIAL-DRAFT-TEXT" })]);

const bashMarker = toolCalls([
  { name: "bash", args: { command: "echo marker-123 >> side-effect.txt; cat side-effect.txt" } },
]);

const bashRun = (executor: PiWorkerExecutor, cwd: string) =>
  executor.run({
    role: "implementer",
    task: "t",
    tools: ["bash"],
    cwd,
    modelOverride: { provider: "probe", id: "probe-model" },
  });

/** The resumed request keeps the executed tool call and its result, and drops the partial message. */
function assertResumedHistory(body: string): void {
  const messages = (JSON.parse(body) as { messages: Array<Record<string, any>> }).messages;
  const call = messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  assert.equal(call?.tool_calls[0].id, "call_0");
  assert.equal(call?.tool_calls[0].function.name, "bash");
  const result = messages.find((m) => m.role === "tool");
  assert.equal(result?.tool_call_id, "call_0");
  assert.match(JSON.stringify(result?.content), /marker-123\\n/);
  assert.doesNotMatch(body, /PARTIAL-DRAFT-TEXT/);
  assert.equal(messages.filter((m) => m.role === "assistant").length, 1, "only the executed turn remains");
}

test("worker: a cut after a tool ran resumes in the same session without replaying the tool", async () => {
  const requests = await withProbe(
    [bashMarker, cutMidMessage, toolCalls([{ name: "worker_result", args: WORKER_RESULT }])],
    async (executor, cwd, bodies) => {
      const run = await bashRun(executor, cwd);
      assert.equal(run.result.status, "completed", run.result.summary);
      assert.equal(run.usage?.streamResumes, 1);
      assert.equal(
        readFileSync(join(cwd, "side-effect.txt"), "utf8"),
        "marker-123\n",
        "the executed tool must not run again",
      );
      assertResumedHistory(bodies[2]!);
    },
  );
  assert.equal(requests, 3, "tool turn, cut turn, resumed turn: one session");
});

test("worker: resume triggers through the armed resilient stream layer (production path)", async () => {
  const requests = await withProbe(
    [bashMarker, cutMidMessage, toolCalls([{ name: "worker_result", args: WORKER_RESULT }])],
    async (executor, cwd, bodies) => {
      assert.equal(isResilientRuntime(await executor.getModelRuntime()), true, "resilient layer must be armed");
      const run = await bashRun(executor, cwd);
      assert.equal(run.result.status, "completed", run.result.summary);
      assert.equal(run.usage?.streamResumes, 1);
      assert.equal(readFileSync(join(cwd, "side-effect.txt"), "utf8"), "marker-123\n");
      assertResumedHistory(bodies[2]!);
    },
  );
  assert.equal(requests, 3);
});

test("worker: a connection cut after a tool ran is resumed as well", async () => {
  await withProbe(
    [bashMarker, socketCut, toolCalls([{ name: "worker_result", args: WORKER_RESULT }])],
    async (executor, cwd) => {
      const run = await bashRun(executor, cwd);
      assert.equal(run.result.status, "completed", run.result.summary);
      assert.equal(run.usage?.streamResumes, 1);
    },
  );
});

test("worker: resumes are capped; the next cut settles truncated_after_progress", async () => {
  const requests = await withProbe(
    [bashMarker, cutMidMessage, cutMidMessage, cutMidMessage, cutMidMessage],
    async (executor, cwd) => {
      const run = await bashRun(executor, cwd);
      assert.equal(run.result.status, "failed");
      assert.equal(run.error, "truncated_after_progress");
      assert.equal(run.usage?.streamResumes, 3);
    },
  );
  assert.equal(requests, 5, "one tool turn, three resumed cuts, the fourth cut settles");
});

test("worker: the resume cap is configurable", async () => {
  const requests = await withProbe([bashMarker, cutMidMessage, cutMidMessage], async (_e, cwd) => {
    const executor = new PiWorkerExecutor({
      agentDir: cwd,
      aps: false,
      gatewayConfig: resolveGatewayConfig({ enabled: false }),
      transientSleep: async () => {},
      transientRand: () => 0,
      streamResumeMax: 1,
    });
    const run = await bashRun(executor, cwd);
    assert.equal(run.error, "truncated_after_progress");
    assert.equal(run.usage?.streamResumes, 1);
  });
  assert.equal(requests, 3);
});

/** The gateway restarts under the stream: the socket closes mid-body. */
const socketCut: Reply = (res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content: "" }));
  setTimeout(() => res.socket?.destroy(), 20);
};

test("worker: a connection cut before any tool ran (undici 'terminated') is retried in a fresh session", async () => {
  const requests = await withProbe(
    [socketCut, toolCalls([{ name: "worker_result", args: WORKER_RESULT }])],
    async (executor, cwd) => {
      const run = await executor.run({
        role: "implementer",
        task: "t",
        tools: [],
        cwd,
        modelOverride: { provider: "probe", id: "probe-model" },
      });
      assert.equal(run.result.status, "completed", run.result.summary);
    },
  );
  assert.equal(requests, 2, "one cut attempt, one fresh retry");
});

/** The restarting gateway accepts the connection and closes it before any head. */
const closedBeforeHead: Reply = (res) => {
  res.socket?.destroy();
};

test("worker: a connection closed before any response head is retried (SDK 'Connection error.')", async () => {
  const requests = await withProbe(
    [closedBeforeHead, toolCalls([{ name: "worker_result", args: WORKER_RESULT }])],
    async (executor, cwd) => {
      const run = await executor.run({
        role: "implementer",
        task: "t",
        tools: [],
        cwd,
        modelOverride: { provider: "probe", id: "probe-model" },
      });
      assert.equal(run.result.status, "completed", run.result.summary);
    },
  );
  assert.equal(requests, 2);
});

test("broker deadline preceding the worker timer is classified as a wall-clock timeout", async () => {
  const slowerThanBroker: Reply = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ role: "assistant", content: "working" }));
    setTimeout(() => res.end("data: [DONE]\n\n"), 150);
  };
  await withProbe([slowerThanBroker], async (executor, cwd) => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = store.createMission({
      title: "deadline",
      goal: "deadline",
      user_request: "deadline",
      repository: cwd,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "wait forever",
    });
    const broker = new ExecutionBroker({
      store,
      defaultTimeoutMs: 30,
      backends: realBackends({
        worker: executor,
        verifier: {} as never,
        artifacts: {} as never,
        git: null,
        cwd,
        routeModel: async () => ({ provider: "probe", id: "probe-model" }),
      }),
    });

    const outcome = await (
      await broker.execute({
        taskId: task.task_id,
        missionId: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "wait forever",
      })
    ).result();

    assert.equal(outcome.exitStatus, "failed");
    assert.equal(outcome.error, "timeout");
    assert.equal(store.listExecutions(mission.mission_id)[0]?.status, "FAILED");
  });
});

test("worker: a model_not_found failure names the model the attempt ran on", async () => {
  // Unrouted work runs on the executor default. When that model is gone the
  // failure must say which model it was, so the takeover marks the right one.
  const notFound: Reply = (res) =>
    res
      .writeHead(404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { code: "model_not_found", message: "model_not_found: probe-model" } }));
  await withProbe([notFound, notFound, notFound, notFound], async (executor, cwd) => {
    const run = await executor.run({ role: "implementer", task: "t", tools: [], cwd });
    assert.equal(run.result.error, "transient:model_unavailable", run.result.summary);
    assert.deepEqual(run.result.details.model, { provider: "probe", id: "probe-model" });
  });
});
