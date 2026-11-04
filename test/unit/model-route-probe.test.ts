/**
 * The probe, not the listing, decides which routes exist.
 *
 * Recorded live against https://llm.metabolomics.us/v1 on 2026-11-03, `GET
 * /v1/models` returns seven rows while eleven routes answer
 * `/v1/chat/completions`, and two of the seven are advertised routes that 404:
 *
 *   route                  listed   completion
 *   qwen3.8-27b            no       200
 *   qwen3.8-27b-text       no       200
 *   qwen3.8-flash-text     no       200
 *   qwen3.8-flash          no       200
 *   laya                   yes      404, then 200 with no completion at all
 *   laya-text              yes      same
 *   not-a-route-xyz        no       404            (control)
 *
 * `laya` was seen refusing with `"Model laya is not served here"` and, an hour
 * later, answering the refresh probe with HTTP 200 and no usable completion.
 * Either way it produced no completion, which is the only question the probe
 * asks; both shapes must leave it unconfigured.
 *
 * Listing-only discovery is therefore wrong in both directions: it deletes
 * working models — the operator report that opened this was "I still don't see
 * the qwen3.8-27b alias", and a refresh really did prune it — and it installs
 * routes that cannot serve a request. These tests pin the replacement rule:
 * a route is configured when the gateway answers for it, and removed only when
 * the gateway refuses it and no listing claims it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aliasView, isRouteName, unadvertisedRouteCandidates } from "../../src/models/aliasCatalog.ts";
import { parseGatewayModels } from "../../src/models/gatewayCatalog.ts";
import { refreshProviderModels } from "../../src/models/refresh.ts";

const V27 = "qwen3.8-27b-modality-vision-quant-q8_k_xl";
const FLASH = "qwen3.8-flash-modality-vision-quant-iq4_xs";
const FN_TEXT = "qwen3.8-flash_next-modality-text-quant-q4_k_xl";
const FN_W3A8 = "qwen3.8-flash_next-modality-text-quant-w3a8";

/** The seven rows the live gateway lists. Note: no `-27b-text` anywhere. */
const ROWS = [
  { id: V27, x_context_window: 262144, x_state: "warm", slots: 5 },
  { id: FLASH, x_context_window: 262144, x_state: "warm", slots: 2 },
  { id: FN_TEXT, x_context_window: 262144, x_state: "warm", slots: 3 },
  { id: FN_W3A8, x_context_window: 131072, x_state: "warm", slots: 3 },
  { id: "laya", x_alias: true, x_members: [V27], x_context_window: 1024 },
  { id: "laya-text", x_alias: true, x_members: [V27], x_context_window: 1024 },
  { id: "qwen3.8-text", x_alias: true, x_members: [FN_TEXT, FN_W3A8], x_context_window: 262144 },
];

/** Names that answered 200 in the live probe. `laya` is deliberately absent. */
const ANSWERING = new Set([
  "qwen3.8",
  "qwen3.8-27b",
  "qwen3.8-27b-text",
  "qwen3.8-27b-vision",
  "qwen3.8-flash",
  "qwen3.8-flash-text",
  "qwen3.8-flash-vision",
  "qwen3.8-flash_next",
  "qwen3.8-flash_next-text",
  "qwen3.8-text",
  "qwen3.8-vision",
]);

const COMPLETION = JSON.stringify({
  id: "cmpl-1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
});

const NOT_SERVED = (model: string) =>
  JSON.stringify({
    error: {
      type: "invalid_request",
      message: `Model ${model} is not served here.`,
      code: "model_not_found",
      action: "fix_request",
      scope: "request",
    },
  });

/** A gateway that behaves like the live one: the listing lies, completions do not. */
function gateway(overrides: Record<string, boolean> = {}) {
  const probes: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v1/models")) return new Response(JSON.stringify({ data: ROWS }));
    if (u.includes("/chat/completions")) {
      const model = String(JSON.parse(String(init?.body ?? "{}")).model);
      probes.push(model);
      const answers = overrides[model] ?? ANSWERING.has(model);
      return answers
        ? new Response(COMPLETION)
        : new Response(NOT_SERVED(model), { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, probes };
}

function configWith(ids: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pi-route-probe-"));
  const modelsPath = join(dir, "models.json");
  const model = (id: string) => ({ id, name: id, contextWindow: 131072, maxTokens: 32768, input: ["text"] });
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        metabolomics: {
          baseUrl: "https://gw.example/v1",
          api: "openai-completions",
          apiKey: "k",
          models: ids.map(model),
        },
      },
    }),
  );
  return modelsPath;
}

