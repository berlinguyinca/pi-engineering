/**
 * A review must survive a route that cannot serve it. Real HTTP servers stand in
 * for the gateway routes: the preferred one refuses the request the way
 * llama.cpp does when it cannot compile the tool schema into a grammar, or is
 * simply down; the review proceeds on the next eligible route.
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
import { realBackends } from "../../src/orchestration/realBackends.ts";
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

async function reviewOver(baseUrls: Record<string, string>, pool: ModelRef[]) {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-failover-"));
  const providers: Record<string, unknown> = {};
  for (const [name, baseUrl] of Object.entries(baseUrls)) {
    providers[name] = {
      baseUrl,
      api: "openai-completions",
      apiKey: "k",
      models: pool
        .filter((m) => m.provider === name)
        .map((m) => ({ id: m.id, contextWindow: 100_000, maxTokens: 4096 })),
    };
  }
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers }));
  const worker = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: true, maxRetries: 1, jitterMs: 0 }),
    admission: new AdmissionController({ maxConcurrency: 2, jitterMs: 0 }),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  const backends = realBackends({
    worker,
    verifier: {} as never,
    artifacts: { readContentByUri: async () => undefined } as never,
    git: null,
    cwd: dir,
    routeModel: async (_role, query) =>
      pool.find((model) => !(query?.exclude ?? []).some((skip) => modelKey(skip) === modelKey(model))),
  });
  const outcome = await backends.review.runReview({
    objective: "review",
    missionId: "MSN-1",
    signal: new AbortController().signal,
  });
  return { outcome, dir };
}

const preferred: ModelRef = { provider: "beast", id: "deepseek-v4-flash" };
const next: ModelRef = { provider: "hive", id: "glm-5.3-flash" };

test("an HTTP 400 grammar refusal is permanent for that route and the review succeeds on the next", async () => {
  let preferredHits = 0;
  const bad = await listen((_req, res) => {
    preferredHits++;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          code: 400,
          message: "Failed to initialize samplers: failed to parse grammar",
          type: "invalid_request_error",
        },
      }),
    );
  });
  const good = await listen((_req, res) => reviewReply(res));
  const { outcome, dir } = await reviewOver(
    { beast: `http://127.0.0.1:${port(bad)}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [preferred, next],
  );
  try {
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.equal(outcome.reviewEvidence?.model, next.id);
    assert.equal(outcome.reviewEvidence?.outputValid, true);
    assert.equal(preferredHits, 1, "a permanent refusal is never retried on the same route");
  } finally {
    for (const s of [bad, good]) {
      s.closeAllConnections();
      s.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreachable preferred route fails over to the next eligible route", async () => {
  const dead = await listen(() => {});
  const deadPort = port(dead);
  dead.closeAllConnections();
  await new Promise((resolve) => dead.close(resolve));
  const good = await listen((_req, res) => reviewReply(res));
  const { outcome, dir } = await reviewOver(
    { beast: `http://127.0.0.1:${deadPort}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [preferred, next],
  );
  try {
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.equal(outcome.reviewEvidence?.model, next.id);
    assert.equal(outcome.reviewEvidence?.outputValid, true);
  } finally {
    good.closeAllConnections();
    good.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const refuse = (message: string) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: 400, message, type: "invalid_request_error" } }));
};

test("a non-grammar HTTP 400 is not failed over and the review fails as a provider error", async () => {
  const bad = await listen(refuse("unsupported parameter: logit_bias"));
  let secondHits = 0;
  const good = await listen((_req, res) => {
    secondHits++;
    reviewReply(res);
  });
  const { outcome, dir } = await reviewOver(
    { beast: `http://127.0.0.1:${port(bad)}/v1`, hive: `http://127.0.0.1:${port(good)}/v1` },
    [preferred, next],
  );
  try {
    assert.notEqual(outcome.exitStatus, "succeeded");
    assert.equal(secondHits, 0, "the second route must not be asked");
    assert.match(outcome.summary, /unsupported parameter|400/i);
  } finally {
    for (const s of [bad, good]) {
      s.closeAllConnections();
      s.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when every route refuses the grammar the run fails cleanly, naming the refusal", async () => {
  const msg = "Failed to initialize samplers: failed to parse grammar";
  const a = await listen(refuse(msg));
  const b = await listen(refuse(msg));
  const { outcome, dir } = await reviewOver(
    { beast: `http://127.0.0.1:${port(a)}/v1`, hive: `http://127.0.0.1:${port(b)}/v1` },
    [preferred, next],
  );
  try {
    assert.notEqual(outcome.exitStatus, "succeeded");
    assert.match(outcome.summary, /failed to parse grammar/i);
  } finally {
    for (const s of [a, b]) {
      s.closeAllConnections();
      s.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
