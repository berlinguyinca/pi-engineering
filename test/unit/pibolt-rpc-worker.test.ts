import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiBoltRpcWorkerExecutor, parseWorkerText } from "../../src/workers/PiBoltRpcWorkerExecutor.ts";
import type { WorkerRequest } from "../../src/workers/WorkerExecutor.ts";

/** A stand-in RPC runtime: answers a prompt with one tool call and an end, then serves the last assistant text. */
function fake(finalText: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "rpc-worker-"));
  const bin = join(dir, "fakepi.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import readline from "node:readline";
const text = ${JSON.stringify(finalText)};
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const c = JSON.parse(l);
  if (c.type === "prompt" && text !== null) {
    console.log(JSON.stringify({ type: "response", command: "prompt", success: true }));
    console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read" }));
    console.log(JSON.stringify({ type: "agent_end", messages: [] }));
  } else if (c.type === "get_last_assistant_text") {
    console.log(JSON.stringify({ id: c.id, type: "response", command: "get_last_assistant_text", success: true, data: { text } }));
  } else if (c.type === "abort") { process.exit(0); }
});
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin };
}

const req = (over: Partial<WorkerRequest> = {}): WorkerRequest => ({
  role: "scout",
  task: "look",
  tools: ["read", "worker_result"],
  cwd: tmpdir(),
  ...over,
});

test("a JSON result in the final message becomes a WorkerResult, with the tool-call count", async () => {
  const f = fake('```json\n{"status":"completed","summary":"ok","claims":[{"claim":"c","evidence":"e"}]}\n```');
  try {
    const run = await new PiBoltRpcWorkerExecutor({ binary: f.bin, model: "p/m" }).run(req());
    assert.equal(run.result.status, "completed");
    assert.equal(run.result.summary, "ok");
    assert.equal(run.result.claims.length, 1);
    assert.equal(run.toolCalls, 1);
    assert.equal(run.error, undefined);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a final message without a result object is a failed run, not a silent success", async () => {
  const f = fake("I think it went fine.");
  try {
    const run = await new PiBoltRpcWorkerExecutor({ binary: f.bin, model: "p/m" }).run(req());
    assert.equal(run.result.status, "failed");
    assert.match(run.error ?? "", /did not return a result object/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("cancellation aborts a silent runtime and reports canceled", async () => {
  const f = fake(null); // never answers the prompt
  try {
    const ac = new AbortController();
    const p = new PiBoltRpcWorkerExecutor({ binary: f.bin, model: "p/m" }).run(req({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 300);
    const run = await p;
    assert.equal(run.result.status, "failed");
    assert.match(run.error ?? "", /canceled|exited/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("inactivity timeout ends a hung runtime", async () => {
  const f = fake(null);
  try {
    const run = await new PiBoltRpcWorkerExecutor({ binary: f.bin, model: "p/m", timeoutMs: 400 }).run(req());
    assert.match(run.error ?? "", /no session event/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a missing binary fails cleanly", async () => {
  const run = await new PiBoltRpcWorkerExecutor({ binary: "/nonexistent/pi", model: "p/m" }).run(req());
  assert.equal(run.result.status, "failed");
  assert.match(run.error ?? "", /spawn failed|exited/);
});

test("parseWorkerText rejects an unknown status", () => {
  assert.equal(parseWorkerText('{"status":"done","summary":"x"}').status, "failed");
});
