import assert from "node:assert/strict";
import { test } from "node:test";
import { describeProviderSync, parseCanonicalProviders, planProviderSync } from "../../src/models/providerSync.ts";
import { parseSyncSource } from "../../src/models/syncSource.ts";

const canonical = (providers: unknown) => parseCanonicalProviders(JSON.stringify({ providers }));

test("a canonical definition that carries a credential is refused", () => {
  for (const key of ["apiKey", "api_key", "headers", "Authorization", "token"]) {
    assert.throws(
      () => canonical({ p: { baseUrl: "https://x.example/v1", [key]: "s" } }),
      /must hold no credential/,
      key,
    );
  }
});

test("a canonical definition needs an http(s) baseUrl and at least one provider", () => {
  assert.throws(() => canonical({ p: { baseUrl: "ftp://x" } }), /baseUrl/);
  assert.throws(() => canonical({}), /no providers/);
  assert.throws(() => parseCanonicalProviders("{"), /not valid JSON/);
});

test("settings are aligned, the host key and unknown keys survive, existing models are kept", () => {
  const current = {
    providers: {
      p: {
        baseUrl: "https://old.example/v1",
        apiKey: "host-key",
        futureKey: { a: 1 },
        models: [{ id: "tested", contextWindow: 1 }],
      },
    },
  };
  const plan = planProviderSync(
    current,
    canonical({ p: { baseUrl: "https://new.example/v1", compat: { x: true }, models: [{ id: "seed" }] } }),
  );
  const p = plan.config.providers?.p as Record<string, unknown>;
  assert.equal(p.baseUrl, "https://new.example/v1");
  assert.deepEqual(p.compat, { x: true });
  assert.equal(p.apiKey, "host-key");
  assert.deepEqual(p.futureKey, { a: 1 });
  assert.deepEqual(p.models, [{ id: "tested", contextWindow: 1 }]);
  assert.deepEqual(plan.entries[0]?.changedKeys, ["baseUrl", "compat"]);
  assert.equal(plan.dirty, true);
  assert.equal(current.providers.p.baseUrl, "https://old.example/v1", "the input is not mutated");
});

test("an empty provider is seeded from the canonical models", () => {
  const plan = planProviderSync(
    { providers: { p: { baseUrl: "https://x.example/v1", apiKey: "k", models: [] } } },
    canonical({ p: { baseUrl: "https://x.example/v1", models: [{ id: "seed" }] } }),
  );
  assert.equal(plan.entries[0]?.seededModels, 1);
  assert.equal((plan.config.providers?.p as { models: unknown[] }).models.length, 1);
});

test("a host without a credential is reported needs-key and left untouched", () => {
  const current = { providers: { other: { baseUrl: "https://o.example/v1", apiKey: "k" } } };
  const plan = planProviderSync(current, canonical({ p: { baseUrl: "https://x.example/v1" } }));
  assert.equal(plan.entries[0]?.state, "needs-key");
  assert.equal(plan.dirty, false);
  assert.equal(plan.config, current);
  assert.match(describeProviderSync(plan, false)[0] ?? "", /needs-key/);
});

test("a credential held outside models.json counts, and an identical host is ok", () => {
  const def = canonical({ p: { baseUrl: "https://x.example/v1" } });
  const fromAuth = planProviderSync({}, def, (id) => id === "p");
  assert.equal(fromAuth.entries[0]?.state, "updated");
  const same = planProviderSync(fromAuth.config, def, () => true);
  assert.equal(same.entries[0]?.state, "ok");
  assert.equal(same.dirty, false);
});

test("sync sources: file, http and ssh parse; hostile ssh forms do not", () => {
  assert.deepEqual(parseSyncSource("https://h.example/c.json"), { kind: "http", url: "https://h.example/c.json" });
  assert.deepEqual(parseSyncSource("ssh://bender/home/me/c.json"), {
    kind: "ssh",
    host: "bender",
    path: "/home/me/c.json",
  });
  assert.deepEqual(parseSyncSource("/etc/c.json"), { kind: "file", path: "/etc/c.json" });
  assert.throws(() => parseSyncSource("ssh://-oProxyCommand=x/p"), /ssh:\/\/host/);
  assert.throws(() => parseSyncSource("ssh://h/p; rm -rf /"), /ssh:\/\/host/);
  assert.throws(() => parseSyncSource("ssh://h"), /ssh:\/\/host/);
  assert.throws(() => parseSyncSource("  "), /empty/);
});
