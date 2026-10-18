/**
 * A reviewer must never be stranded on a provider that refuses connections.
 * The "beast" provider here is a deliberately closed (or connection-resetting)
 * port, the live route a real local HTTP server. The review fails over to the
 * live route, records the model it actually attempted, and does not spend a
 * dozen in-session reconnects on the dead one.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { type ModelRef, modelKey } from "../../src/lifecycle/types.ts";
import { type RouteModel, realBackends } from "../../src/orchestration/realBackends.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

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

const dead: ModelRef = { provider: "beast", id: "qwen3.8-27b-q4-lane2" };
const live: ModelRef = { provider: "hive", id: "glm-5.3-flash" };

function setup(baseUrls: Record<string, string>, pool: ModelRef[], routeModel: RouteModel, sessionDefault?: ModelRef) {
  const notices: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "pi-review-dead-"));
  const providers: Record<string, unknown> = {};
  for (const [name, baseUrl] of Object.entries(baseUrls)) {
    providers[name] = {
      baseUrl,
      api: "openai-completions",
      apiKey: "k",
      models: pool
        .filter((m) => m.provider === name)
        .map((m) => ({ id: m.id, contextWindow: 262_144, maxTokens: 4096 })),
    };
  }
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers }));
  const worker = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: true, maxRetries: 1, jitterMs: 0 }),
    admission: new AdmissionController({ maxConcurrency: 2, jitterMs: 0 }),
    // The operator's production policy: twelve transient retries for workers.
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
    reviewFallbackModel: sessionDefault,
  });
  const review = () =>
    backends.review.runReview({
      objective: "review",
      missionId: "MSN-1",
      signal: new AbortController().signal,
      onActivity: (event) => notices.push(event.summary ?? ""),
    });
  return { dir, review, notices };
}

const poolRoute =
  (pool: ModelRef[]): RouteModel =>
  async (_role, query) =>
    pool.find((model) => !(query?.exclude ?? []).some((skip) => modelKey(skip) === modelKey(model)));

const close = async (...servers: Server[]) => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
};

test("a refused connection on the preferred route fails over to the live route and records its model", async () => {
  const deadPort = await closedPort();
  const good = await listen((_req, res) => reviewReply(res));
  const { dir, review } = setup(
    { beast: `http://127.0.0.1:${deadPort}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    poolRoute([dead, live]),
  );
  try {
    const outcome = await review();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.deepEqual(outcome.model, live);
    assert.equal(outcome.reviewEvidence?.model, live.id);
    assert.equal(outcome.reviewEvidence?.outputValid, true);
  } finally {
    await close(good);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reviewer spends at most three attempts on a dead provider before failing over", async () => {
  const flaky = await resetting();
  const good = await listen((_req, res) => reviewReply(res));
  const { dir, review } = setup(
    { beast: `http://127.0.0.1:${port(flaky.server)}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    poolRoute([dead, live]),
  );
  try {
    const outcome = await review();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.equal(outcome.reviewEvidence?.model, live.id);
    assert.ok(flaky.hits() >= 1 && flaky.hits() <= 3, `dead provider was tried ${flaky.hits()} times`);
  } finally {
    await close(flaky.server, good);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a qualified session default on a dead provider still fails over, naming the model it attempted", async () => {
  const flaky = await resetting();
  const good = await listen((_req, res) => reviewReply(res));
  // No distinct route exists initially, but the router can confirm the named
  // session default's eligibility. Its failure makes the live route available.
  const routeModel: RouteModel = async (_role, query) => {
    if (query?.taskOverride === modelKey(dead)) return dead;
    return (query?.exclude ?? []).length === 0 && !query?.replacement ? undefined : live;
  };
  const { dir, review, notices } = setup(
    { beast: `http://127.0.0.1:${port(flaky.server)}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    routeModel,
    dead,
  );
  try {
    const outcome = await review();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.equal(outcome.reviewEvidence?.model, live.id);
    assert.ok(flaky.hits() >= 1 && flaky.hits() <= 3, `dead provider was tried ${flaky.hits()} times`);
    assert.ok(
      notices.some((notice) => notice.includes(modelKey(dead)) && notice.includes(modelKey(live))),
      notices.join(" | "),
    );
  } finally {
    await close(flaky.server, good);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with every route dead the review fails fast as a transient provider failure naming the attempted model", async () => {
  const a = await resetting();
  const b = await resetting();
  const other: ModelRef = { provider: "hive", id: "glm-5.3-flash" };
  const { dir, review } = setup(
    { beast: `http://127.0.0.1:${port(a.server)}/v1`, hive: `http://127.0.0.1:${port(b.server)}/v1` },
    [dead, other],
    poolRoute([dead, other]),
  );
  try {
    const started = Date.now();
    const outcome = await review();
    assert.notEqual(outcome.exitStatus, "succeeded");
    assert.equal(outcome.error, "transient:network");
    assert.match(outcome.summary, /connection error/i);
    assert.notEqual(outcome.usage?.model, "unknown");
    assert.ok(a.hits() <= 3 && b.hits() <= 3, `tried ${a.hits()} and ${b.hits()} times`);
    assert.ok(Date.now() - started < 30_000, "must not spin");
  } finally {
    await close(a.server, b.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a provider that refused connections is skipped by the next review while its cooldown lasts", async () => {
  const flaky = await resetting();
  const good = await listen((_req, res) => reviewReply(res));
  const { dir, review } = setup(
    { beast: `http://127.0.0.1:${port(flaky.server)}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    poolRoute([dead, live]),
  );
  try {
    assert.equal((await review()).exitStatus, "succeeded");
    const after = flaky.hits();
    const second = await review();
    assert.equal(second.exitStatus, "succeeded", second.summary);
    assert.equal(flaky.hits(), after, "the cooling provider is not dialled again");
  } finally {
    await close(flaky.server, good);
    rmSync(dir, { recursive: true, force: true });
  }
});

const pinned =
  (model: ModelRef): RouteModel =>
  async (_role, query) =>
    (query?.exclude ?? []).some((skip) => modelKey(skip) === modelKey(model)) ? live : { ...model, operatorPin: true };

test("an operator-pinned reviewer keeps waiting on a slow route and succeeds on the pinned model", async () => {
  const slow = await resetting(5);
  const { dir, review } = setup({ beast: `http://127.0.0.1:${port(slow.server)}/v1` }, [dead], pinned(dead));
  try {
    const outcome = await review();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.equal(outcome.reviewEvidence?.model, dead.id);
    assert.equal(slow.hits(), 5);
  } finally {
    await close(slow.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an operator-pinned reviewer on a closed port fails over with a notice", async () => {
  const deadPort = await closedPort();
  const good = await listen((_req, res) => reviewReply(res));
  const { dir, review, notices } = setup(
    { beast: `http://127.0.0.1:${deadPort}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    pinned(dead),
  );
  try {
    const outcome = await review();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.equal(outcome.reviewEvidence?.model, live.id);
    assert.ok(
      notices.some((n) => /switched reviewer to hive\/glm/.test(n)),
      notices.join(" | "),
    );
  } finally {
    await close(good);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate retry cap is configurable through PI_GUARD_GATE_TRANSIENT_MAX_ATTEMPTS", async () => {
  const flaky = await resetting();
  const good = await listen((_req, res) => reviewReply(res));
  process.env.PI_GUARD_GATE_TRANSIENT_MAX_ATTEMPTS = "0";
  const { dir, review } = setup(
    { beast: `http://127.0.0.1:${port(flaky.server)}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [dead, live],
    poolRoute([dead, live]),
  );
  try {
    const outcome = await review();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.equal(flaky.hits(), 1, "a cap of zero retries dials the dead route once");
  } finally {
    Reflect.deleteProperty(process.env, "PI_GUARD_GATE_TRANSIENT_MAX_ATTEMPTS");
    await close(flaky.server, good);
    rmSync(dir, { recursive: true, force: true });
  }
});
