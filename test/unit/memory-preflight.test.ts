import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DOCTOR_CLI,
  type PreflightRunner,
  defaultPreflightRunner,
  formatMemoryPreflight,
  parseDoctorJson,
  runMemoryPreflight,
} from "../../src/blackhole/memoryPreflight.ts";

const HEALTHY_DOCTOR = JSON.stringify({
  ok: false,
  overall: "unknown",
  checks: [
    { name: "config:pi:skill", status: "ok", detail: "managed config valid" },
    { name: "pin", status: "ok", detail: "adapter pin d48b334b6236" },
    { name: "package_revision", status: "ok", detail: "herdr-memory d48b334b6236 matches pin" },
    { name: "client_version", status: "ok", detail: "client 0.1.8" },
    { name: "fleet_update", status: "unknown", detail: "no unattended fleet update has recorded a run" },
    { name: "credential:project:pi-engineering:pi", status: "ok", detail: "0600 file in 0700 parent" },
    { name: "server", status: "ok", detail: "healthy" },
  ],
});

function runnerReturning(stdout: string, exitCode = 0): PreflightRunner {
  return async () => ({ stdout, exitCode });
}

test("parseDoctorJson reads checks, ok and overall from doctor --json", () => {
  const parsed = parseDoctorJson(HEALTHY_DOCTOR);
  assert.ok(parsed);
  assert.equal(parsed.overall, "unknown");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.checks.length, 7);
  const first = parsed.checks[0];
  assert.ok(first);
  assert.equal(first.name, "config:pi:skill");
  assert.equal(first.status, "ok");
});

test("parseDoctorJson normalises any unexpected status to fail", () => {
  const parsed = parseDoctorJson(
    JSON.stringify({ ok: false, overall: "fail", checks: [{ name: "server", status: "error", detail: "down" }] }),
  );
  assert.ok(parsed);
  assert.equal(parsed.checks[0]?.status, "fail");
});

test("parseDoctorJson returns null on non-JSON and on a missing checks array", () => {
  assert.equal(parseDoctorJson("not json"), null);
  assert.equal(parseDoctorJson(JSON.stringify({ ok: true })), null);
  assert.equal(parseDoctorJson(JSON.stringify({ checks: [{ status: "ok" }] })), null); // check with no name
});

test("runMemoryPreflight surfaces doctor's checks when available", async () => {
  const result = await runMemoryPreflight({ harness: "pi", runner: runnerReturning(HEALTHY_DOCTOR) });
  assert.equal(result.available, true);
  assert.ok(result.available && result.checks.some((c) => c.name === "pin"));
});

test("runMemoryPreflight keeps doctor's JSON even on a non-zero exit (failing checks, not unavailable)", async () => {
  const failing = JSON.stringify({
    ok: false,
    overall: "fail",
    checks: [{ name: "server", status: "fail", detail: "unreachable" }],
  });
  const result = await runMemoryPreflight({ harness: "pi", runner: runnerReturning(failing, 1) });
  assert.equal(result.available, true);
  assert.ok(result.available && result.checks[0]?.status === "fail");
});

test("runMemoryPreflight passes --harness only for the four names doctor knows", async () => {
  const seen: string[][] = [];
  const spyRunner: PreflightRunner = async (args) => {
    seen.push(args);
    return { stdout: HEALTHY_DOCTOR, exitCode: 0 };
  };
  await runMemoryPreflight({ harness: "pi", runner: spyRunner });
  await runMemoryPreflight({ harness: "some-custom-harness", runner: spyRunner });
  assert.deepEqual(seen[0], ["memory", "doctor", "--json", "--harness", "pi"]);
  assert.deepEqual(seen[1], ["memory", "doctor", "--json"]);
});

test("runMemoryPreflight is fail-closed on a missing binary (ENOENT -> not-installed)", async () => {
  const enoent: PreflightRunner = async () => {
    throw Object.assign(new Error("spawn herdr-eng ENOENT"), { code: "ENOENT" });
  };
  const result = await runMemoryPreflight({ harness: "pi", runner: enoent });
  assert.equal(result.available, false);
  assert.ok(!result.available && result.code === "not-installed");
});

test("runMemoryPreflight is fail-closed on a timeout and on unreadable output", async () => {
  const timed: PreflightRunner = async () => {
    throw Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" });
  };
  const timeout = await runMemoryPreflight({ harness: "pi", runner: timed });
  assert.ok(!timeout.available && timeout.code === "timeout");

  const garbage = await runMemoryPreflight({ harness: "pi", runner: runnerReturning("<<<not json>>>") });
  assert.ok(!garbage.available && garbage.code === "error");
});

test("formatMemoryPreflight renders one line per check under a summary", () => {
  const parsed = parseDoctorJson(HEALTHY_DOCTOR);
  assert.ok(parsed);
  const lines = formatMemoryPreflight({
    available: true,
    ok: parsed.ok,
    overall: parsed.overall,
    checks: parsed.checks,
  });
  assert.equal(lines[0], "Memory preflight: unknown (7 checks)");
  assert.ok(lines.some((l) => /^ {2}OK\s+pin\s+adapter pin/.test(l)));
  assert.equal(lines.length, 1 + 7);
});

test("formatMemoryPreflight counts failing checks in its summary", () => {
  const lines = formatMemoryPreflight({
    available: true,
    ok: false,
    overall: "fail",
    checks: [
      { name: "pin", status: "ok", detail: "" },
      { name: "server", status: "fail", detail: "unreachable" },
    ],
  });
  assert.equal(lines[0], "Memory preflight: fail (2 checks, 1 failing)");
  assert.ok(lines.some((l) => /^ {2}FAIL\s+server\s+unreachable/.test(l)));
});

test("formatMemoryPreflight renders an unavailable result as one reason line", () => {
  const lines = formatMemoryPreflight({
    available: false,
    code: "not-installed",
    reason: "herdr-eng is not installed on this host",
  });
  assert.deepEqual(lines, ["Memory preflight:", "  UNAVAILABLE  herdr-eng is not installed on this host"]);
});

test("the default runner returns not-installed via ENOENT when herdr-eng is absent from PATH", async () => {
  // Real subprocess: an empty PATH guarantees ENOENT, exercising the production spawn path.
  const savedPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "empty-path-"));
  try {
    const result = await runMemoryPreflight({ harness: "pi", runner: defaultPreflightRunner, timeoutMs: 3000 });
    assert.equal(result.available, false);
    assert.ok(!result.available && result.code === "not-installed");
  } finally {
    process.env.PATH = savedPath;
  }
});

test("the default runner parses JSON from a real herdr-eng stand-in on PATH", async () => {
  // Real subprocess: a shell script named `herdr-eng` on PATH, emitting doctor-shaped JSON.
  const dir = mkdtempSync(join(tmpdir(), "herdr-eng-"));
  const bin = join(dir, DOCTOR_CLI);
  writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${HEALTHY_DOCTOR}\nEOF\n`);
  chmodSync(bin, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath ?? ""}`;
  try {
    const result = await runMemoryPreflight({ harness: "pi", runner: defaultPreflightRunner, timeoutMs: 3000 });
    assert.equal(result.available, true);
    assert.ok(result.available && result.checks.some((c) => c.name === "server"));
  } finally {
    process.env.PATH = savedPath;
  }
});
