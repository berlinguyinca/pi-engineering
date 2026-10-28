import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { test } from "node:test";

for (const empty of [false, true]) {
  test(`the test preload isolates ${empty ? "empty" : "missing"} Pi profile locations from the real user profile`, () => {
    const env = { ...process.env };
    delete env.PI_CODING_AGENT_DIR;
    delete env.PI_AGENT_DIR;
    if (empty) {
      env.PI_CODING_AGENT_DIR = "";
      env.PI_AGENT_DIR = "";
    }
    const preload = new URL("../support/isolatedState.ts", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(preload)}); console.log(JSON.stringify({ coding: process.env.PI_CODING_AGENT_DIR, models: process.env.PI_AGENT_DIR }));`,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const paths = JSON.parse(child.stdout.trim());
    assert.equal(typeof paths.coding, "string");
    assert.ok(paths.coding.startsWith(`${tmpdir()}/pi-eng-test-profile-`));
    assert.equal(paths.models, paths.coding);
  });
}

for (const overrides of [
  {
    coding: "/explicit-coding-profile",
    models: "/explicit-model-profile",
    want: { coding: "/explicit-coding-profile", models: "/explicit-model-profile" },
  },
  {
    coding: "/explicit-coding-profile",
    models: "",
    want: { coding: "/explicit-coding-profile", models: "/explicit-coding-profile" },
  },
  {
    coding: "",
    models: "/explicit-model-profile",
    want: { coding: "/explicit-model-profile", models: "/explicit-model-profile" },
  },
]) {
  test(`the test preload preserves explicit profiles ${JSON.stringify(overrides)}`, () => {
    const preload = new URL("../support/isolatedState.ts", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(preload)}); console.log(JSON.stringify({ coding: process.env.PI_CODING_AGENT_DIR, models: process.env.PI_AGENT_DIR }));`,
      ],
      {
        env: { ...process.env, PI_CODING_AGENT_DIR: overrides.coding, PI_AGENT_DIR: overrides.models },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), overrides.want);
  });
}
