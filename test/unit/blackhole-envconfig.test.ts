import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPENVIKING_ENV, openVikingBlackholeOption, resolveOpenVikingFromEnv } from "../../src/blackhole/envConfig.ts";

const E = OPENVIKING_ENV;

test("envConfig: absent base URL returns null (backward compatible, nothing enabled)", () => {
  assert.equal(resolveOpenVikingFromEnv({}), null);
  assert.equal(resolveOpenVikingFromEnv({ [E.token]: "secret" }), null);
  assert.equal(openVikingBlackholeOption({}), undefined);
});

test("envConfig: base URL enables an openviking connection with the token", () => {
  const env = { [E.baseUrl]: "https://viking.metabolomics.us/", [E.token]: "abc123" };
  const cfg = resolveOpenVikingFromEnv(env);
  assert.ok(cfg);
  assert.equal(cfg!.baseUrl, "https://viking.metabolomics.us/");
  assert.equal(cfg!.token, "abc123");
  assert.equal(cfg!.providerTimeoutMs, 10_000);

  const opt = openVikingBlackholeOption(env);
  assert.deepEqual(opt, {
    config: {
      enabled: true,
      durable: { kind: "openviking", baseUrl: "https://viking.metabolomics.us/", token: "abc123" },
      providerTimeoutMs: 10_000,
    },
  });
});

test("envConfig: PI_OPENVIKING_ENABLED=0/false forces the connection off", () => {
  const base = { [E.baseUrl]: "https://viking.metabolomics.us" };
  assert.equal(resolveOpenVikingFromEnv({ ...base, [E.enabled]: "0" }), null);
  assert.equal(resolveOpenVikingFromEnv({ ...base, [E.enabled]: "false" }), null);
  assert.ok(resolveOpenVikingFromEnv({ ...base, [E.enabled]: "1" }));
});

test("envConfig: reads the token from a token file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ov-env-"));
  const file = join(dir, "token.txt");
  writeFileSync(file, "  file-token\n");
  const cfg = resolveOpenVikingFromEnv({ [E.baseUrl]: "https://x", [E.tokenFile]: file });
  assert.equal(cfg!.token, "file-token");
});

test("envConfig: token file missing degrades to no token (fail open to empty recall, not crash)", () => {
  const cfg = resolveOpenVikingFromEnv({ [E.baseUrl]: "https://x", [E.tokenFile]: "/nonexistent/nope" });
  assert.equal(cfg!.token, undefined);
});

test("envConfig: malformed timeout falls back to the default (fail-closed)", () => {
  assert.equal(
    resolveOpenVikingFromEnv({ [E.baseUrl]: "https://x", [E.timeout]: "not-a-number" })!.providerTimeoutMs,
    10_000,
  );
  assert.equal(resolveOpenVikingFromEnv({ [E.baseUrl]: "https://x", [E.timeout]: "0" })!.providerTimeoutMs, 10_000);
  assert.equal(resolveOpenVikingFromEnv({ [E.baseUrl]: "https://x", [E.timeout]: "500" })!.providerTimeoutMs, 500);
});
