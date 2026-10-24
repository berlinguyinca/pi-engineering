import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type HostFacts,
  binaryRefusal,
  canaryBucket,
  parsePiRuntimeConfig,
  requestedRuntime,
  selectPiRuntime,
  unsupportedHostReason,
  verifyRuntimeBinary,
} from "../../src/runtime/piRuntime.ts";

const linux: HostFacts = { platform: "linux", arch: "x64", libc: "glibc", avx2: true };

function fakeBinary(): { dir: string; path: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-runtime-"));
  const path = join(dir, "pi");
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  // sha256 of the content above
  return { dir, path, sha: "" };
}

test("empty or invalid config means standard Pi", () => {
  for (const raw of [undefined, null, "x", 3, [], {}]) {
    const c = parsePiRuntimeConfig(raw);
    assert.equal(c.default, "standard-pi");
    assert.equal(selectPiRuntime(c, {}, linux).runtime, "standard-pi");
  }
  const bad = parsePiRuntimeConfig({
    default: "turbo",
    roles: { a: "nope" },
    canary: { runtime: "pi-bolt", percent: 500 },
  });
  assert.equal(bad.default, "standard-pi");
  assert.deepEqual(bad.roles, {});
  assert.equal(bad.canary, null);
  assert.equal(bad.issues.length, 3);
});

test("relative binary paths and standard-pi binaries are rejected", () => {
  const c = parsePiRuntimeConfig({ binaries: { "pi-bolt": { path: "bin/pi" }, "standard-pi": { path: "/x" } } });
  assert.deepEqual(c.binaries, {});
  assert.equal(c.issues.length, 2);
});

test("precedence: role > mission > canary > default", () => {
  const c = parsePiRuntimeConfig({
    default: "standard-pi",
    roles: { reviewer: "pi-bolt" },
    missions: { m1: "pi-bolt-jit" },
    canary: { runtime: "pi-bolt", percent: 100 },
  });
  assert.deepEqual(requestedRuntime(c, { role: "reviewer", missionId: "m1", agentId: "a" }), {
    runtime: "pi-bolt",
    source: "role",
  });
  assert.deepEqual(requestedRuntime(c, { role: "planner", missionId: "m1", agentId: "a" }), {
    runtime: "pi-bolt-jit",
    source: "mission",
  });
  assert.deepEqual(requestedRuntime(c, { role: "planner", agentId: "a" }), { runtime: "pi-bolt", source: "canary" });
  assert.deepEqual(requestedRuntime(c, {}), { runtime: "standard-pi", source: "default" });
});

test("canary is deterministic and respects the percentage", () => {
  assert.equal(canaryBucket("pane-1"), canaryBucket("pane-1"));
  const ids = Array.from({ length: 2000 }, (_, i) => `agent-${i}`);
  const in10 = ids.filter((id) => canaryBucket(id) < 10).length;
  assert.ok(in10 > 120 && in10 < 280, `expected ~200 of 2000 in a 10% canary, got ${in10}`);
  const zero = parsePiRuntimeConfig({ canary: { runtime: "pi-bolt", percent: 0 } });
  assert.ok(ids.every((id) => requestedRuntime(zero, { agentId: id }).runtime === "standard-pi"));
  const without = parsePiRuntimeConfig({ canary: { runtime: "pi-bolt", percent: 100 } });
  assert.equal(requestedRuntime(without, {}).runtime, "standard-pi", "no agent id means never in the canary");
});

test("unsupported hosts stay on standard Pi", () => {
  assert.equal(unsupportedHostReason(linux), null);
  assert.equal(unsupportedHostReason({ platform: "darwin", arch: "arm64", libc: "n/a", avx2: false }), null);
  assert.match(
    unsupportedHostReason({ platform: "darwin", arch: "x64", libc: "n/a", avx2: false }) ?? "",
    /Apple silicon/,
  );
  assert.match(unsupportedHostReason({ ...linux, libc: "musl" }) ?? "", /musl/);
  assert.match(unsupportedHostReason({ ...linux, avx2: false }) ?? "", /AVX2/);
  assert.match(unsupportedHostReason({ ...linux, arch: "riscv64" }) ?? "", /not supported/);
  assert.match(
    unsupportedHostReason({ platform: "win32", arch: "x64", libc: "n/a", avx2: false }) ?? "",
    /not supported/,
  );
});

test("verified binary is selected; every defect falls back with a reason", async () => {
  const b = fakeBinary();
  try {
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    const sha = createHash("sha256").update(readFileSync(b.path)).digest("hex");
    const cfg = parsePiRuntimeConfig({
      default: "pi-bolt",
      binaries: { "pi-bolt": { path: b.path, version: "1.0.0" } },
    });

    const noStamp = selectPiRuntime(cfg, {}, linux);
    assert.equal(noStamp.runtime, "standard-pi");
    assert.equal(noStamp.requested, "pi-bolt");
    assert.match(noStamp.fallbackReason ?? "", /no verification stamp/);

    await assert.rejects(verifyRuntimeBinary(b.path, "0".repeat(64), "1.0.0"), /sha256 mismatch/);
    await verifyRuntimeBinary(b.path, sha, "1.0.0");
    const ok = selectPiRuntime(cfg, {}, linux);
    assert.equal(ok.runtime, "pi-bolt");
    assert.equal(ok.binary, b.path);
    assert.equal(ok.fallbackReason, null);

    const pinned = parsePiRuntimeConfig({
      default: "pi-bolt",
      binaries: { "pi-bolt": { path: b.path, version: "2.0.0" } },
    });
    assert.match(selectPiRuntime(pinned, {}, linux).fallbackReason ?? "", /differs from pinned/);

    assert.match(selectPiRuntime(cfg, {}, { ...linux, libc: "musl" }).fallbackReason ?? "", /musl/);
    assert.match(
      selectPiRuntime(parsePiRuntimeConfig({ default: "pi-bolt-jit" }), {}, linux).fallbackReason ?? "",
      /no pi_runtime.binaries/,
    );

    // tampering: rewriting the file changes the fingerprint
    writeFileSync(b.path, "#!/bin/sh\necho evil\n");
    utimesSync(b.path, new Date(), new Date(Date.now() + 5000));
    assert.equal(binaryRefusal(b.path), "binary changed since it was verified");
    assert.equal(selectPiRuntime(cfg, {}, linux).runtime, "standard-pi");

    chmodSync(b.path, 0o644);
    assert.match(binaryRefusal(b.path) ?? "", /not executable/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("runtimeFacts tags the agent from the launcher env and defaults to standard Pi", async () => {
  const { runtimeFacts } = await import("../../src/runtime/piRuntime.ts");
  const proc = {
    versions: { node: "22.1.0", bun: "1.4.3" },
    cpuUsage: () => ({ user: 1_500_000, system: 500_000 }),
    memoryUsage: () => ({ rss: 52_428_800 }),
  };
  const bolt = runtimeFacts({ PI_RUNTIME_KIND: "pi-bolt", PI_RUNTIME_SOURCE: "role" }, proc);
  assert.deepEqual(bolt, {
    runtime_kind: "pi-bolt",
    runtime_source: "role",
    js_engine: "bun",
    js_engine_version: "1.4.3",
    cpu_s: 2,
    rss_mib: 50,
  });
  const std = runtimeFacts({ PI_RUNTIME_KIND: "garbage" }, { ...proc, versions: { node: "22.1.0" } });
  assert.equal(std.runtime_kind, "standard-pi");
  assert.equal(std.runtime_source, "default");
  assert.equal(std.js_engine, "node");
});
