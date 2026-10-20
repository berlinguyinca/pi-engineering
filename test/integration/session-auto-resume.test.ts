/** Real SDK session restoration against a loopback model; no live provider calls. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SESSION_RECOVERY_PROMPT, sessionRecovery } from "../../src/gateway/sessionAutoResume.ts";

const { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } = (await import(
  process.env.PI_TEST_SDK_ENTRY ?? "@earendil-works/pi-coding-agent"
)) as typeof import("@earendil-works/pi-coding-agent");

test("restoring a failed session automatically continues with the replacement model", { timeout: 15000 }, async () => {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "recovery", object: "chat.completion.chunk", created: 0, model: "replacement" };
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Continued existing work" }, finish_reason: null }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "session-auto-resume-"));
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
          id: "replacement",
          name: "replacement",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262144,
          maxTokens: 1024,
        },
      ],
    } as never);
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: "canary",
      defaultModel: "replacement",
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(root);
    manager.appendModelChange("canary", "removed-model");
    manager.appendMessage({ role: "user", content: "Finish the existing work", timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      api: "openai-completions",
      provider: "canary",
      model: "removed-model",
      content: [],
      stopReason: "error",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      errorMessage: `429: ${JSON.stringify({
        type: "inferweave_backpressure",
        reason: "capacity_unavailable",
        retryable: true,
        replay_safe: true,
        request_state: "not_started",
        action: "retry_alternate",
        action_code: "IW-ACT-RETRY-ALTERNATE",
      })}`,
    });
    assert.ok(sessionRecovery(manager.getBranch()));
    const result = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      tools: [],
    });
    session = result.session;
    assert.match(result.modelFallbackMessage ?? "", /Using canary\/replacement/);
    const settled = new Promise<void>((resolve) =>
      session!.subscribe((event) => {
        if (event.type === "agent_end") resolve();
      }),
    );
    const errors: string[] = [];
    await session.bindExtensions({ mode: "tui", onError: (e) => errors.push(e.error) });
    assert.equal(bodies.length, 0, "no inference before startup finishes");
    await session.prompt(SESSION_RECOVERY_PROMPT);
    await settled;
    assert.deepEqual(errors, []);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].model, "replacement");
    assert.ok(bodies[0].messages.some((m: any) => JSON.stringify(m.content).includes("Finish the existing work")));
    assert.ok(bodies[0].messages.some((m: any) => JSON.stringify(m.content).includes("Continue the existing work")));
    assert.equal(session.agent.state.messages.at(-1)?.role, "assistant");
    assert.equal((session.agent.state.messages.at(-1) as any).stopReason, "stop");
  } finally {
    session?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
