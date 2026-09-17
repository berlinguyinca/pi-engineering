#!/usr/bin/env node
/**
 * InferWeave context dogfood: prove the capability client and provider work
 * against a REAL HTTP gateway (node:http on an ephemeral port) that speaks the
 * exact surface the node gateway serves — /v1/models with the capability
 * extension, /v1/models/{id}/capabilities with ETag/304 — and that a base URL
 * written WITH a trailing /v1 (the documented spelling) resolves the same as
 * one without.
 *
 * The defect class this covers is not reachable from unit tests: they inject a
 * mock transport, so a URL the code builds but the gateway does not serve
 * (listing at /models vs /v1/models, a doubled /v1/v1) passes every unit and
 * only dies in the operator's footer as "listing refresh failed".
 *
 * Phases:
 *   1. a documented-spelling base URL (…/v1) refreshes the listing and maps
 *      guaranteed_routable_tokens -> contextWindow, output cap -> maxTokens;
 *   2. a root spelling (no /v1) resolves identically — one integration, two
 *      ways of writing the address;
 *   3. an unchanged capability answers 304 and the client does not re-fetch
 *      the document body;
 *   4. the gateway dying degrades to stale-if-error, not to a fabricated
 *      window: the last-known-good value keeps serving, marked stale;
 *   5. a model the gateway has never described resolves to the conservative
 *      128K floor — never 260000, never 262144;
 *   6. planModelSwitch: 1M -> 128K demands compaction, an impossible switch is
 *      refused, and a wide-enough switch is a no-op.
 *
 * Deterministic: scripted gateway, no live model call, no external network.
 * Exit 0 when every phase passes.
 *
 *   node scripts/dogfood-inferweave-context.ts [--verbose]
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FORBIDDEN_FALLBACK_CONTEXTS, type ModelCapability, resolveModelContext } from "../src/context/capability.ts";
import { InferWeaveCapabilityClient } from "../src/context/client.ts";
import { createInferweaveProvider, httpTransport, inferweaveConfigFromEnv } from "../src/context/provider.ts";
import { planModelSwitch } from "../src/context/usage.ts";

const verbose = process.argv.includes("--verbose");
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}`);
    failures.push(what);
  }
}

// ── the scripted gateway ─────────────────────────────────────────────────────
// The exact paths the node gateway owns. /models (unsanitised) is deliberately
// NOT served: the node's nginx refuses it, so a client that asks for it is
// broken even if a bare llama.cpp would have answered.

interface CapabilityDoc {
  model_id: string;
  guaranteed_routable_tokens: number;
  max_routable_tokens: number;
  max_output_tokens: number;
  heterogeneous: boolean;
  capability_generation: string;
  freshness: "fresh" | "stale" | "expired" | "unknown";
  capability_source: string;
  last_observed_at: number;
}

const CAPABILITIES: Record<string, CapabilityDoc> = {
  "qwen3.8-27b": {
    model_id: "qwen3.8-27b",
    guaranteed_routable_tokens: 262_144,
    max_routable_tokens: 1_048_576,
    max_output_tokens: 32_768,
    heterogeneous: true,
    capability_generation: "gen-a1",
    freshness: "fresh",
    capability_source: "local/llama.cpp/n_ctx",
    last_observed_at: Math.floor(Date.now() / 1000),
  },
  "qwen3.8-27b-small": {
    model_id: "qwen3.8-27b-small",
    guaranteed_routable_tokens: 131_072,
    max_routable_tokens: 131_072,
    max_output_tokens: 8_192,
    heterogeneous: false,
    capability_generation: "gen-b2",
    freshness: "fresh",
    capability_source: "local/llama.cpp/ctx-size",
    last_observed_at: Math.floor(Date.now() / 1000),
  },
};

const LISTING = {
  object: "list",
  data: [
    { id: "qwen3.8-27b", object: "model", owned_by: "qwen-turing", ...CAPABILITIES["qwen3.8-27b"] },
    { id: "qwen3.8-27b-small", object: "model", owned_by: "qwen-turing", ...CAPABILITIES["qwen3.8-27b-small"] },
    // an id the listing names but says nothing about context for:
    { id: "mystery-70b", object: "model", owned_by: "qwen-turing" },
  ],
};

const state = { documentRequests: 0, dead: false };

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(raw);
}

const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = (req.url ?? "").split("?")[0];
  if (state.dead) {
    res.destroy();
    return;
  }
  if (url === "/v1/models" || url === "/models") {
    // /models is refused the way the node's nginx refuses it:
    if (url === "/models") return json(res, 404, { error: { message: "unsanitised /models is not served" } });
    return json(res, 200, LISTING);
  }
  const cap = url.match(/^\/v1\/models\/([^/]+)\/capabilities$/);
  if (cap) {
    const doc = CAPABILITIES[decodeURIComponent(cap[1])];
    if (!doc) return json(res, 404, { error: { message: "no capability observed" }, code: "not_found" });
    state.documentRequests += 1;
    const etag = `"${doc.capability_generation}"`;
    if (req.headers["if-none-match"] === etag) {
      state.documentRequests -= 1; // a 304 is a revalidation, not a fetch
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    return json(res, 200, doc, { ETag: etag });
  }
  json(res, 404, { error: { message: `no such gateway path: ${url}` } });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

// The operator's documented spelling carries the trailing /v1; the client's
// doc spelling does not. Both must reach the same gateway.
const BASE_V1 = `http://127.0.0.1:${port}/v1`;
const BASE_ROOT = `http://127.0.0.1:${port}`;

const mkClient = (baseUrl: string): InferWeaveCapabilityClient =>
  new InferWeaveCapabilityClient({
    baseUrl,
    transport: httpTransport,
    ttlSeconds: 3600,
    staleIfErrorSeconds: 3600,
    timeoutMs: 3000,
  });

console.log("phase 1: documented spelling (…/v1) — listing refresh and the two mappings");
{
  const config = inferweaveConfigFromEnv({ INFERWEAVE_BASE_URL: BASE_V1 });
  const provider = createInferweaveProvider(config);
  const models = await provider.registration.refreshModels({});
  const big = models.find((m) => m.id === "qwen3.8-27b");
  const small = models.find((m) => m.id === "qwen3.8-27b-small");
  check(
    big?.contextWindow === 262_144,
    `guaranteed routable context becomes Pi contextWindow (262144, got ${big?.contextWindow})`,
  );
  check(big?.maxTokens === 32_768, `advertised output cap becomes Pi maxTokens (32768, got ${big?.maxTokens})`);
  check(
    small?.contextWindow === 131_072,
    `second model resolves to its own window (131072, got ${small?.contextWindow})`,
  );
  check(
    models.some((m) => m.id === "mystery-70b"),
    "an undescribed id is still registered, on the floor",
  );
}

console.log("phase 2: root spelling (no /v1) — one integration, two address spellings");
{
  const config = inferweaveConfigFromEnv({ INFERWEAVE_BASE_URL: BASE_ROOT });
  const provider = createInferweaveProvider(config);
  const models = await provider.registration.refreshModels({});
  check(
    models.some((m) => m.id === "qwen3.8-27b" && m.contextWindow === 262_144),
    "root spelling resolves the same window",
  );
  check(
    config.baseUrl === BASE_ROOT || config.baseUrl === `${BASE_ROOT}/v1`,
    "the base URL is normalised, not mangled",
  );
}

console.log("phase 3: unchanged capability — 304 revalidation, no body re-fetch");
{
  const client = mkClient(BASE_ROOT);
  const first = await client.capability("qwen3.8-27b");
  const before = state.documentRequests;
  const second = await client.refresh("qwen3.8-27b");
  check(first?.guaranteedRoutableTokens === 262_144, "first fetch returns the capability");
  check(second?.guaranteedRoutableTokens === 262_144, "revalidation returns the cached capability");
  check(
    state.documentRequests === before,
    `a 304 costs no document fetch (requests ${before} -> ${state.documentRequests})`,
  );
}

console.log("phase 4: gateway dies — stale-if-error, not a fabricated window");
{
  // ttlSeconds 0 so the second call must revalidate against the network;
  // with a long TTL the cached value would legitimately still be fresh and
  // the outage would never be exercised.
  const client = new InferWeaveCapabilityClient({
    baseUrl: BASE_ROOT,
    transport: httpTransport,
    ttlSeconds: 0,
    staleIfErrorSeconds: 3600,
    timeoutMs: 3000,
  });
  await client.capability("qwen3.8-27b-small");
  state.dead = true; // the socket is destroyed: a real outage, not a polite 503
  await new Promise((r) => setTimeout(r, 50));
  const resolved = await client.resolve("qwen3.8-27b-small");
  check(
    resolved.contextWindow === 131_072,
    `the last-known-good value keeps serving (131072, got ${resolved.contextWindow})`,
  );
  check(resolved.stale === true, "and it is marked stale, so the operator sees the outage");
  check(!FORBIDDEN_FALLBACK_CONTEXTS.includes(resolved.contextWindow), "the fallback is not a forbidden constant");
  state.dead = false;
}

console.log("phase 5: never-described model — the 128K floor, never 260K");
{
  const config = inferweaveConfigFromEnv({ INFERWEAVE_BASE_URL: BASE_ROOT });
  const provider = createInferweaveProvider(config);
  await provider.registration.refreshModels({});
  const mystery = provider.resolved("mystery-70b");
  check(
    mystery?.contextWindow === 128_000,
    `an undescribed id lands on the conservative floor (128000, got ${mystery?.contextWindow})`,
  );
  check(mystery?.basis === "conservative_fallback", "the basis says so, instead of hiding it");
  check(!FORBIDDEN_FALLBACK_CONTEXTS.includes(mystery?.contextWindow ?? -1), "260000/262144 are never the answer");
}

console.log("phase 6: model switch — compact when it must, refuse what cannot fit");
{
  const wide = 1_048_576;
  const narrow = 131_072;
  const used = 200_000;
  const toNarrow = planModelSwitch(used, wide, narrow, { reserveOutputTokens: 8_192 });
  check(toNarrow.action === "compact", `1M -> 128K with 200K in use demands compaction (got ${toNarrow.action})`);
  const bigOverflow = planModelSwitch(used, wide, 32_768, { reserveOutputTokens: 8_192 });
  check(
    bigOverflow.action === "compact" && bigOverflow.overflowTokens > 100_000,
    `a 200K session into a 32K window compacts hard, not blindly (got ${bigOverflow.action}, ${bigOverflow.overflowTokens} out)`,
  );
  // The genuinely impossible case: the target window cannot hold the reserved
  // output plus any context at all — no compaction can save that request.
  const impossible = planModelSwitch(8_000, wide, 8_192, { reserveOutputTokens: 8_192 });
  check(
    impossible.action === "reject",
    `a window too small for its own output budget is refused (got ${impossible.action})`,
  );
  const fine = planModelSwitch(used, narrow, wide, { reserveOutputTokens: 8_192 });
  check(fine.action === "none", `a switch to a wider window is a no-op (got ${fine.action})`);
  const floor = resolveModelContext("anything", undefined, {});
  check(floor.contextWindow === 128_000, "with no capability at all, the floor applies");
}

server.close();
if (failures.length > 0) {
  console.log(`\ndogfood FAILED: ${failures.length} check(s)`);
  process.exit(1);
}
console.log("\ndogfood passed: all six phases");
