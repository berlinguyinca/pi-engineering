/**
 * Retrying a turn whose stream was cut AFTER partial output — in a REAL Pi
 * AgentSession, against a local OpenAI-compatible SSE server (node:http) that
 * cuts the stream mid-answer the way the gateway does.
 *
 * The user's settings have Pi's own retry disabled (`retry.enabled: false`),
 * so before this, a link cut after the first tokens ended the turn.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { AfterOutputRetry } from "../../src/gateway/afterOutputRetry.ts";
import { installGatewayStreamRetry, resetGatewayStreamRetry } from "../../src/gateway/installStreamRetry.ts";
import { setTelemetrySink } from "../../src/telemetry/sink.ts";

const LINK_CUT =
  "Connection lost: the route serving this model ended before the response did; the response is incomplete. Please retry your request: it is routed afresh.";

type Step =
  | { kind: "ok"; text: string }
  | { kind: "cut"; partial: string; error: string }
  | { kind: "destroy"; partial: string };

function sseServer() {
  const script: Step[] = [];
  const bodies: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}"));
      const step = script.shift() ?? { kind: "ok", text: "done" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c", object: "chat.completion.chunk", created: 0, model: "m" };
      const chunk = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const text = step.kind === "ok" ? step.text : step.partial;
      chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
      if (step.kind === "ok") {
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        chunk({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
        res.end("data: [DONE]\n\n");
      } else if (step.kind === "cut") {
        // What the gateway relays after a 200 head when a linked route drops.
        chunk({ error: { message: step.error, type: "inferweave_backpressure", code: "upstream_transport_error" } });
        res.end();
      } else {
        setTimeout(() => res.socket?.destroy(), 20);
      }
    });
  });
  return { server, script, bodies };
}

const gw = sseServer();
let baseUrl = "";
before(async () => {
  await new Promise<void>((resolve) => gw.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(gw.server.address() as { port: number }).port}/v1`;
});
after(() => {
  gw.server.close();
});

const FAST = { baseMs: 5, capMs: 20, jitter: 0, horizonMs: 60_000 };

async function startSession(
  opts: { retrySettings?: unknown; schedule?: Partial<typeof FAST>; unwrapped?: boolean } = {},
): Promise<{ session: Awaited<ReturnType<typeof createAgentSession>>["session"]; cleanup: () => void }> {
  gw.script.length = 0;
  gw.bodies.length = 0;
  const root = mkdtempSync(join(tmpdir(), "after-output-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  // The user's real setting: Pi's own retry is off.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: opts.retrySettings ?? { enabled: false } }));
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("gw", {
    baseUrl,
    apiKey: "k",
    api: "openai-completions",
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 32_768,
      },
    ],
  } as never);
  resetGatewayStreamRetry();
  const retry = new AfterOutputRetry({ schedule: { ...FAST, ...(opts.schedule ?? {}) } });
  const factory = (pi: { on(event: string, handler: (event: unknown, ctx: never) => unknown): void }) => {
    retry.register(pi as never);
    pi.on("session_start", (_e, ctx: { modelRegistry: unknown; model?: { provider: string; api: string } }) => {
      if (!ctx.model || opts.unwrapped) return;
      installGatewayStreamRetry(
        ctx.modelRegistry as never,
        { provider: ctx.model.provider, api: ctx.model.api },
        {
          createStream: () => createAssistantMessageEventStream() as never,
          hold: async () => {},
          errorMessage: (m: unknown, error) => ({
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: String(error),
            model: (m as { id: string }).id,
          }),
          beforeSend: (model, signal, context) => retry.beforeSend(model as never, signal, context as never),
          signalOf: (o) => (o as { signal?: AbortSignal } | undefined)?.signal,
        },
      );
    });
  };
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [factory as never],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: runtime.getModel("gw", "m") as never,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    tools: [],
  });
  await session.bindExtensions({});
  return {
    session,
    cleanup: () => {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type Session = Awaited<ReturnType<typeof startSession>>["session"];

function lastAssistant(session: Session) {
  const messages = session.agent.state.messages as Array<{ role: string; stopReason?: string; content?: unknown }>;
  return messages.filter((m) => m.role === "assistant").at(-1);
}

function text(message: { content?: unknown } | undefined): string {
  return Array.isArray(message?.content)
    ? (message.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
    : "";
}

test("a link cut after partial output is retried; the partial answer is dropped from context", async () => {
  const s = await startSession();
  try {
    gw.script.push(
      { kind: "cut", partial: "Hello wor", error: LINK_CUT },
      { kind: "ok", text: "Hello world, complete." },
    );
    await s.session.prompt("say hello");
    assert.equal(gw.bodies.length, 2, "one retry");
    assert.doesNotMatch(JSON.stringify(gw.bodies[1]?.messages), /Hello wor/, "the partial answer is not resent");
    const answer = lastAssistant(s.session);
    assert.equal(answer?.stopReason, "stop");
    assert.equal(text(answer), "Hello world, complete.");
    const visibleAssistants = (s.session.agent.state.messages as Array<{ role: string }>).filter(
      (m) => m.role === "assistant",
    );
    assert.equal(visibleAssistants.length, 1, "the cut attempt is omitted from the model's context");
  } finally {
    s.cleanup();
  }
});

test("a socket dropped mid-stream ('terminated') is retried too", async () => {
  const s = await startSession();
  try {
    gw.script.push({ kind: "destroy", partial: "Partial" }, { kind: "ok", text: "Recovered." });
    await s.session.prompt("go");
    assert.equal(gw.bodies.length, 2);
    assert.equal(text(lastAssistant(s.session)), "Recovered.");
  } finally {
    s.cleanup();
  }
});

test("no attempt cap: many consecutive cuts are ridden out until the route is back", async () => {
  const s = await startSession();
  try {
    for (let i = 0; i < 7; i++) gw.script.push({ kind: "cut", partial: `try ${i}`, error: LINK_CUT });
    gw.script.push({ kind: "ok", text: "Finally." });
    await s.session.prompt("go");
    assert.equal(gw.bodies.length, 8);
    assert.equal(text(lastAssistant(s.session)), "Finally.");
  } finally {
    s.cleanup();
  }
});

test("a non-retryable error after output is not retried", async () => {
  const s = await startSession();
  try {
    gw.script.push({ kind: "cut", partial: "Some", error: "invalid request: schema mismatch in tool arguments" });
    await s.session.prompt("go");
    assert.equal(gw.bodies.length, 1);
    assert.equal(lastAssistant(s.session)?.stopReason, "error");
  } finally {
    s.cleanup();
  }
});

test("Esc during the wait ends the turn promptly and sends nothing more", async () => {
  const s = await startSession({ schedule: { baseMs: 60_000, capMs: 60_000 } });
  try {
    gw.script.push({ kind: "cut", partial: "Hello", error: LINK_CUT }, { kind: "ok", text: "never" });
    const started = Date.now();
    const run = s.session.prompt("go");
    setTimeout(() => void s.session.abort(), 300);
    await run;
    assert.ok(Date.now() - started < 5_000, `aborted promptly (${Date.now() - started} ms)`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(gw.bodies.length, 1, "no request after Esc");
  } finally {
    s.cleanup();
  }
});

test("a provider without the gateway wrapper is not retried (no wait could be taken): notice, no tight loop", async () => {
  const notices: string[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n.text));
  const s = await startSession({ unwrapped: true });
  try {
    gw.script.push({ kind: "cut", partial: "Hello", error: LINK_CUT }, { kind: "ok", text: "never" });
    await s.session.prompt("go");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(gw.bodies.length, 1, "no unpaced retry");
    assert.ok(
      notices.some((t) => /gateway wrapper/i.test(t)),
      JSON.stringify(notices),
    );
  } finally {
    uninstall();
    s.cleanup();
  }
});

test("the first notice names the failure kind", async () => {
  const notices: string[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n.text));
  const s = await startSession();
  try {
    gw.script.push({ kind: "cut", partial: "Hello", error: LINK_CUT }, { kind: "ok", text: "ok" });
    await s.session.prompt("go");
    assert.ok(
      notices.some((t) => /link cut/i.test(t) && /retrying in/i.test(t)),
      JSON.stringify(notices),
    );
  } finally {
    uninstall();
    s.cleanup();
  }
});

test("past the elapsed horizon it stops, and says so", async () => {
  const notices: string[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n.text));
  const s = await startSession({ schedule: { horizonMs: 0 } });
  try {
    gw.script.push({ kind: "cut", partial: "Hello", error: LINK_CUT });
    await s.session.prompt("go");
    assert.equal(gw.bodies.length, 1);
    assert.ok(
      notices.some((t) => /stopped retrying/i.test(t)),
      JSON.stringify(notices),
    );
  } finally {
    uninstall();
    s.cleanup();
  }
});

test("with Pi's own retry enabled, Pi retries first and ours takes over after, never both at once", async () => {
  const s = await startSession({ retrySettings: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
  try {
    gw.script.push(
      { kind: "cut", partial: "a", error: LINK_CUT },
      { kind: "cut", partial: "b", error: LINK_CUT },
      { kind: "ok", text: "Done." },
    );
    await s.session.prompt("go");
    assert.equal(gw.bodies.length, 3, "Pi's one retry, then ours: one request per attempt");
    assert.equal(text(lastAssistant(s.session)), "Done.");
  } finally {
    s.cleanup();
  }
});
