import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HINDSIGHT_ENV, hindsightBlackholeOption, resolveHindsightFromEnv } from "../../src/blackhole/envConfig.ts";

const E = HINDSIGHT_ENV;

test("envConfig: absent base URL returns null (backward compatible, nothing enabled)", () => {
  assert.equal(resolveHindsightFromEnv({}), null);
  assert.equal(resolveHindsightFromEnv({ [E.token]: "secret" }), null);
  assert.equal(hindsightBlackholeOption({}), undefined);
});

test("envConfig: base URL enables an hindsight connection with the token", () => {
  const env = { [E.baseUrl]: "https://hindsight.example.com/", [E.token]: "abc123" };
  const cfg = resolveHindsightFromEnv(env);
  assert.ok(cfg);
  assert.equal(cfg!.baseUrl, "https://hindsight.example.com/");
  assert.equal(cfg!.token, "abc123");
  assert.equal(cfg!.project, "pi");
  assert.equal(cfg!.providerTimeoutMs, 10_000);

  const opt = hindsightBlackholeOption(env);
  assert.deepEqual(opt, {
    config: {
      enabled: true,
      durable: { kind: "hindsight", baseUrl: "https://hindsight.example.com/", token: "abc123", project: "pi" },
      providerTimeoutMs: 10_000,
    },
  });
});

test("envConfig: PI_HINDSIGHT_PROJECT selects the bank prefix (blank falls back to pi)", () => {
  const env = { [E.baseUrl]: "https://hindsight.example.com", [E.project]: "lab-1" };
  assert.equal(resolveHindsightFromEnv(env)!.project, "lab-1");
  assert.equal(resolveHindsightFromEnv({ [E.baseUrl]: "https://x", [E.project]: "  " })!.project, "pi");
});

test("envConfig: PI_HINDSIGHT_ENABLED=0/false forces the connection off", () => {
  const base = { [E.baseUrl]: "https://hindsight.example.com" };
  assert.equal(resolveHindsightFromEnv({ ...base, [E.enabled]: "0" }), null);
  assert.equal(resolveHindsightFromEnv({ ...base, [E.enabled]: "false" }), null);
  assert.ok(resolveHindsightFromEnv({ ...base, [E.enabled]: "1" }));
});

test("envConfig: reads the token from a token file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ov-env-"));
  const file = join(dir, "token.txt");
  writeFileSync(file, "  file-token\n");
  const cfg = resolveHindsightFromEnv({ [E.baseUrl]: "https://x", [E.tokenFile]: file });
  assert.equal(cfg!.token, "file-token");
});

test("envConfig: token file missing degrades to no token (fail open to empty recall, not crash)", () => {
  const cfg = resolveHindsightFromEnv({ [E.baseUrl]: "https://x", [E.tokenFile]: "/nonexistent/nope" });
  assert.equal(cfg!.token, undefined);
});

test("envConfig: malformed timeout falls back to the default (fail-closed)", () => {
  assert.equal(
    resolveHindsightFromEnv({ [E.baseUrl]: "https://x", [E.timeout]: "not-a-number" })!.providerTimeoutMs,
    10_000,
  );
  assert.equal(resolveHindsightFromEnv({ [E.baseUrl]: "https://x", [E.timeout]: "0" })!.providerTimeoutMs, 10_000);
  assert.equal(resolveHindsightFromEnv({ [E.baseUrl]: "https://x", [E.timeout]: "500" })!.providerTimeoutMs, 500);
});
