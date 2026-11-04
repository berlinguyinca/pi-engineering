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
    coding: `${tmpdir()}/explicit-coding-profile`,
    models: `${tmpdir()}/explicit-model-profile`,
    want: { coding: `${tmpdir()}/explicit-coding-profile`, models: `${tmpdir()}/explicit-model-profile` },
  },
  {
    coding: `${tmpdir()}/explicit-coding-profile`,
    models: "",
    want: { coding: `${tmpdir()}/explicit-coding-profile`, models: `${tmpdir()}/explicit-coding-profile` },
  },
  {
    coding: "",
    models: `${tmpdir()}/explicit-model-profile`,
    want: { coding: `${tmpdir()}/explicit-model-profile`, models: `${tmpdir()}/explicit-model-profile` },
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

for (const real of [
  { PI_CODING_AGENT_DIR: "/home/someone/.pi/agent", PI_AGENT_DIR: "" },
  { PI_CODING_AGENT_DIR: "", PI_AGENT_DIR: "/home/someone/.pi/agent" },
  { PI_CODING_AGENT_DIR: `${tmpdir()}/ok`, PI_AGENT_DIR: "/home/someone/.pi/agent" },
]) {
  test(`the test preload fails loudly on a profile outside the temp dir ${JSON.stringify(real)}`, () => {
    const preload = new URL("../support/isolatedState.ts", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(preload)});`],
      {
        env: { ...process.env, ...real },
        encoding: "utf8",
      },
    );
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /test isolation/);
  });
}
