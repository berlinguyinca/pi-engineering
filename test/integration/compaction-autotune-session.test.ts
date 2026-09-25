/**
 * Per-model compaction tuning inside a REAL Pi AgentSession.
 *
 * A local OpenAI-compatible server (node:http, SSE) stands in for the gateway;
 * pi-ai's real openai-completions transport talks to it. An inline extension
 * installs what pi-engineering installs — the gateway stream-retry wrapper with
 * the thinking-off policy — plus registerAutoCompaction. The server reports
 * whatever prompt size a test wants, which is what Pi's context usage reads.
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
import {
  loadPiPrepareCompaction,
  registerAutoCompaction,
  tunedCompactionTokens,
} from "../../src/compaction/autoTune.ts";
import { installGatewayStreamRetry, resetGatewayStreamRetry } from "../../src/gateway/installStreamRetry.ts";
import { resolveThinkingOffConfig } from "../../src/request/thinkingPolicy.ts";
import { setTelemetrySink } from "../../src/telemetry/sink.ts";

const SUMMARY_OPENING = "You are a context summarization assistant.";

interface Recorded {
  summarization: boolean;
  body: Record<string, unknown>;
}

/** A tiny OpenAI chat-completions server: SSE, scripted prompt sizes. */
function gatewayServer() {
  const requests: Recorded[] = [];
  const promptTokens: number[] = [];
  let failSummaries = false;
  let summaryDelayMs = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { messages?: Array<{ role: string; content: unknown }> };
      const system = body.messages?.find((m) => m.role === "system" || m.role === "developer");
      const text = typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "");
      const summarization = text.includes(SUMMARY_OPENING);
      requests.push({ summarization, body: body as Record<string, unknown> });
      if (summarization && failSummaries) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "summary backend down" } }));
        return;
      }
      const content = summarization ? "## Goal\nKeep going.\n## Progress\nDone some things." : "ok";
      const prompt = summarization ? 1000 : (promptTokens.shift() ?? 1000);
      const respond = () => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        const base = { id: "c", object: "chat.completion.chunk", created: 0, model: "m" };
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        chunk({
          ...base,
          choices: [],
          usage: { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5 },
        });
        res.end("data: [DONE]\n\n");
      };
      if (summarization && summaryDelayMs > 0) setTimeout(respond, summaryDelayMs);
      else respond();
    });
  });
  return {
    server,
    requests,
    promptTokens,
    failSummaries(on: boolean) {
      failSummaries = on;
    },
    delaySummaries(ms: number) {
      summaryDelayMs = ms;
    },
  };
}

const gateway = gatewayServer();
let baseUrl = "";
let host = "";

before(async () => {
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const port = (gateway.server.address() as { port: number }).port;
  host = `127.0.0.1:${port}`;
  baseUrl = `http://${host}/v1`;
});
after(() => {
  gateway.server.close();
});

const MODEL_ID = "qwen3.8-27b";
const OTHER_ID = "small-128k";

type InlineFactory = (pi: never) => void;