function writtenIds(modelsPath: string): string[] {
  return (JSON.parse(readFileSync(modelsPath, "utf8")).providers.metabolomics.models as Array<{ id: string }>).map(
    (model) => model.id,
  );
}

function written(modelsPath: string): Array<{ id: string; name?: string; contextWindow?: number }> {
  return JSON.parse(readFileSync(modelsPath, "utf8")).providers.metabolomics.models;
}

test("a route the listing hides but the gateway answers is configured", async () => {
  const gw = gateway();
  const modelsPath = configWith([]);
  const result = await refreshProviderModels({
    modelsPath,
    providerId: "metabolomics",
    apiKey: "k",
    probeModels: true,
    fetchImpl: gw.fetchImpl,
  });
  const ids = writtenIds(modelsPath);
  // The operator's missing alias, and the two the last refresh deleted.
  for (const route of ["qwen3.8-27b-text", "qwen3.8-flash-text", "qwen3.8-27b"]) {
    assert.ok(ids.includes(route), `${route} answers and must be configured; got ${ids.join(", ")}`);
  }
  assert.ok(result.written, "the refresh must have written the configuration");
  const named = written(modelsPath).find((model) => model.id === "qwen3.8-27b-text");
  assert.match(
    named?.name ?? "",
    /answers, not advertised/,
    "a route nothing lists has to say so where a human will read it",
  );
});

test("a route the gateway advertises but will not serve is not configured", async () => {
  const modelsPath = configWith([]);
  await refreshProviderModels({
    modelsPath,
    providerId: "metabolomics",
    apiKey: "k",
    probeModels: true,
    fetchImpl: gateway().fetchImpl,
  });
  const ids = writtenIds(modelsPath);
  assert.ok(!ids.includes("laya"), "laya is advertised and returns 404 to a completion");
  assert.ok(!ids.includes("laya-text"), "laya-text is advertised and returns 404 to a completion");
});

test("an advertised route whose 200 carries no completion is not configured", async () => {
  // Seen live: `laya` refused with 404 in one hour and returned HTTP 200 with no
  // completion at all the next, which the probe reported as "HTTP 200 without a
  // completion". A 200 that produced no completion is not evidence a model can be
  // used, so it must not enter the configuration either way. A 200 that carries a
  // choice whose content is empty is a different case and deliberately a working
  // one: a reasoning model can spend the whole probe budget thinking, and an
  // answered request still proves the route is served.
  const dir = mkdtempSync(join(tmpdir(), "pi-route-probe-"));
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        metabolomics: { baseUrl: "https://gw.example/v1", api: "openai-completions", apiKey: "k", models: [] },
      },
    }),
  );
  const noCompletion = JSON.stringify({ id: "resp-2", object: "chat.completion", choices: [] });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v1/models")) return new Response(JSON.stringify({ data: ROWS }));
    const model = String(JSON.parse(String(init?.body ?? "{}")).model);
    if (u.includes("/chat/completions")) return new Response(model.startsWith("laya") ? noCompletion : COMPLETION);
    return new Response("unexpected", { status: 404 });
  }) as typeof fetch;
  await refreshProviderModels({ modelsPath, providerId: "metabolomics", apiKey: "k", probeModels: true, fetchImpl });
  const ids = writtenIds(modelsPath);
  assert.ok(!ids.includes("laya") && !ids.includes("laya-text"), `no completion, no entry; got ${ids.join(", ")}`);
  assert.ok(ids.includes("qwen3.8-text"), "the routes that do answer are still configured");
});

test("a configured route the listing omits survives when it answers", async () => {
  const modelsPath = configWith(["qwen3.8-27b-text", "qwen3.8-flash-text"]);
  const result = await refreshProviderModels({
    modelsPath,
    providerId: "metabolomics",
    apiKey: "k",
    probeModels: true,
    fetchImpl: gateway().fetchImpl,
  });
  const ids = writtenIds(modelsPath);
  assert.ok(ids.includes("qwen3.8-27b-text"), "the deletion the operator hit must not happen again");
  assert.ok(ids.includes("qwen3.8-flash-text"));
  assert.ok(
    !result.plan.changes.some((change) => change.kind === "missing" && change.id === "qwen3.8-27b-text"),
    "a route that answers must never be planned as missing",
  );
});

