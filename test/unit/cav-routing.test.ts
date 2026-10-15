import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  type CavRoute,
  DEFAULT_EXCLUDE,
  assertReviewerDistinct,
  assertVisionCapable,
  isBlocked,
  routeRole,
} from "../../src/cav/routing.ts";
import type { GatewayModelEntry } from "../../src/models/gatewayCatalog.ts";

function entry(id: string, family: string, capabilities: string[], extra: Partial<GatewayModelEntry> = {}) {
  return {
    id,
    contextWindow: 131_072,
    family,
    capabilities,
    tools: true,
    state: "warm",
    ...extra,
  } as GatewayModelEntry;
}

const CATALOG: GatewayModelEntry[] = [
  entry("alpha-coder", "alpha", ["tool_use", "coding.implementation", "coding.review", "coding.planning"]),
  entry("beta-reviewer", "beta", ["tool_use", "coding.implementation", "coding.review"]),
  entry("gamma-planner", "gamma", ["tool_use", "coding.planning"]),
  entry("delta-eyes", "delta", ["tool_use", "vision"]),
];

function route(role: Parameters<typeof routeRole>[0], extra: Parameters<typeof routeRole>[2] = {}): CavRoute {
  const r = routeRole(role, CATALOG, extra);
  assert.ok(!isBlocked(r), isBlocked(r) ? r.reason : "");
  return r as CavRoute;
}

test("every role picks an id that is in the catalog and holds the role capability", () => {
  const ids = new Set(CATALOG.map((e) => e.id));
  for (const role of ["implementer", "planner", "vision"] as const) assert.ok(ids.has(route(role).id), role);
  const impl = route("implementer");
  assert.ok(ids.has(route("reviewer", { implementerFamily: impl.family }).id));
  assert.ok(CATALOG.find((e) => e.id === route("planner").id)?.capabilities?.includes("coding.planning"));
  assert.ok(CATALOG.find((e) => e.id === route("vision").id)?.capabilities?.includes("vision"));
});

test("the reviewer route has a different family from the implementer route", () => {
  const impl = route("implementer");
  const reviewer = route("reviewer", { implementerFamily: impl.family });
  assert.ok(impl.family && reviewer.family);
  assert.notEqual(reviewer.family, impl.family);
  assert.equal(assertReviewerDistinct(impl.id, reviewer.id) || impl.family !== reviewer.family, true);
});

test("a reviewer whose family cannot be established as different is BLOCKED, never defaulted", () => {
  const sameOnly = [entry("only-a", "alpha", ["tool_use", "coding.implementation", "coding.review"])];
  const r = routeRole("reviewer", sameOnly, { implementerFamily: "alpha" });
  assert.ok(isBlocked(r));
  const unknown = routeRole("reviewer", CATALOG, {});
  assert.ok(isBlocked(unknown), "without the implementer's family independence cannot be shown");
  const noFamily = [entry("fam-less", "x", ["tool_use", "coding.review"], { family: undefined })];
  assert.ok(isBlocked(routeRole("reviewer", noFamily, { implementerFamily: "alpha" })));
});

test("an empty catalog yields a BLOCKED result", () => {
  for (const role of ["implementer", "reviewer", "planner", "vision"] as const) {
    const r = routeRole(role, [], { implementerFamily: "alpha" });
    assert.ok(isBlocked(r), role);
    assert.equal((r as { status: string }).status, "BLOCKED");
    assert.match((r as { reason: string }).reason, /no eligible model/i);
  }
});

test("deepseek-v4.1-flash is excluded by default even when it is the only candidate", () => {
  assert.deepEqual([...DEFAULT_EXCLUDE], ["deepseek-v4.1-flash"]);
  const only = [entry("deepseek-v4.1-flash", "deepseek", ["tool_use", "coding.implementation", "coding.review"])];
  assert.ok(isBlocked(routeRole("implementer", only)));
  // An explicit exclusion list replaces the default.
  const allowed = routeRole("implementer", only, { exclude: [] });
  assert.ok(!isBlocked(allowed));
});

