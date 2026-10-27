/** Real Pi transport proof: smaller-model requests receive the bounded handoff. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { registerPlannerWorker } from "../../src/plannerWorker/extension.ts";

for (const mode of ["planner", "production"] as const) {
  for (const trigger of ["manual", "threshold", "overflow"] as const) {
    test(
      `SDK ${mode}: handoff survives reload and ${trigger} compaction without hidden history`,
      { timeout: 30000 },
      async () => {
        const requests: Array<{
          model: string;
          messages: Array<{ role: string; content: unknown }>;
          tools?: unknown[];
          max_tokens?: number;
          max_completion_tokens?: number;
        }> = [];
        let responseUsage = 1500;
        let forceOverflow = false;
        let summaryRequests = 0;
        const server = createServer((req, res) => {
          let raw = "";
          req.on("data", (chunk) => {
            raw += chunk;
          });
          req.on("end", () => {
            const request = JSON.parse(raw);
            requests.push(request);
            const summary = raw.includes("You are a context summarization assistant.");
            if (summary) summaryRequests++;
            if (forceOverflow && !summary && raw.includes("Trigger overflow recovery")) {
              forceOverflow = false;
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: { message: "maximum context length is 16000 tokens" } }));
              return;
            }
            // Deterministic loopback admission counts the COMPLETE serialized payload,
            // including system prompt and tool schemas, plus the output reservation.
            if (Math.ceil(raw.length / 4) + (request.max_tokens ?? request.max_completion_tokens ?? 0) > 16000) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: { message: "context window exceeded" } }));
              return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            const base = { id: "handoff", object: "chat.completion.chunk", created: 0, model: "small" };
            res.write(
              `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Work continued" }, finish_reason: null }] })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: responseUsage, completion_tokens: 3, total_tokens: responseUsage + 3 } })}\n\n`,
            );
            res.end("data: [DONE]\n\n");
            responseUsage = 1500;
          });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const root = mkdtempSync(join(tmpdir(), "handoff-request-"));
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
          runtime.registerProvider("handoff-local", {
            baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
            apiKey: "local-only",
            api: "openai-completions",
            models: [
              ["big", 200000],
              ["small", 16000],
            ].map(([id, contextWindow]) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text"],
              contextWindow,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            })),
          } as never);
          const settingsManager = SettingsManager.inMemory({
            retry: { enabled: false },
            compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 2048 },
          });
          const loader = new DefaultResourceLoader({
            cwd: root,
            agentDir,
            settingsManager,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
              mode === "production"
                ? (await import("../../extensions/index.ts")).default
                : (pi) => {
                    registerPlannerWorker(pi, { host: async () => ({ repoRoot: root, worker: null }) as never });
                  },
            ],
          });
          await loader.reload();
          const manager = SessionManager.inMemory(root);
          for (let i = 0; i < 20; i++) {
            manager.appendMessage({
              role: "user",
              content: `OLD_HISTORY_MUST_BE_DROPPED ${"irrelevant old task details ".repeat(500)}`,
              timestamp: i,
            });
          }
          manager.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "Health route belongs in src/health.ts" }],
            timestamp: 2,
            api: "openai-completions",
            provider: "handoff-local",
            model: "big",
            stopReason: "stop",
            usage: {
              input: 70000,
              output: 20,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 70020,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          });
          manager.appendMessage({ role: "user", content: "Add health endpoint metrics", timestamp: 3 });
          ({ session } = await createAgentSession({
            cwd: root,
            agentDir,
            model: runtime.getModel("handoff-local", "big"),
            modelRuntime: runtime,
            resourceLoader: loader,
            settingsManager,
            sessionManager: manager,
            tools: ["read"],
          }));
          const errors: string[] = [];
          await session.bindExtensions({ onError: (error) => errors.push(JSON.stringify(error)) });
          assert.ok((session.getContextUsage()?.tokens ?? 0) > 16000);
          await session.setModel(runtime.getModel("handoff-local", "small")!);
          await session.prompt("Continue with the metrics implementation");
          assert.equal(requests.length, 1);
          assert.equal(requests[0]!.model, "small");
          assert.ok(requests[0]!.tools?.length, "real tool schema is preserved by Pi");
          assert.ok(
            requests[0]!.messages.some((message) => message.role === "system" || message.role === "developer"),
            "Pi restores its system prompt",
          );
          assert.equal((session.agent.state.messages.at(-1) as { stopReason?: string }).stopReason, "stop");
          const first = JSON.stringify(requests[0]!.messages);
          assert.ok(first.length / 4 + 4096 < 16000, `request plus reserve must fit: ${first.length} chars`);
          assert.ok(!first.includes("OLD_HISTORY_MUST_BE_DROPPED"));
          assert.match(first, /Add health endpoint metrics/);
          assert.match(first, /Continue with the metrics implementation/);
          if (mode === "planner")
            assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 0);
          // Reload invalidates extension closures; the branch marker must restore projection.
          await session.reload();
          await session.prompt("Now verify the endpoint");
          assert.equal(requests.length, 2);
          const second = JSON.stringify(requests[1]!.messages);
          assert.ok(!second.includes("OLD_HISTORY_MUST_BE_DROPPED"));
          assert.match(second, /Work continued/);
          assert.match(second, /Now verify the endpoint/);
          assert.deepEqual(errors, []);
          // More successor history than the retained suffix budget: compaction
          // must actually summarize its prefix, not just preserve the whole tail.
          for (let i = 0; i < 10; i++) {
            manager.appendMessage({
              role: "user",
              content: `SUCCESSOR_CONTEXT_${i} ${"successor implementation details ".repeat(60)}`,
              timestamp: 100 + i,
            });
          }
          await session.reload();
          const beforeCompactions = manager.getEntries().filter((entry) => entry.type === "compaction").length;
          if (trigger === "manual") await session.compact();
          if (trigger === "threshold") {
            responseUsage = 13000;
            await session.prompt("Trigger threshold compaction");
          }
          if (trigger === "overflow") {
            forceOverflow = true;
            await session.prompt("Trigger overflow recovery");
          }
          assert.ok(
            manager.getEntries().filter((entry) => entry.type === "compaction").length > beforeCompactions,
            "native lifecycle commits a valid successor boundary",
          );
          await session.prompt("Confirm verification after compaction");
          assert.ok(
            requests.every((request) => !JSON.stringify(request).includes("OLD_HISTORY_MUST_BE_DROPPED")),
            "no summary/retry/follow-up may revive hidden history",
          );
          assert.ok(summaryRequests > 0, "successor prefix is summarized by the real transport");
          assert.equal((session.agent.state.messages.at(-1) as { stopReason?: string }).stopReason, "stop");
          assert.deepEqual(errors, []);
        } finally {
          if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session?.dispose();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }
}
