import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERIFIER_STRIPPED_ENV_KEYS, sanitizeVerifierEnv } from "../../src/verify/childEnv.ts";

const STRIPPED_KEYS = [
  "PI_ENGINEERING_STATE_DIR",
  "PI_ENGINEERING_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_ENGINEERING_CONTROL_DIR",
  "PI_ENGINEERING_POLICY",
  "PI_AUTOSPEC_ENABLED",
  "PI_GATEWAY_MAX_CONCURRENCY",
];

describe("sanitizeVerifierEnv", () => {
  it("strips all listed internal pi-engineering keys", () => {
    const env: NodeJS.ProcessEnv = Object.fromEntries(STRIPPED_KEYS.map((key) => [key, `value-${key}`]));
    const result = sanitizeVerifierEnv(env);

    for (const key of STRIPPED_KEYS) {
      assert.equal(key in result, false, `expected ${key} to be stripped`);
    }
  });

  it("keeps unrelated keys such as PATH and HOME", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/test",
      PI_ENGINEERING_STATE_DIR: "/tmp/leaked",
    };
    const result = sanitizeVerifierEnv(env);

    assert.equal(result.PATH, "/usr/bin:/bin");
    assert.equal(result.HOME, "/home/test");
  });

  it("honours the keep option for otherwise-stripped keys", () => {
    const env: NodeJS.ProcessEnv = {
      PI_ENGINEERING_HOME: "/home/pi",
      PI_ENGINEERING_CONTROL_DIR: "/control",
    };
    const result = sanitizeVerifierEnv(env, {
      keep: ["PI_ENGINEERING_HOME"],
    });

    assert.equal(result.PI_ENGINEERING_HOME, "/home/pi");
    assert.equal("PI_ENGINEERING_CONTROL_DIR" in result, false);
  });

  it("sets the verifier-child marker to '1'", () => {
    const result = sanitizeVerifierEnv({});
    assert.equal(result.PI_ENGINEERING_VERIFIER_CHILD, "1");
  });

  it("does not mutate the input environment", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/bin",
      PI_ENGINEERING_STATE_DIR: "/state",
      PI_CODING_AGENT_DIR: "/agent",
    };
    const snapshot = { ...env };
    sanitizeVerifierEnv(env, { keep: ["PI_ENGINEERING_STATE_DIR"] });

    assert.deepEqual(env, snapshot);
  });

  it("returns a new object, not the input", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin" };
    const result = sanitizeVerifierEnv(env);
    assert.notEqual(result, env);
  });

  it("exposes the stripped keys as a readonly array", () => {
    assert.deepEqual([...VERIFIER_STRIPPED_ENV_KEYS], STRIPPED_KEYS);
    assert.ok(VERIFIER_STRIPPED_ENV_KEYS.includes("PI_ENGINEERING_STATE_DIR"));
  });
});
