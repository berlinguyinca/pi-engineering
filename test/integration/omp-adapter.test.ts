import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OMP_PIN_MANIFEST, UnavailableReason, negotiateOmp, negotiateOmpFromEnv } from "../../src/omp/index.ts";

// Real-process tests. No fake RPC server: fallback cases use a missing path and real
// processes that exit or hang; handshake cases need a REAL omp via OMP_BIN (+ OMP_BIN_ARGS).
// OMP_BIN=/path/to/bun OMP_BIN_ARGS=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts

test("omp adapter: binary absent yields Unavailable{binary_absent}", async () => {
  const result = await negotiateOmp({ launch: { command: "/nonexistent/path/omp", args: [] }, timeoutMs: 5_000 });
  assert.equal(result.kind, "unavailable");
  assert.equal(result.kind === "unavailable" && result.reason, UnavailableReason.BinaryAbsent);
});

test("omp adapter: process that never answers yields Unavailable{timeout} and is reaped", async () => {
  const started = Date.now();
  const result = await negotiateOmp({ launch: { command: "/bin/sh", args: ["-c", "sleep 60", "sh"] }, timeoutMs: 400 });
  assert.equal(result.kind === "unavailable" && result.reason, UnavailableReason.Timeout);
  assert.ok(Date.now() - started < 10_000, "must not wait for the hung process");
});

test("omp adapter: timeout reaps the whole process tree (non-exec'd grandchild)", async () => {
  // `; true` stops sh from exec'ing sleep, so sleep is a real grandchild holding the stdio pipes.
  const started = Date.now();
  const result = await negotiateOmp({
    launch: { command: "/bin/sh", args: ["-c", "sleep 61.37; true", "sh"] },
    timeoutMs: 400,
  });
  assert.equal(result.kind === "unavailable" && result.reason, UnavailableReason.Timeout);
  assert.ok(Date.now() - started < 10_000, "must not wait for the grandchild's pipes");
  let survivors = "";
  try {
    survivors = execFileSync("pgrep", ["-f", "sleep 61.37"], { encoding: "utf8" }).trim();
  } catch {
    // pgrep exits 1 when nothing matches: that is the success case.
  }
  assert.equal(survivors, "", `grandchild sleep survived: ${survivors}`);
});

test("omp adapter: process that crashes yields Unavailable{crashed} with stderr", async () => {
  const result = await negotiateOmp({
    launch: { command: "/bin/sh", args: ["-c", "echo boom >&2; exit 3", "sh"] },
    timeoutMs: 5_000,
  });
  assert.equal(result.kind === "unavailable" && result.reason, UnavailableReason.Crashed);
  assert.match(result.kind === "unavailable" ? result.detail : "", /code=3.*boom/);
});

test("omp adapter: non-omp --version output yields Unavailable{version_unreadable}", async () => {
  const result = await negotiateOmp({ launch: { command: "/bin/echo", args: ["hello"] }, timeoutMs: 5_000 });
  assert.equal(result.kind === "unavailable" && result.reason, UnavailableReason.VersionUnreadable);
});

test("omp adapter: oversized --version output is cut off with version_unreadable", async () => {
  const result = await negotiateOmp({
    launch: { command: "/bin/sh", args: ["-c", "yes omp/18.20.0 | head -c 5000000", "sh"] },
    timeoutMs: 10_000,
  });
  assert.equal(result.kind === "unavailable" && result.reason, UnavailableReason.VersionUnreadable);
  assert.match(result.kind === "unavailable" ? result.detail : "", /exceeds 4096/);
});

test("omp adapter: pre-release omp version is refused with version_mismatch", async () => {
  const result = await negotiateOmp({ launch: { command: "/bin/echo", args: ["omp/18.20.0-rc.1"] }, timeoutMs: 5_000 });
  assert.equal(result.kind === "unavailable" && result.reason, UnavailableReason.VersionMismatch);
});

test("omp adapter: oversized unterminated frame line yields malformed_frame", async () => {
  // Real process: answers --version correctly, then streams 3 MiB with no newline on the RPC invocation.
  const script =
    'if [ "$1" = "--version" ]; then echo omp/18.20.0; else head -c 3145728 /dev/zero | tr "\\0" "a"; sleep 30; fi';
  const result = await negotiateOmp({ launch: { command: "/bin/sh", args: ["-c", script, "sh"] }, timeoutMs: 15_000 });
  assert.equal(result.kind === "unavailable" && result.reason, UnavailableReason.MalformedFrame);
  assert.match(result.kind === "unavailable" ? result.detail : "", /exceeds 1048576/);
});

test("omp adapter: enabled flag with absent binary falls back, never throws", async () => {
  const result = await negotiateOmpFromEnv({
    PI_ENGINEERING_OMP_ADAPTER: "1",
    PI_ENGINEERING_OMP_BIN: "/nonexistent/path/omp",
  });
  assert.equal(result.kind === "unavailable" && result.reason, UnavailableReason.BinaryAbsent);
});

const ompBin = process.env.OMP_BIN;
const skipReason = ompBin ? false : "UNVERIFIED: OMP_BIN not set; no real omp available to negotiate with";

function realOmp() {
  assert.ok(ompBin);
  const home = mkdtempSync(join(tmpdir(), "omp-home-"));
  return {
    launch: { command: ompBin, args: (process.env.OMP_BIN_ARGS ?? "").split(/\s+/).filter(Boolean) },
    // Dummy key only satisfies omp's startup model check; the handshake sends no prompt, so no model call occurs.
    env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: "sk-dummy-not-used" },
    cwd: home,
    timeoutMs: 60_000,
  };
}

test("omp adapter: real omp negotiates protocol v2 and reports capabilities", { skip: skipReason }, async () => {
  const result = await negotiateOmp(realOmp());
  assert.equal(result.kind, "available", JSON.stringify(result));
  if (result.kind !== "available") return;
  assert.equal(result.report.ompVersion, "18.20.0");
  assert.equal(result.report.negotiatedProtocol, 2);
  assert.deepEqual(result.report.supportedProtocolVersions, [1, 2]);
  assert.equal(result.report.maxFrameBytes, 1048576);
  assert.equal(result.report.chunkedFrames, true);
  assert.equal(result.report.bashExcludeFromContext, true);
});

test("omp adapter: real omp outside pinned range is refused with version_mismatch", { skip: skipReason }, async () => {
  const manifest = {
    ...OMP_PIN_MANIFEST,
    minVersion: { major: 99, minor: 0, patch: 0 },
    maxVersionExclusive: { major: 100, minor: 0, patch: 0 },
  };
  const result = await negotiateOmp({ ...realOmp(), manifest });
  assert.equal(result.kind === "unavailable" && result.reason, UnavailableReason.VersionMismatch);
});

test(
  "omp adapter: real omp with no shared protocol is refused with protocol_mismatch",
  { skip: skipReason },
  async () => {
    const result = await negotiateOmp({
      ...realOmp(),
      manifest: { ...OMP_PIN_MANIFEST, acceptedProtocolVersions: [] },
    });
    assert.equal(result.kind === "unavailable" && result.reason, UnavailableReason.ProtocolMismatch);
  },
);