async function startSession(
  opts: {
    settings?: unknown;
    loadPrepare?: () => Promise<undefined>;
    extra?: InlineFactory;
    extensionPaths?: string[];
  } = {},
) {
  // Each session starts with a clean script: no sizes left over from another test.
  gateway.promptTokens.length = 0;
  gateway.requests.length = 0;
  const root = mkdtempSync(join(tmpdir(), "autotune-session-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (opts.settings !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(opts.settings));

  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = (id: string, contextWindow: number) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 32_768,
  });
  runtime.registerProvider("gw", {
    baseUrl,
    apiKey: "k",
    api: "openai-completions",
    models: [model(MODEL_ID, 262_144), model(OTHER_ID, 131_072)],
  } as never);

  resetGatewayStreamRetry();
  const factory = (pi: {
    on(event: string, handler: (event: unknown, ctx: never) => unknown): void;
  }) => {
    registerAutoCompaction(pi as never, {
      agentDir,
      ...(opts.loadPrepare ? { loadPrepare: opts.loadPrepare } : {}),
    });
    pi.on("session_start", (_event, ctx: { modelRegistry: unknown; model?: { provider: string; api: string } }) => {
      if (!ctx.model) return;
      installGatewayStreamRetry(
        ctx.modelRegistry as never,
        { provider: ctx.model.provider, api: ctx.model.api },
        {
          createStream: () => createAssistantMessageEventStream() as never,
          hold: async () => {},
          errorMessage: (_m, error) => ({ stopReason: "error", errorMessage: String(error) }),
          thinkingPolicy: resolveThinkingOffConfig({ PI_THINKING_OFF_GATEWAYS: host }),
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
    extensionFactories: [factory as never, ...(opts.extra ? [opts.extra as never] : [])],
    ...(opts.extensionPaths ? { additionalExtensionPaths: opts.extensionPaths } : {}),
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: runtime.getModel("gw", MODEL_ID) as never,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    tools: [],
  });
  await session.bindExtensions({});
  return {
    session,
    runtime,
    cleanup: () => {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type Session = Awaited<ReturnType<typeof startSession>>["session"];

/** pi-ai sends max_tokens or max_completion_tokens depending on the provider's compat. */
const outputCap = (body: Record<string, unknown> | undefined) =>
  Number(body?.max_tokens ?? body?.max_completion_tokens);

const compactions = (session: Session) => session.sessionManager.getEntries().filter((e) => e.type === "compaction");

async function turn(session: Session, promptTokens: number, text = "x".repeat(60_000)): Promise<void> {
  gateway.promptTokens.push(promptTokens);
  await session.prompt(text);
}

async function settle(session: Session, count: number): Promise<void> {
  for (let i = 0; i < 200 && compactions(session).length < count; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await session.waitForIdle?.();
}

test("B + A: compacts at the TUNED threshold (turn_end boundary), keeps the tuned tail, summary sent with thinking off", async () => {
  const notices: string[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n.text));
  const s = await startSession();
  try {
    gateway.requests.length = 0;
    for (let i = 0; i < 3; i++) await turn(s.session, 60_000);
    assert.equal(compactions(s.session).length, 0, "below the tuned threshold");
    const branchBefore = s.session.sessionManager.getBranch();

    // 240k: past 262,144 - 32,768 (tuned) but below Pi's own 245,760.
    await turn(s.session, 240_000);
    await settle(s.session, 1);
    const [entry] = compactions(s.session) as Array<{ firstKeptEntryId: string }>;
    assert.ok(entry, "our trigger compacted");

    // The cut honours the TUNED keepRecent (Pi's own function, both settings).
    const prepare = await loadPiPrepareCompaction();
    assert.ok(prepare, "Pi's prepareCompaction loads");
    const tuned = tunedCompactionTokens({ contextWindow: 262_144, maxTokens: 32_768 });
    assert.ok(tuned);
    const ours = prepare(branchBefore.concat(s.session.sessionManager.getBranch().slice(branchBefore.length, -1)), {
      enabled: true,
      ...tuned,
    });
    const piDefault = prepare(
      branchBefore.concat(s.session.sessionManager.getBranch().slice(branchBefore.length, -1)),
      {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      },
    );
    assert.equal(entry.firstKeptEntryId, ours?.firstKeptEntryId);
    assert.notEqual(entry.firstKeptEntryId, piDefault?.firstKeptEntryId, "a longer verbatim tail than Pi's default");

    const summaries = gateway.requests.filter((r) => r.summarization);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.body.reasoning_effort, "none", "summarized through the guarded gateway path");
    assert.ok(outputCap(summaries[0]?.body) > 13_107, "summary budget from the tuned reserve (0.8 x 32768)");
    assert.ok(notices.some((t) => t.includes(`Compaction tuned for gw/${MODEL_ID}`)));
    // Pi emits no compaction_start/end for a boundary (draft) compaction, so we say it.
    assert.ok(
      notices.some((t) => /^Compacted ~[\d,]+ → ~[\d,]+ tokens \(tuned/.test(t)),
      JSON.stringify(notices),
    );
  } finally {
    uninstall();
    s.cleanup();
  }
});

test("B: debounced — no loop while above the threshold; re-arms after dropping below", async () => {
  const s = await startSession();
  try {
    for (let i = 0; i < 3; i++) await turn(s.session, 60_000);
    await turn(s.session, 240_000);
    await settle(s.session, 1);
    assert.equal(compactions(s.session).length, 1);

    await turn(s.session, 241_000, "short");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(compactions(s.session).length, 1, "still above after compacting: no second compaction");

    await turn(s.session, 100_000, "short");
    for (let i = 0; i < 3; i++) await turn(s.session, 60_000);
    await turn(s.session, 240_000);
    await settle(s.session, 2);
    assert.equal(compactions(s.session).length, 2, "re-armed below the threshold, compacted again");
  } finally {
    s.cleanup();
  }
});

test("user settings win: compaction.enabled=false is respected, and a user reserve moves the threshold", async () => {
  const disabled = await startSession({ settings: { compaction: { enabled: false } } });
  try {
    for (let i = 0; i < 3; i++) await turn(disabled.session, 60_000);
    await turn(disabled.session, 240_000);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(compactions(disabled.session).length, 0);
  } finally {
    disabled.cleanup();
  }
  const own = await startSession({
    settings: { compaction: { modelOverrides: { [`gw/${MODEL_ID}`]: { reserveTokens: 16_384 } } } },
  });
  try {
    for (let i = 0; i < 3; i++) await turn(own.session, 60_000);
    await turn(own.session, 240_000); // below 262,144 - 16,384: the user's threshold
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(compactions(own.session).length, 0, "the user's per-model reserve, not ours");
  } finally {
    own.cleanup();
  }
});

test("A falls back to Pi's own compaction when ours fails (never cancels)", async () => {
  const notices: string[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n.text));
  const s = await startSession();
  try {
    // Four turns (~60k tokens): enough history that the tuned cut has something to summarize.
    for (let i = 0; i < 4; i++) await turn(s.session, 60_000);
    assert.equal(compactions(s.session).length, 0);
    gateway.requests.length = 0;
    gateway.failSummaries(true);
    await new Promise<void>((resolve) => {
      s.session
        .compact()
        .then(() => resolve())
        .catch(() => resolve());
    });
    const summaries = gateway.requests.filter((r) => r.summarization);
    assert.ok(summaries.length >= 2, "ours failed, then Pi's default compaction ran");
    assert.ok(
      notices.some((t) => t.includes("Pi's default compaction runs instead")),
      `notices: ${JSON.stringify(notices)} summaries: ${summaries.length}`,
    );
  } finally {
    gateway.failSummaries(false);
    uninstall();
    s.cleanup();
  }
});

test("without Pi's prepareCompaction, A keeps Pi's cut and still applies the tuned summary budget", async () => {
  const s = await startSession({ loadPrepare: async () => undefined });
  try {
    for (let i = 0; i < 3; i++) await turn(s.session, 60_000);
    gateway.requests.length = 0;
    await s.session.compact();
    const summaries = gateway.requests.filter((r) => r.summarization);
    assert.equal(summaries.length, 1);
    assert.ok(outputCap(summaries[0]?.body) > 13_107);
    assert.equal(compactions(s.session).length, 1);
  } finally {
    s.cleanup();
  }
});

test("model switch recomputes: the new model's values are announced", async () => {
  const notices: string[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n.text));
  const s = await startSession();
  try {
    await s.session.setModel(s.runtime.getModel("gw", OTHER_ID) as never);
    assert.ok(notices.some((t) => t.includes(`Compaction tuned for gw/${OTHER_ID}`) && t.includes("window 131072")));
  } finally {
    uninstall();
    s.cleanup();
  }
});

test("B never races another extension's agent_settled follow-up (it compacts at turn_end instead)", async () => {
  // src/lifecycle/harness.ts sends remediation follow-ups from agent_settled;
  // Pi defers them past the emission. A ctx.compact() fired from agent_settled
  // made that deferred prompt fail ("Cannot submit a prompt while compaction
  // is in progress"). Compacting at the turn boundary leaves settle alone.
  let sent = false;
  const extra = (pi: {
    on(event: string, handler: () => void): void;
    sendUserMessage(text: string, options: { deliverAs: string }): void;
  }) => {
    pi.on("agent_settled", () => {
      if (sent) return;
      sent = true;
      pi.sendUserMessage("remediation follow-up", { deliverAs: "followUp" });
    });
  };
  const errors: string[] = [];
  const s = await startSession({ extra: extra as never });
  s.session.subscribe((event: { type: string; error?: unknown }) => {
    if (event.type === "extension_error") errors.push(String(event.error));
  });
  try {
    for (let i = 0; i < 3; i++) await turn(s.session, 60_000);
    sent = false;
    await turn(s.session, 240_000);
    await settle(s.session, 1);
    for (let i = 0; i < 100; i++) {
      if (gateway.requests.some((r) => JSON.stringify(r.body.messages ?? "").includes("remediation follow-up"))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(compactions(s.session).length, 1, "compacted at the boundary");
    assert.ok(
      gateway.requests.some((r) => JSON.stringify(r.body.messages ?? "").includes("remediation follow-up")),
      "the follow-up was delivered",
    );
    assert.deepEqual(errors, []);
  } finally {
    s.cleanup();
  }
});

test("Pi's real extension loader (jiti with its alias map) can load Pi's prepareCompaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autotune-jiti-"));
  const autoTune = new URL("../../src/compaction/autoTune.ts", import.meta.url).pathname;
  const extension = join(dir, "probe-extension.ts");
  writeFileSync(
    extension,
    `import { loadPiPrepareCompaction } from ${JSON.stringify(autoTune)};
export default function (_pi: unknown) {
  (globalThis as Record<string, unknown>).__autotunePrepare = loadPiPrepareCompaction();
}
`,
  );
  const s = await startSession({ extensionPaths: [extension] });
  try {
    const loaded = await (globalThis as Record<string, unknown>).__autotunePrepare;
    assert.equal(typeof loaded, "function", "tuned keepRecent is applied for real users, not just in tests");
  } finally {
    s.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Esc during a tuned boundary compaction is not a failure (no warning, trigger not held off)", async () => {
  const notices: string[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n.text));
  const s = await startSession();
  try {
    for (let i = 0; i < 3; i++) await turn(s.session, 60_000);
    gateway.delaySummaries(5_000);
    const run = turn(s.session, 240_000);
    for (let i = 0; i < 200 && !gateway.requests.some((r) => r.summarization); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await s.session.abort();
    await run.catch(() => undefined);
    assert.equal(compactions(s.session).length, 0);
    assert.ok(!notices.some((t) => /did not complete/.test(t)), JSON.stringify(notices));
  } finally {
    gateway.delaySummaries(0);
    uninstall();
    s.cleanup();
  }
});
