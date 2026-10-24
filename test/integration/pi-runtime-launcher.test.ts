import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyRuntimeBinary } from "../../src/runtime/piRuntime.ts";

const launcher = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/pi-session-auto-resume.ts");

function setup(exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-launch-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const cli = join(root, "standard-cli.mjs");
  writeFileSync(cli, 'console.log("RAN standard " + process.argv.slice(2).join(" "));\n');
  const bin = join(root, "bolt");
  writeFileSync(bin, `#!/bin/sh\necho "RAN bolt $PI_RUNTIME_KIND/$PI_RUNTIME_SOURCE $*"\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return { root, agentDir, cli, bin };
}

function run(s: ReturnType<typeof setup>, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [launcher, s.cli, "--flag", "x"], {
    cwd: s.root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: s.root, PI_CODING_AGENT_DIR: s.agentDir, ...extraEnv },
    timeout: 60_000,
  });
}

const yaml = (bin: string, extra = "") =>
  `pi_runtime:\n  default: pi-bolt\n  binaries:\n    pi-bolt: { path: ${bin}, version: "1.0.0" }\n${extra}`;

test("no pi_runtime config: standard Pi runs and no selection is logged", () => {
  const s = setup();
  try {
    const r = run(s);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RAN standard --flag x/);
    assert.throws(() => readFileSync(join(s.agentDir, "runtime-selection.jsonl")));
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("verified binary runs with the same argv, tagged env, and its exit code is propagated without replay", async () => {
  const s = setup(7);
  try {
    const sha = createHash("sha256").update(readFileSync(s.bin)).digest("hex");
    await verifyRuntimeBinary(s.bin, sha, "1.0.0");
    writeFileSync(join(s.agentDir, "engineering.yaml"), yaml(s.bin));
    const r = run(s);
    assert.equal(r.status, 7, "child exit code must propagate");
    assert.match(r.stdout, /RAN bolt pi-bolt\/default --flag x/);
    assert.doesNotMatch(r.stdout, /RAN standard/, "a started runtime is never replayed on standard Pi");
    const log = readFileSync(join(s.agentDir, "runtime-selection.jsonl"), "utf8").trim().split("\n");
    assert.equal(log.length, 1);
    assert.equal(JSON.parse(log[0] as string).runtime, "pi-bolt");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("unverified binary falls back to standard Pi before start, with a logged reason", () => {
  const s = setup();
  try {
    writeFileSync(join(s.agentDir, "engineering.yaml"), yaml(s.bin));
    const r = run(s);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RAN standard --flag x/);
    assert.doesNotMatch(r.stdout, /RAN bolt/);
    assert.match(r.stderr, /pi-bolt unavailable, using standard Pi: .*no verification stamp/);
    const entry = JSON.parse(readFileSync(join(s.agentDir, "runtime-selection.jsonl"), "utf8").trim());
    assert.equal(entry.requested, "pi-bolt");
    assert.equal(entry.runtime, "standard-pi");
    assert.match(entry.fallbackReason, /no verification stamp/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("role override from the worker identity beats the default", async () => {
  const s = setup();
  try {
    const sha = createHash("sha256").update(readFileSync(s.bin)).digest("hex");
    await verifyRuntimeBinary(s.bin, sha, "1.0.0");
    writeFileSync(
      join(s.agentDir, "engineering.yaml"),
      `pi_runtime:\n  default: standard-pi\n  roles: { reviewer: pi-bolt }\n  binaries:\n    pi-bolt: { path: ${s.bin}, version: "1.0.0" }\n`,
    );
    assert.match(run(s, { PI_ENGINEERING_ROLE: "reviewer" }).stdout, /RAN bolt pi-bolt\/role/);
    assert.match(run(s, { PI_ENGINEERING_ROLE: "planner" }).stdout, /RAN standard/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a malformed config never blocks Pi", () => {
  const s = setup();
  try {
    writeFileSync(join(s.agentDir, "engineering.yaml"), "pi_runtime: [unclosed\n  : :");
    const r = run(s);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RAN standard/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("workspace layer overrides global key by key", async () => {
  const s = setup();
  try {
    const sha = createHash("sha256").update(readFileSync(s.bin)).digest("hex");
    await verifyRuntimeBinary(s.bin, sha, "1.0.0");
    writeFileSync(join(s.agentDir, "engineering.yaml"), yaml(s.bin));
    mkdirSync(join(s.root, ".pi"));
    writeFileSync(join(s.root, ".pi", "engineering.yaml"), "pi_runtime:\n  default: standard-pi\n");
    const r = run(s);
    assert.match(r.stdout, /RAN standard/, "workspace default wins; the global binary entry is still inherited");
    writeFileSync(join(s.root, ".pi", "engineering.yaml"), "pi_runtime:\n  roles: { reviewer: pi-bolt }\n");
    assert.match(run(s).stdout, /RAN bolt pi-bolt\/default/, "global default kept when workspace only adds roles");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
