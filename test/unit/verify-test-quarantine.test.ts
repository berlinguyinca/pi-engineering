/**
 * Issue #147: a test that stalls twice with the same signature is quarantined,
 * the record survives a restart, and a verification outcome that depends on a
 * quarantined test reports `blocked`, never `passed`.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { VerifyOutcome } from "../../src/verify/Verifier.ts";
import { type QuarantineEvidence, TestQuarantine, stallSignature } from "../../src/verify/testQuarantine.ts";
import type { GroupProcess, ProgressKind } from "../../src/verify/testWatchdog.ts";

function proc(pid: number, ppid: number, command: string): GroupProcess {
  return { pid, ppid, state: "S", started: "Mon Oct 14 10:00:00 2026", command };
}

function evidence(command: string, lastProgressKind: ProgressKind | null = "output"): QuarantineEvidence {
  return {
    pgid: 4242,
    capturedAt: "2026-10-14T10:00:00.000Z",
    processes: [proc(4242, 1, command), proc(4243, 4242, "sleep 600")],
    lastLines: ["ok 1 - first"],
    lastProgressKind,
  };
}

function outcome(failingTests: string[], passed = true): VerifyOutcome {
  return {
    passed,
    failedStage: passed ? null : "test",
    noTargets: false,
    evidence: [],
    stages: [
      {
        stage: { name: "test", command: "npm", args: ["test"], required: true } as never,
        exitCode: passed ? 0 : 1,
        passed,
        summary: {},
        artifactUri: "artifact://x",
        failingTests,
      },
    ],
  };
}

describe("TestQuarantine", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-quarantine-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("one stall leaves the test usable and 2 identical stalls quarantine it", async () => {
    const q = new TestQuarantine(dir);
    assert.equal(await q.recordStall("suite » slow test", evidence("node suite.ts"), "ev-1"), false);
    assert.equal(await q.isQuarantined("suite » slow test"), false);
    assert.equal(await q.recordStall("suite » slow test", evidence("node suite.ts"), "ev-2"), true);
    assert.equal(await q.isQuarantined("suite » slow test"), true);
  });

  it("2 stalls with different signatures do not quarantine", async () => {
    const q = new TestQuarantine(dir);
    await q.recordStall("t", evidence("node suite.ts"), "ev-1");
    assert.equal(await q.recordStall("t", evidence("cargo run"), "ev-2"), false);
    assert.equal(await q.recordStall("t", evidence("node suite.ts", "io"), "ev-3"), false);
    assert.equal(await q.isQuarantined("t"), false);
  });

  it("the signature ignores pids and numbers but not the test, progress kind or top command", () => {
    const a = stallSignature("t", evidence("node /tmp/pi-1234/a.ts"));
    const b = stallSignature("t", { ...evidence("node /tmp/pi-9876/a.ts"), pgid: 7 });
    assert.equal(a, b);
    assert.notEqual(a, stallSignature("u", evidence("node /tmp/pi-1234/a.ts")));
    assert.notEqual(a, stallSignature("t", evidence("node /tmp/pi-1234/a.ts", "io")));
    assert.notEqual(a, stallSignature("t", evidence("cargo run")));
  });

  it("the quarantine record persists across a restart with its evidence refs and firstSeen", async () => {
    const first = new TestQuarantine(dir);
    await first.recordStall("t", evidence("node suite.ts"), "ev-1");
    await first.recordStall("t", evidence("node suite.ts"), "ev-2");
    const second = new TestQuarantine(dir);
    assert.equal(await second.isQuarantined("t"), true);
    const record = await second.get("t");
    assert.equal(record?.testId, "t");
    assert.deepEqual(record?.evidenceRefs, ["ev-1", "ev-2"]);
    assert.ok(record?.firstSeen);
    assert.equal(record?.signature, stallSignature("t", evidence("node suite.ts")));
  });

  it("a single stall survives a restart and the second identical one quarantines", async () => {
    await new TestQuarantine(dir).recordStall("t", evidence("node suite.ts"), "ev-1");
    assert.equal(await new TestQuarantine(dir).recordStall("t", evidence("node suite.ts"), "ev-2"), true);
  });

  it("applyToOutcome turns an outcome containing a quarantined test into blocked", async () => {
    const q = new TestQuarantine(dir);
    await q.recordStall("t", evidence("node suite.ts"), "ev-1");
    await q.recordStall("t", evidence("node suite.ts"), "ev-2");
    const blocked = await q.applyToOutcome(outcome(["t"], false));
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.passed, false);
    assert.deepEqual(blocked.quarantined, ["t"]);
    assert.match(blocked.warnings?.join("\n") ?? "", /quarantined/);
    // A quarantined test can never leave a green outcome either.
    const wasGreen = await q.applyToOutcome(outcome(["t"], true));
    assert.equal(wasGreen.status, "blocked");
    assert.equal(wasGreen.passed, false);
  });

  it("applyToOutcome leaves an outcome without quarantined tests untouched", async () => {
    const q = new TestQuarantine(dir);
    const clean = outcome([], true);
    assert.equal(await q.applyToOutcome(clean), clean);
  });

  it("writes one record file per test under the state dir and survives garbage files", async () => {
    const q = new TestQuarantine(dir);
    await q.recordStall("t", evidence("node suite.ts"), "ev-1");
    const names = await readdir(join(dir, "quarantine"));
    assert.ok(names.some((n) => n.endsWith(".json")));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "quarantine", "res-garbage.json"), "{not json");
    assert.equal(await new TestQuarantine(dir).isQuarantined("t"), false);
  });
});
