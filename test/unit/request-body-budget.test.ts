/**
 * The request-body budget on the live provider path.
 *
 * Fry's InferWeave gateway caps a request body at 10 MiB today (32 MiB once it
 * advertises its cap). A vision session carrying four full-resolution
 * screenshots (~3 MB of base64 each) sent 11.9 MB and died with a permanent
 * "413 request body too large". Nothing on the live path counted bytes.
 *
 * Every image here is a real PNG encoded with pngjs, and every re-encode goes
 * through Pi's own Photon resizer — no fakes.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { streamSimple as openAiStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { decideGatewayRetry, parseGatewayWait } from "../../src/gateway/signals.ts";
import { classifyError } from "../../src/guard/transient.ts";
import {
  type BudgetContext,
  DEFAULT_REQUEST_BODY_HEADROOM,
  FALLBACK_MAX_REQUEST_BODY_BYTES,
  REQUEST_LIMIT_HEADER,
  RequestBodyTooLargeError,
  advertisedRequestLimit,
  describeRequestTooLarge,
  estimateRequestBodyBytes,
  fitRequestBody,
  noteAdvertisedRequestLimit,
  noteRequestLimitHeader,
  requestBodyLimit,
  resetAdvertisedRequestLimits,
  resolveRequestBodyBudgetConfig,
} from "../../src/request/bodyBudget.ts";
import { classifyInfraError } from "../../src/resilience/classify.ts";
import { DEFAULT_INFERWEAVE_CAPABILITIES } from "../../src/vision/inferweave.ts";
import { extractMetadata } from "../../src/vision/processor.ts";
import { pngImage } from "../support/images.ts";

type Img = ReturnType<typeof pngImage>;
const user = (content: unknown[]) => ({ role: "user", content, timestamp: 1 });
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "probe",
  model: "m",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
});
const toolResult = (content: unknown[]) => ({
  role: "toolResult",
  toolCallId: "c1",
  toolName: "read",
  content,
  isError: false,
  timestamp: 1,
});

let screenshots: Img[] = [];
before(() => {
  // ~3 MB of base64 each, 2880x1800 like a retina screenshot.
  screenshots = [1, 2, 3, 4].map((seed) => pngImage(2880, 1800, 300, seed));
});

// ─── Budget source ─────────────────────────────────────────────────────────

test("budget: 10 MiB x 0.85 by default; env overrides; vision defaults agree", () => {
  resetAdvertisedRequestLimits();
  const config = resolveRequestBodyBudgetConfig({});
  const limit = requestBodyLimit(config, { baseUrl: "https://gw.example/v1", id: "m" });
  assert.equal(limit.maxBytes, FALLBACK_MAX_REQUEST_BODY_BYTES);
  assert.equal(FALLBACK_MAX_REQUEST_BODY_BYTES, 10 * 1024 * 1024);
  assert.equal(limit.budgetBytes, Math.floor(10 * 1024 * 1024 * DEFAULT_REQUEST_BODY_HEADROOM));
  assert.equal(limit.source, "fallback");
  assert.equal(DEFAULT_INFERWEAVE_CAPABILITIES.maxRequestBytes, FALLBACK_MAX_REQUEST_BODY_BYTES);

  const env = resolveRequestBodyBudgetConfig({ PI_MAX_REQUEST_BODY_BYTES: "2000000", PI_REQUEST_BODY_HEADROOM: "0.5" });
  const overridden = requestBodyLimit(env, { baseUrl: "https://gw.example/v1" });
  assert.deepEqual(overridden, { maxBytes: 2_000_000, budgetBytes: 1_000_000, source: "config" });

  const junk = resolveRequestBodyBudgetConfig({ PI_MAX_REQUEST_BODY_BYTES: "lots", PI_REQUEST_BODY_HEADROOM: "7" });
  assert.equal(requestBodyLimit(junk, {}).maxBytes, FALLBACK_MAX_REQUEST_BODY_BYTES);
  assert.equal(junk.headroom, DEFAULT_REQUEST_BODY_HEADROOM);
});

test("budget: an advertised cap (models listing or response header) replaces the fallback", () => {
  resetAdvertisedRequestLimits();
  const config = resolveRequestBodyBudgetConfig({});
  noteAdvertisedRequestLimit("https://gw.example/v1/", 32 * 1024 * 1024);
  const limit = requestBodyLimit(config, { baseUrl: "https://gw.example/v1", id: "m" });
  assert.equal(limit.maxBytes, 32 * 1024 * 1024);
  assert.equal(limit.source, "advertised");

  // A header on any response updates it; case-insensitive; junk ignored.
  noteRequestLimitHeader("https://gw.example/v1", { "X-InferWeave-Max-Request-Bytes": "20971520" });
  assert.equal(advertisedRequestLimit("https://gw.example/v1"), 20 * 1024 * 1024);
  noteRequestLimitHeader("https://gw.example/v1", { [REQUEST_LIMIT_HEADER]: "not-a-number" });
  assert.equal(advertisedRequestLimit("https://gw.example/v1"), 20 * 1024 * 1024);
  assert.equal(advertisedRequestLimit("https://other.example/v1"), undefined);
  resetAdvertisedRequestLimits();
});

// ─── Estimate ──────────────────────────────────────────────────────────────

test("estimate: conservative and close to pi-ai's real openai-completions body", async () => {
  const small = pngImage(640, 400, 60, 9);
  const context = {
    systemPrompt: "You are a careful engineer.".repeat(40),
    messages: [
      user([{ type: "text", text: "look at this" }, small]),
      assistant("I see a gradient."),
      toolResult([{ type: "text", text: "x".repeat(20_000) }, pngImage(320, 200, 30, 10)]),
    ],
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
  };
  const model = {
    id: "vision-model",
    name: "v",
    api: "openai-completions",
    provider: "probe",
    baseUrl: "http://127.0.0.1:9/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1000,
  };
  let payload: unknown;
  const stream = openAiStreamSimple(
    model as never,
    context as never,
    {
      apiKey: "k",
      onPayload: (params: unknown) => {
        payload = params;
        throw new Error("captured");
      },
    } as never,
  );
  await stream.result();
  assert.ok(payload, "pi-ai built its payload");
  const actual = Buffer.byteLength(JSON.stringify(payload));
  const estimate = estimateRequestBodyBytes(context as never);
  assert.ok(estimate >= actual, `estimate ${estimate} must not undercount the real ${actual}`);
  assert.ok(estimate <= actual * 1.05 + 16_384, `estimate ${estimate} is too pessimistic vs ${actual}`);
});

// ─── Fitting ───────────────────────────────────────────────────────────────

test("fit: a request under budget is sent as-is (same object)", async () => {
  const context = { messages: [user([{ type: "text", text: "hi" }])] };
  const fit = await fitRequestBody(context as BudgetContext, 1_000_000);
  assert.equal(fit.context, context);
  assert.deepEqual(fit.actions, []);
});

test("fit: four ~3 MB screenshots fit after a 1800px re-encode, transcript untouched", async () => {
  const context = {
    systemPrompt: "sys",
    messages: [
      user([{ type: "text", text: "first" }, screenshots[0]]),
      assistant("ok"),
      user([{ type: "text", text: "second" }, screenshots[1]]),
      assistant("ok"),
      user([{ type: "text", text: "third" }, screenshots[2]]),
      assistant("ok"),
      user([{ type: "text", text: "now compare" }, screenshots[3]]),
    ],
  };
  const snapshot = JSON.stringify(context);
  const before = estimateRequestBodyBytes(context as never);
  const budget = Math.floor(FALLBACK_MAX_REQUEST_BODY_BYTES * DEFAULT_REQUEST_BODY_HEADROOM);
  assert.ok(before > budget, `fixture must reproduce the incident (${before} bytes)`);

  const fit = await fitRequestBody(context as BudgetContext, budget);
  assert.ok(fit.estimatedBytes <= budget);
  assert.equal(JSON.stringify(context), snapshot, "the session transcript is never mutated");
  const images = fit.context.messages.flatMap((m) =>
    Array.isArray((m as { content?: unknown }).content)
      ? ((m as { content: Array<{ type: string; data?: string; mimeType?: string }> }).content.filter(
          (b) => b.type === "image",
        ) as Array<{ data: string; mimeType: string }>)
      : [],
  );
  assert.equal(images.length, 4, "re-encoding was enough: nothing was dropped");
  for (const image of images) {
    const meta = extractMetadata(Buffer.from(image.data, "base64"));
    assert.ok(Math.max(meta.width ?? 0, meta.height ?? 0) <= 1800, "long edge capped at 1800px");
    assert.ok(Math.abs((meta.width ?? 0) / (meta.height ?? 1) - 2880 / 1800) < 0.01, "aspect ratio kept");
  }
});

test("fit: images over 1800px are downscaled even when the request already fits", async () => {
  const context = { messages: [user([{ type: "text", text: "one" }, screenshots[0]])] };
  const fit = await fitRequestBody(context as BudgetContext, 64 * 1024 * 1024);
  const image = (fit.context.messages[0] as { content: Array<{ data?: string }> }).content[1];
  const meta = extractMetadata(Buffer.from(image?.data ?? "", "base64"));
  assert.equal(Math.max(meta.width ?? 0, meta.height ?? 0), 1800);
  assert.notEqual(fit.context, context);
});

test("fit: with many images the OLDEST become placeholders; the newest message keeps its images", async () => {
  // Small noisy images: already under 1800px and under the re-encode target,
  // so only placeholders can make room.
  const img = (seed: number) => pngImage(260, 260, 260, seed);
  const newest = [img(100), img(101)];
  const messages: unknown[] = [];
  for (let i = 0; i < 8; i++) {
    messages.push(user([{ type: "text", text: `turn ${i}` }, img(i)]));
    messages.push(assistant(`seen ${i}`));
  }
  messages.push(user([{ type: "text", text: "latest" }, ...newest]));
  const context = { messages };
  const snapshot = JSON.stringify(context);
  const perImage = newest[0]?.data.length ?? 0;
  const budget = perImage * 6;

  const fit = await fitRequestBody(context as BudgetContext, budget);
  assert.ok(fit.estimatedBytes <= budget);
  assert.equal(JSON.stringify(context), snapshot);
  const out = fit.context.messages as Array<{ content: Array<{ type: string; text?: string; data?: string }> }>;
  const last = out.at(-1)?.content ?? [];
  assert.deepEqual(
    last.filter((b) => b.type === "image").map((b) => b.data),
    newest.map((i) => i.data),
    "the newest message's images are byte-identical",
  );
  const first = out[0]?.content ?? [];
  assert.equal(first[1]?.type, "text");
  assert.match(first[1]?.text ?? "", /^\[image omitted to fit the request size limit: image\/png/);
  // Oldest go first: once an image survives, every later one does too.
  const kept = out
    .slice(0, -1)
    .filter((m) => (m as { role?: string }).role === "user")
    .map((m) => m.content.some((b) => b.type === "image"));
  assert.ok(kept.includes(false) && kept.includes(true), "some old images dropped, some kept");
  assert.equal(kept.indexOf(true) === -1 || kept.slice(kept.indexOf(true)).every(Boolean), true);
  assert.ok(fit.actions.some((a) => a.startsWith("omitted")));
});

test("fit: giant old tool results are truncated with a marker; the newest are left alone", async () => {
  const big = "log line\n".repeat(200_000); // ~1.8 MB
  const context = {
    messages: [
      user([{ type: "text", text: "run it" }]),
      assistant("running"),
      toolResult([{ type: "text", text: big }]),
      assistant("again"),
      toolResult([{ type: "text", text: "short newest result" }]),
    ],
  };
  const fit = await fitRequestBody(context as BudgetContext, 200_000);
  assert.ok(fit.estimatedBytes <= 200_000);
  const out = fit.context.messages as Array<{ content: Array<{ text?: string }> }>;
  assert.match(out[2]?.content[0]?.text ?? "", /tool output omitted to fit the request size limit/);
  assert.equal(out[4]?.content[0]?.text, "short newest result");
  assert.equal((context.messages[2] as { content: Array<{ text: string }> }).content[0]?.text, big);
});

test("fit: when the newest content alone is too big it fails fast and says so", async () => {
  const context = {
    messages: [user([{ type: "text", text: "x".repeat(300_000) }])],
  };
  await assert.rejects(fitRequestBody(context as BudgetContext, 100_000), (error: unknown) => {
    assert.ok(error instanceof RequestBodyTooLargeError);
    assert.match(error.message, /request body too large/i);
    assert.match(error.message, /estimated 0\.2\d MiB/, "names the estimated size");
    assert.match(error.message, /the 0\.10 MiB request budget/, "names the limit");
    assert.equal(
      isRetryableAssistantError({ stopReason: "error", errorMessage: error.message } as never),
      false,
      "Pi's own retry must not pick it up either",
    );
    // Nothing downstream may treat it as retryable.
    assert.equal(classifyError(error).retryable, false);
    assert.equal(parseGatewayWait({ text: error.message }), null);
    assert.equal(classifyInfraError(error).retryable, false);
    return true;
  });
});

// ─── A gateway 413 ─────────────────────────────────────────────────────────

test("a gateway 413 is permanent everywhere and explained", () => {
  // Go's http.MaxBytesReader: "http: request body too large" (the 23-byte body).
  for (const text of [
    "413 http: request body too large",
    "413 Payload Too Large",
    "Error: 413 Request Entity Too Large",
  ]) {
    assert.equal(classifyError(new Error(text)).retryable, false, text);
    assert.equal(decideGatewayRetry(text, 0, 3).action, "not-gateway", text);
    const infra = classifyInfraError(new Error(text));
    assert.equal(infra.retryable, false, text);
    assert.equal(infra.category, "INVALID_REQUEST", text);
    const described = describeRequestTooLarge(text, 10 * 1024 * 1024);
    assert.ok(described?.includes(text), "keeps the original text");
    assert.match(described ?? "", /10 MiB/);
    assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: described } as never), false);
  }
  // A context-length 413 is still a context problem, not a body-size one.
  assert.equal(
    classifyInfraError(new Error("413 request too large: context length exceeded")).category,
    "CONTEXT_RECOVERABLE",
  );
  assert.equal(describeRequestTooLarge("503 no worker for model", 1), undefined);
});

test("budget: GET /models advertises the cap (listing field, per model, or header) over real HTTP", async () => {
  const { createServer } = await import("node:http");
  const { fetchGatewayModels } = await import("../../src/models/gatewayCatalog.ts");
  resetAdvertisedRequestLimits();
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("X-InferWeave-Max-Request-Bytes", String(30 * 1024 * 1024));
    res.end(
      JSON.stringify({
        max_request_bytes: 32 * 1024 * 1024,
        data: [
          { id: "a", ctx_per_request: 1000 },
          { id: "b", ctx_per_request: 1000, max_request_bytes: 16 * 1024 * 1024 },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/v1`;
    await fetchGatewayModels({ baseUrl: base });
    const config = resolveRequestBodyBudgetConfig({});
    assert.equal(requestBodyLimit(config, { baseUrl: base, id: "a" }).maxBytes, 32 * 1024 * 1024, "listing field");
    assert.equal(requestBodyLimit(config, { baseUrl: base, id: "b" }).maxBytes, 16 * 1024 * 1024, "per-model field");
  } finally {
    server.close();
    resetAdvertisedRequestLimits();
  }
});
