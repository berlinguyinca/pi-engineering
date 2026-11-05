/**
 * Membership stated only on the route row.
 *
 * The contract (`docs/specs/planner-worker-inferweave-contract.md` §2) describes
 * `x_backing_model` on a route and `x_aliases` on a concrete model. The deployed
 * gateway (revision `b5f62ec2`, measured 2026-11-02) states membership ONLY on
 * the route row as `x_members`, advertises no `x_aliases` anywhere, and gives a
 * route row no capability or modality metadata at all. A worker that reads only
 * the documented direction sees routes with no parent and concrete models serving
 * nothing, so it cannot re-pick a concrete model when the route in front of it is
 * excluded or its member has gone cold.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCatalog } from "../../src/plannerWorker/gateway.ts";
import { DEFAULT_ROLE_CONFIG, resolveRole } from "../../src/plannerWorker/roles.ts";

const VISION = "qwen3.8-27b-modality-vision-quant-q8_k_xl";
const TEXT = "qwen3.8-flash_next-modality-text-quant-w3a8";

/** `/v1/models` as the deployed gateway served it, trimmed to what matters. */
const LISTING = {
  data: [
    {
      id: VISION,
      ctx_per_request: 262_144,
      x_state: "hot",
      slots: 1,
      x_tools: true,
      x_family: "qwen3.8",
      x_capabilities: ["coding.implementation"],
    },
    {
      id: TEXT,
      ctx_per_request: 131_072,
      x_state: "hot",
      slots: 3,
      x_tools: true,
      x_family: "qwen3.8",
      x_capabilities: ["coding.implementation"],
    },
    // Route rows: membership only, no backing, no capabilities, no modalities.
    { id: "qwen3.8-text", ctx_per_request: 131_072, slots: 3, x_alias: true, x_members: [TEXT] },
    { id: "laya", slots: 202, x_alias: true, x_members: [TEXT, VISION] },
  ],
};

const find = (id: string) => parseCatalog(LISTING).find((model) => model.id === id)!;
const implementer = { capability: "coding.implementation", min_context: 128_000, tools: true };

test("membership on the route row is visible from both sides", () => {
  // The concrete rows advertise no `x_aliases`; the relationship is still known.
  assert.deepEqual(find(TEXT).aliases, ["qwen3.8-text", "laya"]);
  assert.deepEqual(find(VISION).aliases, ["laya"]);
  // One member names a definite backing; several means the gateway chooses per request.
  assert.equal(find("qwen3.8-text").backing, TEXT);
  assert.equal(find("laya").backing, undefined);
  assert.deepEqual(find("laya").members, [TEXT, VISION]);
});

test("a route row with no size of its own inherits its member's window", () => {
  assert.equal(find("laya").contextWindow, 131_072, "bounded by the smallest thing it can reach");
});

test("excluding the route still reaches the concrete model behind it", async () => {
  const config = { ...DEFAULT_ROLE_CONFIG, implementer: { ...implementer, model: "qwen3.8-text" } };
  const result = await resolveRole("implementer", {
    provider: "gw",
    config,
    catalog: parseCatalog(LISTING),
    exclude: ["qwen3.8-text"],
  });
  assert.ok([TEXT, VISION].includes(result?.model.id ?? ""), `expected a member, got ${result?.model.id}`);
  assert.notEqual(result?.model.id, "qwen3.8-text", "the route itself is excluded");
});

test("a role named for a route resolves to a member when the route is not usable", async () => {
  const config = { ...DEFAULT_ROLE_CONFIG, implementer: { ...implementer, model: "laya" } };
  // The route is draining, so the binding has to fall through to what it names.
  const catalog = parseCatalog({
    data: [LISTING.data[0], LISTING.data[1], { ...LISTING.data[3], x_state: "draining" }],
  });
  const result = await resolveRole("implementer", { provider: "gw", config, catalog });
  assert.ok([TEXT, VISION].includes(result?.model.id ?? ""), `expected a member, got ${result?.model.id}`);
  assert.notEqual(result?.model.id, "laya", "a draining route cannot carry the role");
});
