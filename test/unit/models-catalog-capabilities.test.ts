/**
 * Issue #156: the gateway catalogue keeps `x_capabilities`, `x_family` and
 * `x_tools` (left undefined when absent, never invented), and the admission
 * transport tags main requests with `x-inferweave-session`.
 */
import assert from "node:assert/strict";
import { type IncomingHttpHeaders, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeAdmissionConfig } from "../../src/inference/admissionConfig.ts";
import {
  type AdmissionFetch,
  type AdmissionStreamFunction,
  createAdmissionStreamSimple,
  terminalAssistantMessage,
} from "../../src/inference/admissionTransport.ts";
import { parseGatewayModels } from "../../src/models/gatewayCatalog.ts";

const row = (extra: Record<string, unknown>) => ({ id: "m", ctx_per_request: 8192, ...extra });

test("an entry with x_family set exposes family", () => {
  const [entry] = parseGatewayModels({ data: [row({ x_family: "qwen" })] });
  assert.equal(entry?.family, "qwen");
});

test("an entry with x_capabilities exposes capabilities, and x_tools false is kept as false", () => {
  const [entry] = parseGatewayModels({
    data: [row({ x_capabilities: ["tool_use", "coding.implementer", 7, ""], x_tools: false })],
  });
  assert.deepEqual(entry?.capabilities, ["tool_use", "coding.implementer"]);
  assert.equal(entry?.tools, false);
});

test("an entry without x_tools has tools undefined, and nothing else is invented", () => {
  const [entry] = parseGatewayModels({ data: [row({})] });
  assert.equal(entry?.tools, undefined);
  assert.equal(entry?.family, undefined);
  assert.equal(entry?.capabilities, undefined);
  assert.equal("tools" in (entry ?? {}), false);
  assert.equal("capabilities" in (entry ?? {}), false);
  assert.equal("family" in (entry ?? {}), false);
});

test("the generic `capabilities` field is accepted like the planner parser does", () => {
  const [entry] = parseGatewayModels({ data: [row({ capabilities: ["vision"] })] });
  assert.deepEqual(entry?.capabilities, ["vision"]);
});

test("an empty capability list and a wrong-typed x_tools stay undefined", () => {
  const [entry] = parseGatewayModels({ data: [row({ x_capabilities: [], x_tools: "yes", x_family: "" })] });
  assert.equal(entry?.capabilities, undefined);
  assert.equal(entry?.tools, undefined);
  assert.equal(entry?.family, undefined);
});

function model(): Model<Api> {
  return { api: "openai-completions", provider: "inferweave", id: "qwen" } as unknown as Model<Api>;
}

/** Runs one main request through the admission transport against a real local http server. */
async function headersSeenBy(
  scope: Parameters<typeof createAdmissionStreamSimple>[0]["scope"],
): Promise<IncomingHttpHeaders> {
  let seen: IncomingHttpHeaders = {};
  const server = createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
    const delegate: AdmissionStreamFunction = (m, _ctx, options) => {
      const stream = createAssistantMessageEventStream();
      void (options?.fetch as AdmissionFetch)(url, { method: "POST", headers: { "x-existing": "kept" }, body: "{}" })
        .then((r) => r.text())
        .then(() => {
          stream.push({ type: "error", reason: "error", error: terminalAssistantMessage(m, "done", "error") });
          stream.end();
        });
      return stream;
    };
    const run = createAdmissionStreamSimple({ config: normalizeAdmissionConfig({}), delegate, scope });
    for await (const _ of run(model(), {} as never, {})) {
      // drain
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return seen;
}

test("a scoped request carries header x-inferweave-session", async () => {
  const headers = await headersSeenBy({ sessionId: "mission-1234" });
  assert.equal(headers["x-inferweave-session"], "mission-1234");
  assert.equal(headers["x-existing"], "kept");
});

test("a scope function resolves the session id per request", async () => {
  const headers = await headersSeenBy((sessionId) => ({ sessionId: sessionId ?? "lane-fallback" }));
  assert.equal(headers["x-inferweave-session"], "lane-fallback");
});

test("an unscoped request carries no x-inferweave-session header", async () => {
  const headers = await headersSeenBy({});
  assert.equal(headers["x-inferweave-session"], undefined);
});

test("a session id that is not 1-256 printable ASCII is not sent", async () => {
  const headers = await headersSeenBy({ sessionId: "has space\nand newline" });
  assert.equal(headers["x-inferweave-session"], undefined);
});
