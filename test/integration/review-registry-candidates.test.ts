/**
 * With no routing policy (or every routed candidate dead) the reviewer is
 * placed from the session's model registry: a provider whose baseUrl refuses
 * connections is skipped, the review lands on a live model, and says why.
 * Dead providers are closed or connection-resetting local ports, live ones
 * real local HTTP servers.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RegistryModel } from "../../src/capability/registryCandidates.ts";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { type ModelRef, modelKey } from "../../src/lifecycle/types.ts";
import { type RouteModel, realBackends } from "../../src/orchestration/realBackends.ts";
import { MAX_UNKNOWN_TOOL_CALLS, PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

const REVIEW = {
  verdict: "approve",
  summary: "fine",
  findings: [],
  missing_tests: [],
  spec_gaps: [],
  acceptance_results: [],
};

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => handler(req, res));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const port = (server: Server): number => (server.address() as AddressInfo).port;

/** A server that accepts the connection and drops it: a dead upstream that counts its visitors. */
function resetting(answerAt = Number.POSITIVE_INFINITY): Promise<{ server: Server; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => reviewReply(res));
  });
  server.on("connection", (socket) => {
    hits++;
    if (hits >= answerAt) return;
    socket.on("error", () => {});
    socket.destroy();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, hits: () => hits })));
}

async function closedPort(): Promise<number> {
  const probe = await listen(() => {});
  const closed = port(probe);
  probe.closeAllConnections();
  await new Promise((resolve) => probe.close(resolve));
  return closed;
}

function reviewReply(res: ServerResponse): void {
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    frame({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_0",
          type: "function",
          function: { name: "review_result", arguments: JSON.stringify(REVIEW) },
        },
      ],
    }),
  );
  res.write(frame({}, "tool_calls"));
  res.end("data: [DONE]\n\n");
}

/** The implementer's endpoint: a plain completion that ends the turn. */
function doneReply(res: ServerResponse): void {
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(frame({ role: "assistant", content: "implemented" }));
  res.write(frame({}, "stop"));
  res.end("data: [DONE]\n\n");
}

const dead: ModelRef = { provider: "beast", id: "qwen3.8-27b-q4" };
const live: ModelRef = { provider: "hive", id: "glm-5.3-flash" };
const noPolicy: RouteModel = async () => undefined;

function setup(
  baseUrls: Record<string, string>,
  pool: RegistryModel[],
  routeModel: RouteModel | undefined,
  session = dead,
  enabledModels?: string[],
) {
  const notices: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "pi-review-registry-"));
  const providers: Record<string, unknown> = {};
  for (const [name, baseUrl] of Object.entries(baseUrls)) {
    providers[name] = {
      baseUrl,
      api: "openai-completions",
      apiKey: "k",
      models: pool
        .filter((m) => m.provider === name)
        .map((m) => ({ id: m.id, contextWindow: m.contextWindow ?? 100_000, maxTokens: 4096 })),
    };
  }
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers }));
  const worker = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: true, maxRetries: 1, jitterMs: 0 }),
    admission: new AdmissionController({ maxConcurrency: 2, jitterMs: 0 }),
    transientConfig: { baseMs: 1, maxMs: 1, factor: 1, jitter: 0, maxAttempts: 12 },
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  const backends = realBackends({
    worker,
    verifier: {} as never,
    artifacts: { readContentByUri: async () => undefined } as never,
    git: null,
    cwd: dir,
    routeModel,
    reviewFallbackModel: session,
    registryModels: () => pool,
    enabledModels: () => enabledModels,
  });
  const review = () =>
    backends.review.runReview({
      objective: "review",
      missionId: "MSN-1",
      signal: new AbortController().signal,
      onActivity: (event) => notices.push(event.summary ?? ""),
    });
  return { dir, review, notices, backends };
}

const close = async (...servers: Server[]) => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
};

