import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { loadPolicy } from "../../src/lifecycle/policy.ts";
import { loadValidatedQuotaFallbacks, validateQuotaFallbacks } from "../../src/runtime/quotaFallbackConfig.ts";
import { exampleBlock } from "../support/quotaExample.ts";

const registry = [
  { provider: "gw", id: "a" },
  { provider: "gw", id: "b" },
  { provider: "gw", id: "c" },
];

describe("validateQuotaFallbacks", () => {
  it("accepts a valid block, resolving plain ids and provider/id, keeping order", () => {
    const v = validateQuotaFallbacks({ roles: { implementer: ["gw/b", "c"] }, default: ["a"] }, { registry });
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.config, { roles: { implementer: ["gw/b", "c"] }, default: ["a"] });
  });

  it("a missing block is valid and means none configured", () => {
    for (const raw of [undefined, null]) {
      const v = validateQuotaFallbacks(raw, { registry });
      assert.deepEqual(v.errors, []);
      assert.deepEqual(v.config, { roles: {}, default: [] });
    }
  });

  const bad: Array<[string, unknown, RegExp, { rolePins?: Record<string, string> }?]> = [
    ["unknown id", { default: ["gw/nope"] }, /gw\/nope is not in the model registry/],
    ["duplicate within a list", { default: ["gw/a", "gw/a"] }, /duplicate model id gw\/a/],
    ["non-string entry", { roles: { r: ["gw/a", 7] } }, /expected a non-empty string/],
    ["empty string entry", { default: [""] }, /expected a non-empty string/],
    ["list is not a list", { default: "gw/a" }, /expected a list of model ids/],
    ["roles is not a mapping", { roles: ["gw/a"] }, /roles: expected a mapping/],
    ["block is not a mapping", ["gw/a"], /must be a mapping/],
    ["unknown key", { role: { r: ["gw/a"] } }, /unknown key/],
    [
      "only the role's own pinned model",
      { roles: { implementer: ["a"] } },
      /only the role's own pinned model/,
      { rolePins: { implementer: "gw/a" } },
    ],
  ];
  for (const [name, raw, re, extra] of bad) {
    it(`rejects: ${name}`, () => {
      const v = validateQuotaFallbacks(raw, { registry, ...extra });
      assert.match(v.errors.join("\n"), re);
      assert.deepEqual(v.config, { roles: {}, default: [] }, "fail-closed: nothing is trusted");
    });
  }

  it("one bad list poisons the whole block", () => {
    const v = validateQuotaFallbacks({ roles: { ok: ["gw/a"], bad: ["gw/zzz"] } }, { registry });
    assert.equal(v.errors.length, 1);
    assert.deepEqual(v.config.roles, {});
  });

  it("without a registry ids are unchecked (warning), shape is still checked", () => {
    const v = validateQuotaFallbacks({ default: ["anything/at-all"] }, { registry: null });
    assert.deepEqual(v.errors, []);
    assert.match(v.warnings.join("\n"), /registry unavailable/);
    assert.deepEqual(v.config.default, ["anything/at-all"]);
    assert.match(validateQuotaFallbacks({ default: [1] }, { registry: [] }).errors.join(), /non-empty string/);
  });

  it("warns on an empty list, an empty block, and the role's own model among others", () => {
    assert.match(validateQuotaFallbacks({ roles: { r: [] } }, { registry }).warnings.join("\n"), /empty list/);
    assert.match(validateQuotaFallbacks({}, { registry }).warnings.join("\n"), /lists no models/);
    const v = validateQuotaFallbacks({ roles: { r: ["gw/a", "gw/b"] } }, { registry, rolePins: { r: "gw/a" } });
    assert.deepEqual(v.errors, []);
    assert.match(v.warnings.join("\n"), /includes the role's own pinned model/);
  });
});

describe("pi-engineering doctor", () => {
  it("reports a Quota fallbacks check: FAIL on errors (exit 2), OK on a valid block", async () => {
    const { runDoctor, doctorExitCode } = await import("../../src/runtime/isolation/doctor.ts");
    const dir = await mkdtemp(join(tmpdir(), "qf-doc-"));
    const state = await mkdtemp(join(tmpdir(), "qf-state-"));
    const env = { ...process.env, PI_ENGINEERING_STATE_DIR: state } as NodeJS.ProcessEnv;
    try {
      await writeFile(join(dir, "engineering.yaml"), "quota_fallbacks:\n  default: [gw/a, gw/a]\n");
      const bad = await runDoctor({ cwd: dir, env, agentDir: dir });
      const check = bad.checks.find((c) => c.name === "Quota fallbacks");
      assert.equal(check?.status, "fail");
      assert.match(check?.detail ?? "", /duplicate/);
      assert.equal(doctorExitCode(bad), 2);
      await writeFile(join(dir, "engineering.yaml"), "quota_fallbacks:\n  default: [gw/a]\n");
      const good = await runDoctor({ cwd: dir, env, agentDir: dir });
      assert.equal(good.checks.find((c) => c.name === "Quota fallbacks")?.status, "ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });
});

describe("loadValidatedQuotaFallbacks", () => {
  it("reads the global engineering.yaml; unreadable YAML is an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qf-"));
    try {
      await writeFile(join(dir, "engineering.yaml"), "quota_fallbacks:\n  default: [gw/a]\n");
      assert.deepEqual((await loadValidatedQuotaFallbacks(dir, { registry })).config.default, ["gw/a"]);
      await writeFile(join(dir, "engineering.yaml"), "quota_fallbacks: [unclosed\n");
      assert.equal((await loadValidatedQuotaFallbacks(dir, { registry })).errors.length, 1);
      await rm(join(dir, "engineering.yaml"));
      assert.deepEqual((await loadValidatedQuotaFallbacks(dir, { registry })).errors, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the repo's example quota_fallbacks block", () => {
  it("parses uncommented, validates against a registry with its ids, and uses ids the repo policy already names", async () => {
    const parsed = parseYaml(exampleBlock()) as { quota_fallbacks: unknown };
    const ids = (() => {
      const q = parsed.quota_fallbacks as { roles: Record<string, string[]>; default: string[] };
      return [...Object.values(q.roles).flat(), ...q.default];
    })();
    assert.ok(ids.length >= 4);
    const reg = ids.map((id) => ({ provider: id.split("/")[0] as string, id: id.split("/")[1] as string }));
    const { policy } = await loadPolicy({ cwd: process.cwd(), agentDir: await mkdtemp(join(tmpdir(), "qf-agent-")) });
    const pins = Object.fromEntries(Object.entries(policy.routing.roles).map(([r, c]) => [r, c?.model]));
    const v = validateQuotaFallbacks(parsed.quota_fallbacks, { registry: reg, rolePins: pins });
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.warnings, []);
    const named = new Set(
      Object.values(policy.routing.roles).flatMap((c) => [c?.model, c?.fallback_model].filter(Boolean)),
    );
    for (const id of ids) assert.ok(named.has(id), `${id} is a model the repo policy already routes to`);
    // the example never lists a role's own pin
    for (const [role, list] of Object.entries(v.config.roles)) assert.ok(!list.includes(pins[role] as string), role);
  });
});
