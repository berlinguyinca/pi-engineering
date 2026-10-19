/** Real host retries against a loopback provider; never sends a live model request. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerTerminalRefusalGuard } from "../../src/gateway/terminalRefusalGuard.ts";

// Also exercise a deployed host SDK with PI_TEST_SDK_ENTRY=/absolute/path/to/dist/index.js.
const { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } = (await import(
  process.env.PI_TEST_SDK_ENTRY ?? "@earendil-works/pi-coding-agent"
)) as typeof import("@earendil-works/pi-coding-agent");

const TERMINAL = {
  action: "do_not_retry",
  action_code: "IW-ACT-DO-NOT-RETRY",
  code: "invalid_upstream_response",
  message: "The upstream returned unsupported error guidance; do not automatically replay this request.",
  reason: "invalid_upstream_response",
  replay_safe: false,
  request_id: "80bba64a-76f6-44a5-9797-807bd3d68ae8",
  request_state: "unknown",
  retryable: false,
  scope: "model",
  type: "inferweave_backpressure",
};

async function exercise(options: { guard: boolean; terminal: boolean }) {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      if (options.terminal || requests === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify(options.terminal ? { error: TERMINAL } : { error: { message: "503 temporary overload" } }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "canary", object: "chat.completion.chunk", created: 0, model: "canary" };
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Recovered" }, finish_reason: null }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "terminal-refusal-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerProvider("canary", {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      apiKey: "local-only",
      api: "openai-completions",
      models: [
        {
          id: "canary",
          name: "canary",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262144,
          maxTokens: 1024,
        },
      ],
    } as never);
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: options.guard ? [registerTerminalRefusalGuard] : [],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir,
      model: runtime.getModel("canary", "canary") as never,
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(root),
      tools: [],
    }));
    await session.bindExtensions({});
    let retries = 0;
    const errors: string[] = [];
    session.subscribe((event) => {
      if (event.type === "auto_retry_start") retries++;
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.errorMessage) {
        errors.push(event.message.errorMessage);
      }
    });
    await session.prompt("local retry canary");
    const messages = session.agent.state.messages;
    const persisted = session.sessionManager.getEntries().filter((entry) => entry.type === "message");
    return { requests, retries, errors, messages: structuredClone(messages), persisted: structuredClone(persisted) };
  } finally {
    session?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(root, { recursive: true, force: true });
  }
}

test("real SDK retries the terminal 503 without the extension guard (regression control)", async () => {
  const result = await exercise({ guard: false, terminal: true });
  assert.equal(result.requests, 4);
  assert.equal(result.retries, 3);
});

test("terminal refusal makes exactly one HTTP request and retains the original error with retries enabled", async () => {
  const result = await exercise({ guard: true, terminal: true });
  assert.equal(result.requests, 1, JSON.stringify(result.errors));
  assert.equal(result.retries, 0);
  assert.equal(result.errors.length, 1);
  const error = result.messages.filter((message) => message.role === "assistant").at(-1);
  assert.equal(error?.stopReason, "error");
  assert.equal(error?.errorMessage, `503: ${JSON.stringify(TERMINAL)}`);
  assert.equal(result.errors[0], error?.errorMessage);
  assert.ok(
    result.persisted.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.errorMessage === error?.errorMessage,
    ),
  );
});

test("ordinary transient 503 still retries and succeeds with the guard installed", async () => {
  const result = await exercise({ guard: true, terminal: false });
  assert.equal(result.requests, 2);
  assert.equal(result.retries, 1);
  assert.equal(result.messages.filter((message) => message.role === "assistant").at(-1)?.stopReason, "stop");
});