test("with no routing policy a dead session default is left for a live registry model, and the notice says why", async () => {
  const deadPort = await closedPort();
  const good = await listen((_req, res) => reviewReply(res));
  const { dir, review, notices } = setup(
    { beast: `http://127.0.0.1:${deadPort}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    noPolicy,
  );
  try {
    const outcome = await review();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.deepEqual(outcome.model, live);
    assert.equal(outcome.reviewEvidence?.model, live.id);
    assert.ok(
      notices.some((n) => /no routing candidate; chose hive\/glm-5\.3-flash from the model registry/.test(n)),
      notices.join(" | "),
    );
    assert.match(outcome.summary, /from the model registry/);
  } finally {
    await close(good);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a provider on cooldown is skipped before dispatch and named in the notice", async () => {
  const flaky = await resetting();
  const good = await listen((_req, res) => reviewReply(res));
  const { dir, review, notices } = setup(
    { beast: `http://127.0.0.1:${port(flaky.server)}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    noPolicy,
  );
  try {
    assert.equal((await review()).exitStatus, "succeeded");
    const after = flaky.hits();
    notices.length = 0;
    const second = await review();
    assert.equal(second.exitStatus, "succeeded", second.summary);
    assert.deepEqual(second.model, live);
    assert.equal(flaky.hits(), after, "the cooling session default is not dialled again");
    assert.ok(
      notices.some((n) => /beast on cooldown/.test(n)),
      notices.join(" | "),
    );
  } finally {
    await close(flaky.server, good);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a policy whose candidates are all dead falls back to the registry", async () => {
  const deadPort = await closedPort();
  const good = await listen((_req, res) => reviewReply(res));
  const policyOnly: RouteModel = async (_role, query) =>
    (query?.exclude ?? []).some((skip) => modelKey(skip) === modelKey(dead)) ? undefined : dead;
  const { dir, review } = setup(
    { beast: `http://127.0.0.1:${deadPort}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    policyOnly,
  );
  try {
    const outcome = await review();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.deepEqual(outcome.model, live);
    assert.match(outcome.summary, /chose hive\/glm-5\.3-flash from the model registry/);
  } finally {
    await close(good);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with every registry provider dead the review fails fast as a transient failure", async () => {
  const a = await resetting();
  const b = await resetting();
  const { dir, review } = setup(
    { beast: `http://127.0.0.1:${port(a.server)}/v1`, hive: `http://127.0.0.1:${port(b.server)}/v1` },
    [dead, live],
    noPolicy,
  );
  try {
    const started = Date.now();
    const outcome = await review();
    assert.notEqual(outcome.exitStatus, "succeeded");
    assert.equal(outcome.error, "transient:network");
    assert.ok(a.hits() <= 3 && b.hits() <= 3, `tried ${a.hits()} and ${b.hits()} times`);
    assert.ok(Date.now() - started < 30_000, "must not spin");
  } finally {
    await close(a.server, b.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the registry prefers a family different from the implementer's, then the larger context", async () => {
  // The first request is the implementer's (plain text); the rest are reviews.
  let requests = 0;
  const good = await listen((_req, res) => (requests++ === 0 ? doneReply(res) : reviewReply(res)));
  const url = `http://127.0.0.1:${port(good)}/v1`;
  const implementer: RegistryModel = { provider: "hive", id: "glm-5.3-flash", contextWindow: 200_000 };
  const sameFamilyBig: RegistryModel = { provider: "hive", id: "glm-5.1", contextWindow: 900_000 };
  const otherSmall: RegistryModel = { provider: "hive", id: "qwen3.8-27b", contextWindow: 100_000 };
  const otherBig: RegistryModel = { provider: "hive", id: "deepseek-v4-flash", contextWindow: 150_000 };
  const pool = [implementer, sameFamilyBig, otherSmall, otherBig];
  const routeModel: RouteModel = async (role) => (role === "reviewer" ? undefined : implementer);
  const { dir, review, backends } = setup({ hive: url }, pool, routeModel, implementer);
  try {
    await backends.agent.runAgent({
      role: "implementer",
      objective: "implement",
      missionId: "MSN-1",
      signal: new AbortController().signal,
    });
    // The implementer's nudge is answered with a review_result call, a tool its
    // session does not offer. That must end the attempt after a few calls, not
    // run for ever (issue #234): one request to end the turn, one for the
    // nudge, then at most MAX_UNKNOWN_TOOL_CALLS - 1 more.
    assert.ok(requests <= 2 + MAX_UNKNOWN_TOOL_CALLS, `the implementer made ${requests} requests`);
    const outcome = await review();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.deepEqual(outcome.model, { provider: otherBig.provider, id: otherBig.id });
  } finally {
    await close(good);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the registry fallback stays inside Pi's enabledModels even when an excluded provider is alive", async () => {
  const good = await listen((_req, res) => reviewReply(res));
  const url = `http://127.0.0.1:${port(good)}/v1`;
  const beastBig: RegistryModel = { ...dead, contextWindow: 900_000 };
  const hiveSmall: RegistryModel = { ...live, contextWindow: 100_000 };
  const { dir, review } = setup({ beast: url, hive: url }, [beastBig, hiveSmall], noPolicy, dead, ["hive/*"]);
  try {
    const outcome = await review();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.deepEqual(outcome.model, live);
  } finally {
    await close(good);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an absent routeModel still places the reviewer on a live registry model", async () => {
  const deadPort = await closedPort();
  const good = await listen((_req, res) => reviewReply(res));
  const { dir, review } = setup(
    { beast: `http://127.0.0.1:${deadPort}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    undefined,
  );
  try {
    const outcome = await review();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.deepEqual(outcome.model, live);
  } finally {
    await close(good);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an implementer whose session default is cooling starts on the registry model", async () => {
  const flaky = await resetting();
  // The first request is the review that cools beast; the next is the implementer's.
  let requests = 0;
  const good = await listen((_req, res) => (requests++ === 0 ? reviewReply(res) : doneReply(res)));
  const { dir, review, backends } = setup(
    { beast: `http://127.0.0.1:${port(flaky.server)}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    noPolicy,
  );
  try {
    assert.equal((await review()).exitStatus, "succeeded");
    const after = flaky.hits();
    const run = await backends.agent.runAgent({
      role: "implementer",
      objective: "implement",
      missionId: "MSN-2",
      signal: new AbortController().signal,
    });
    assert.deepEqual(run.model, live);
    assert.equal(flaky.hits(), after, "the cooling default is not dialled for the implementer");
  } finally {
    await close(flaky.server, good);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an implementer refused by its default provider walks to the registry model", async () => {
  const deadPort = await closedPort();
  const good = await listen((_req, res) => doneReply(res));
  const { dir, backends } = setup(
    { beast: `http://127.0.0.1:${deadPort}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    noPolicy,
  );
  try {
    const run = await backends.agent.runAgent({
      role: "implementer",
      objective: "implement",
      missionId: "MSN-3",
      signal: new AbortController().signal,
    });
    assert.deepEqual(run.model, live);
  } finally {
    await close(good);
    rmSync(dir, { recursive: true, force: true });
  }
});
