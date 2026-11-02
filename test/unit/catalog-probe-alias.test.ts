/**
 * The preflight probe must judge an alias by its members.
 *
 * Pi configures aliases only, so the probe is asked about `qwen3.8-text` or
 * `qwen3.8-vision`, never a concrete id. The gateway lists the first (with
 * `x_members`) and resolves the second without listing it, and neither has an
 * admission entry of its own. Judged as a concrete id both read as "not
 * served" or "capacity unknown" and every task would stall behind the gate,
 * although the gateway's own probes say its members are warm with slots.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CatalogRecoveryProbe } from "../../src/resilience/probe.ts";

const V27 = "qwen3.8-27b-modality-vision-quant-q8_k_xl";
const FLASH = "qwen3.8-flash-modality-vision-quant-iq4_xs";
const W3 = "qwen3.8-flash_next-modality-text-quant-w3a8";

function listing(overrides: Record<string, Record<string, unknown>> = {}) {
  const row = (id: string, slots: number, extra: Record<string, unknown> = {}) => ({
    id,
    x_context_window: 262144,
    ctx_per_request: 262144,
    x_state: "warm",
    slots,
    ...extra,
    ...overrides[id],
  });
  return {
    data: [
      row(V27, 1),
      row(FLASH, 2),
      row(W3, 3, { x_context_window: 131072, ctx_per_request: 131072 }),
      row("qwen3.8-text", 3, { x_alias: true, x_members: [W3] }),
    ],
  };
}

/** The live admission report: only nodes that reported capacity have an entry. */
function admission(models: Record<string, unknown>) {
  return { enabled: true, closed: false, models };
}

function probeFor(modelId: string, catalog: unknown, report: unknown | undefined = admission({})) {
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return new Response(JSON.stringify(catalog));
    if (u.endsWith("/iw/v1/admission")) {
      return report === undefined ? new Response("nope", { status: 500 }) : new Response(JSON.stringify(report));
    }
    return new Response("unexpected", { status: 404 });
  }) as typeof fetch;
  return new CatalogRecoveryProbe({
    resolve: async () => ({ baseUrl: "https://gw.example/v1", modelId, provider: "metabolomics" }),
    fetchImpl,
  });
}

test("a listed alias is healthy through a live member that has not reported admission", async () => {
  const r = await probeFor(
    "qwen3.8-text",
    listing(),
    admission({ [V27]: { active: 6, queued: 0, active_limit: 128 } }),
  ).probe();
  assert.equal(r.healthy, true);
  assert.equal(r.authoritative, true);
  assert.match(r.reason ?? "", new RegExp(W3));
});

test("a derived prefix alias the gateway does not list is resolved, not 'not served'", async () => {
  const r = await probeFor("qwen3.8-vision", listing()).probe();
  assert.equal(r.healthy, true);
  assert.notEqual(r.model_unlisted, true);
  assert.match(r.reason ?? "", new RegExp(`${V27}|${FLASH}`));
});

test("an alias with no live member is unhealthy and says so", async () => {
  const dead = listing({ [W3]: { slots: 0 } });
  const r = await probeFor("qwen3.8-text", dead).probe();
  assert.equal(r.healthy, false);
  assert.equal(r.authoritative, true);
  assert.match(r.reason ?? "", /no live member/);
});

test("an alias whose live members are all saturated is unhealthy; one open member is enough", async () => {
  const full = admission({
    [V27]: { active: 128, queued: 0, active_limit: 128 },
    [FLASH]: { active: 0, queued: 9, active_limit: 4 },
  });
  const blocked = await probeFor("qwen3.8-vision", listing(), full).probe();
  assert.equal(blocked.healthy, false);
  assert.match(blocked.reason ?? "", /admission limit/);

  const oneOpen = admission({
    [V27]: { active: 128, queued: 0, active_limit: 128 },
    [FLASH]: { active: 1, queued: 0, active_limit: 4 },
  });
  const ok = await probeFor("qwen3.8-vision", listing(), oneOpen).probe();
  assert.equal(ok.healthy, true);
  assert.match(ok.reason ?? "", new RegExp(FLASH));
});

test("an unreadable admission report does not block an alias whose members are live", async () => {
  const r = await probeFor("qwen3.8-vision", listing(), undefined).probe();
  assert.equal(r.healthy, true);
});

test("a name that is neither listed nor an alias is still 'not served'", async () => {
  const r = await probeFor("no-such-model", listing()).probe();
  assert.equal(r.healthy, false);
  assert.equal(r.model_unlisted, true);
});

test("a concrete id is judged as before", async () => {
  const r = await probeFor(
    V27,
    listing(),
    admission({ [V27]: { active: 6, queued: 0, active_limit: 128, capacity_known: true } }),
  ).probe();
  // Same path as ever: a concrete row goes through the model-level admission read.
  assert.ok(typeof r.healthy === "boolean");
  assert.notEqual(r.reason?.startsWith("alias "), true);
});