test("models that are not qualified are skipped: no tool calling, too little context, route aliases", () => {
  const catalog = [
    entry("no-tools", "a", ["coding.implementation"], { tools: false }),
    entry("tiny", "b", ["tool_use", "coding.implementation"], { contextWindow: 4096 }),
    entry("route-name", "c", ["tool_use", "coding.implementation"], { alias: true, backingModel: "good" }),
    entry("good", "d", ["tool_use", "coding.implementation"]),
  ];
  assert.equal(route("implementer", {}).id, "alpha-coder");
  const r = routeRole("implementer", catalog);
  assert.ok(!isBlocked(r));
  assert.equal((r as CavRoute).id, "good", "canonical ids only: a route alias is never chosen");
});

test("a model with unknown tool support is not chosen for a tool-using role", () => {
  const unknown = [entry("maybe", "a", ["coding.implementation"], { tools: undefined })];
  assert.ok(isBlocked(routeRole("implementer", unknown)));
});

test("selection is deterministic and prefers a warm model", () => {
  const catalog = [
    entry("zz-cold", "a", ["tool_use", "coding.implementation"], { state: "cold" }),
    entry("aa-warm", "b", ["tool_use", "coding.implementation"], { state: "warm" }),
    entry("bb-warm", "c", ["tool_use", "coding.implementation"], { state: "warm" }),
  ];
  assert.equal((routeRole("implementer", catalog) as CavRoute).id, "aa-warm");
  assert.equal((routeRole("implementer", [...catalog].reverse()) as CavRoute).id, "aa-warm");
});

test("overrides win over the catalog and over the exclusion list, and keep the route shape", () => {
  const r = routeRole("reviewer", CATALOG, { overrides: { reviewer: "deepseek-v4.1-flash" } }) as CavRoute;
  assert.equal(r.id, "deepseek-v4.1-flash");
  assert.equal(r.provider, "metabolomics");
  assert.ok(r.reason.includes("overridden"));
});

test("an override takes its family from the catalog when the model is listed", () => {
  const r = routeRole("implementer", CATALOG, { overrides: { implementer: "gamma-planner" } }) as CavRoute;
  assert.equal(r.family, "gamma");
});

test("src/cav/routing.ts holds no literal model id outside DEFAULT_EXCLUDE", async () => {
  const source = await readFile(join(import.meta.dirname, "../../src/cav/routing.ts"), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/export const DEFAULT_EXCLUDE[^;]*;/s, "");
  assert.doesNotMatch(code, /deepseek-v4|qwen3\.8|["'`][a-z]+[a-z0-9]*-v?\d+(\.\d+)*-[a-z0-9-]+["'`]/);
});

test("reviewer must be distinct from the implementer model", () => {
  assert.equal(assertReviewerDistinct("deepseek-v4-flash", "qwen3.8-27b"), true);
  assert.equal(assertReviewerDistinct("deepseek-v4-flash", "deepseek-v4-flash"), false);
});

test("reviewer must be a different model FAMILY, not merely a different id (#152)", () => {
  assert.equal(assertReviewerDistinct("qwen3.8-27b", "qwen3.8-flash-next"), false);
  assert.equal(assertReviewerDistinct("deepseek-v4-flash", "deepseek-v4-pro"), false);
  assert.equal(assertReviewerDistinct("deepseek-v4-flash", "qwen3.8-27b"), true);
  assert.equal(assertReviewerDistinct("qwen3.8-27b", ""), false, "an unknown family is never independent");
});

test("vision role must use a vision-capable model", () => {
  assert.equal(assertVisionCapable("vision", "qwen3.8-27b-vision"), true);
  assert.equal(assertVisionCapable("vision", "qwen3.8-27b"), false);
  assert.equal(assertVisionCapable("reviewer", "qwen3.8-27b"), true);
});