test("a configured route nothing lists and the gateway refuses is pruned on that evidence", async () => {
  const modelsPath = configWith(["qwen3.8-pro-max"]);
  const gw = gateway();
  const result = await refreshProviderModels({
    modelsPath,
    providerId: "metabolomics",
    apiKey: "k",
    probeModels: true,
    fetchImpl: gw.fetchImpl,
  });
  assert.ok(!writtenIds(modelsPath).includes("qwen3.8-pro-max"), "a name no route answers is retired");
  assert.ok(gw.probes.includes("qwen3.8-pro-max"), "it must have been probed before being removed");
  assert.ok(
    result.lines.some((line) => line.includes("excluded: qwen3.8-pro-max")),
    `the report must say why; got:\n${result.lines.join("\n")}`,
  );
});

test("without a probe, a configured route nothing lists is kept and reported", async () => {
  const modelsPath = configWith(["qwen3.8-27b-text"]);
  const gw = gateway();
  const result = await refreshProviderModels({
    modelsPath,
    providerId: "metabolomics",
    apiKey: "k",
    fetchImpl: gw.fetchImpl,
  });
  assert.ok(writtenIds(modelsPath).includes("qwen3.8-27b-text"), "no probe, no evidence, no deletion");
  assert.equal(gw.probes.length, 0, "a refresh that does not probe must not send completions");
  assert.ok(
    result.lines.some((line) => line.includes("kept without evidence")),
    `the report must say the entry is unverified; got:\n${result.lines.join("\n")}`,
  );
});

test("route candidates come from listed classes only, and never re-ask a listed row", () => {
  const listed = parseGatewayModels({ data: ROWS });
  const view = aliasView(listed);
  const { entries, configuredOnly } = unadvertisedRouteCandidates(listed, view, [
    { id: "qwen3.8-27b-text", contextWindow: 262144 },
    { id: "ops-router", contextWindow: 65536 },
    { id: V27, contextWindow: 262144 },
  ]);

  // Every candidate is a route name the listing covers neither as a row nor as
  // an alias — nothing is invented from a name the gateway never implied.
  const covered = new Set([...view.entries.map((entry) => entry.id), ...listed.map((entry) => entry.id)]);
  assert.ok(entries.length > 0, "a gateway that hides routes must still yield candidates");
  for (const entry of entries) {
    assert.ok(!covered.has(entry.id), `${entry.id} is already covered and must not be probed`);
    assert.equal(entry.origin, "probed");
    assert.ok(isRouteName(entry.id), `${entry.id} must be route-shaped`);
  }
  // The hidden 27B text route is exactly what the derivation exists to find.
  assert.ok(entries.some((entry) => entry.id === "qwen3.8-27b-text"));
  // A configured route the class derivation already reached is not asked twice;
  // one no class implies is still probed before anything deletes it; a
  // configured BUILD id is a retired model, not a hidden route, so it is not.
  assert.deepEqual(configuredOnly, ["ops-router"]);
  // The window of a route with no listed member of its own is read from its
  // class, never invented large.
  const flashText = entries.find((entry) => entry.id === "qwen3.8-flash-text");
  assert.ok(flashText && flashText.contextWindow <= 262144);
});

test("a route never names members of a modality its own name excludes", () => {
  const listed = parseGatewayModels({ data: ROWS });
  const { entries } = unadvertisedRouteCandidates(listed, aliasView(listed), []);
  // Every listed flash_next build is a `-text-` build, so a `-vision` route in
  // that class must not claim them: answering is proved by the probe, membership
  // is not. Claiming them would write a name that promises vision and names
  // weights that cannot deliver it.
  const vision = entries.find((entry) => entry.id === "qwen3.8-flash_next-vision");
  assert.ok(vision, "the name is derived from a listed class, so it is worth probing");
  assert.deepEqual(vision.members ?? [], [], `a -vision route must not name text builds: ${vision.members}`);
  assert.equal(vision.backingModel, undefined);
  // The mirrored case: the hidden 27B text route has a listed vision build of
  // its class, so the class gives the window but not the membership either.
  const text = entries.find((entry) => entry.id === "qwen3.8-27b-text");
  assert.ok(text && text.contextWindow === 262144);
  assert.deepEqual(text.members ?? [], []);
});
