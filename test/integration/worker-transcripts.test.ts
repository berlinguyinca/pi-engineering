/**
 * Persisted worker transcripts through the REAL worker executor: a local
 * OpenAI-compatible HTTP server and pi-ai's own provider. No mocks.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "probe-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function toolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      chunk({
        role: "assistant",
        tool_calls: calls.map((c, index) => ({
          index,
          id: `call_${index}`,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      }),
    );
    res.write(chunk({}, "tool_calls"));
    res.end("data: [DONE]\n\n");
  };
}

const WORKER_RESULT = {
  status: "completed",
  summary: "done",
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
};

async function withRun(
  noteText: string,
  env: Record<string, string | undefined>,
  body: (transcript: string | null, stateRoot: string, activities: any[]) => void,
) {
  const saved: Record<string, string | undefined> = {};
  const stateRoot = mkdtempSync(join(tmpdir(), "pi-transcript-state-"));
  const overrides = { PI_ENGINEERING_STATE_DIR: stateRoot, ...env };
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const replies = [
    toolCalls([{ name: "read", args: { path: "note.txt" } }]),
    toolCalls([{ name: "worker_result", args: WORKER_RESULT }]),
  ];
  let n = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => (replies[n++] ?? ((r: ServerResponse) => r.writeHead(500).end()))(res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-transcript-"));
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
  writeFileSync(join(dir, "note.txt"), noteText);
  const executor = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: false }),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  const activities: unknown[] = [];
  try {
    const run = await executor.run({
      role: "implementer",
      task: "t",
      tools: ["read"],
      cwd: dir,
      runId: "m1",
      sessionId: "e1",
      onActivity: (a) => activities.push(a),
      modelOverride: { provider: "probe", id: "probe-model" },
    });
    assert.equal(run.result.status, "completed", run.result.summary);
    const wt = join(stateRoot, "worktrees");
    let found: string | null = null;
    if (existsSync(wt)) {
      for (const id of readdirSync(wt)) {
        const f = join(wt, id, "transcripts", "m1", "e1.jsonl");
        if (existsSync(f)) found = f;
      }
    }
    body(found, stateRoot, activities);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const lines = (f: string) =>
  readFileSync(f, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("transcript: tool call, result, stop reason and model are persisted", async () => {
  await withRun("hello note\n", {}, (file, _root, activities) => {
    assert.ok(file, "transcript file under <state>/worktrees/<id>/transcripts/<mission>/<execution>.jsonl");
    const recs = lines(file);
    assert.ok(recs.every((r) => typeof r.at === "string"));
    const assistant = recs.filter((r) => r.kind === "message" && r.role === "assistant");
    assert.ok(assistant.length >= 1);
    assert.equal(assistant[0].model, "probe-model");
    assert.ok(assistant[0].stopReason);
    const toolRecs = recs.filter((r) => r.kind === "tool");
    const call = recs.find((r) => r.kind === "tool_call" && r.tool === "read");
    assert.match(JSON.stringify(call?.args), /note\.txt/);
    const read = toolRecs.find((r) => r.tool === "read");
    assert.ok(read, "read tool record");
    assert.match(String(read.result), /hello note/);
    assert.equal(read.isError, false);
    const turns = recs.filter((r) => r.kind === "turn");
    assert.ok(turns.length >= 1);
    assert.ok("stopReason" in turns[0] && "toolErrorCategory" in turns[0]);
    assert.ok(
      activities.some((a) => a.kind === "state" && /^Turn ended: stop=\w+ tool_error=\w+$/.test(a.summary)),
      "per-turn summary emitted as worker activity",
    );
  });
});

test("transcript: secrets are redacted", async () => {
  await withRun("password=hunter2secret and Bearer abcdefghijklmnopqrstuvwxyz123456\n", {}, (file) => {
    assert.ok(file);
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("hunter2secret"));
    assert.ok(!raw.includes("abcdefghijklmnopqrstuvwxyz123456"));
    assert.match(raw, /REDACTED/);
  });
});

test("transcript: size cap is honoured and rotated", async () => {
  await withRun("x".repeat(3000), { PI_WORKER_TRANSCRIPT_MAX_BYTES: "1500" }, (file) => {
    assert.ok(file);
    assert.ok(statSync(file).size <= 1500, `size ${statSync(file).size}`);
    assert.ok(existsSync(`${file}.1`), "rotated predecessor kept");
  });
});

test("transcript: PI_WORKER_TRANSCRIPTS=off writes nothing", async () => {
  await withRun("hello\n", { PI_WORKER_TRANSCRIPTS: "off" }, (file) => {
    assert.equal(file, null);
  });
});
