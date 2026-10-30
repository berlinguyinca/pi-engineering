import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SteeringItem } from "../../src/orchestration/steering.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();

const item = (nodeId: string, base: string): SteeringItem => ({
  steeringId: "st-1",
  action: "fork",
  nodeId,
  params: { baseSha: base },
  instruction: null,
  proposedBy: "bob",
  confirmedBy: "alice",
  room: "room-a",
  validUntilEpoch: 9_999_999_999,
  fence: "f",
  expectedDigest: null,
});

describe("EngineeringRuntime forks from a Mission-less session", () => {
  it("resolves a Ledger work item and its session to this checkout and branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fork-rt-"));
    sh(root, "init", "-b", "trunk");
    sh(root, "config", "user.email", "t@example.invalid");
    sh(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "one\n");
    sh(root, "add", ".");
    sh(root, "commit", "-m", "base");
    const base = sh(root, "rev-parse", "HEAD");
    const agentDir = mkdtempSync(join(tmpdir(), "pi-fork-agent-"));
    const stateDir = mkdtempSync(join(tmpdir(), "pi-fork-state-"));
    writeFileSync(join(agentDir, "engineering.yaml"), "forks:\n  enabled: true\n  min_free_mb: 1\n");
    mkdirSync(join(root, ".pi-eng"), { recursive: true });
    const prior = process.env.PI_ENGINEERING_STATE_DIR;
    process.env.PI_ENGINEERING_STATE_DIR = stateDir; // keep forks.json out of the real state directory
    const rt = await EngineeringRuntime.open({
      cwd: root,
      workDir: join(root, ".pi-eng"),
      agentDir,
      worker: new FakeWorkerExecutor({}),
    });
    try {
      assert.ok(rt.forkRuntime, "fork runtime is constructed from the YAML");
      const actor = { type: "system" as const };
      const wi = await rt.ledger.createWorkItem("mission-less goal", "low", [], actor);
      await rt.ledger.emitEvent("agent.started", wi.id, actor, {}, { run_id: "run-1", session_id: "sess-1" });
      for (const node of [`task:${wi.id}`, "agent:sess-1", "attempt:run-1"]) {
        assert.equal(await rt.forkRuntime.port.knows(item(node, base)), true, node);
      }
      const applied = await rt.forkRuntime.port.apply(item("agent:sess-1", base));
      assert.equal(applied.outcome, "applied", applied.note);
      assert.equal(await rt.forkRuntime.port.knows(item("task:unknown", base)), false);
      const recs = Object.values(
        (
          JSON.parse(readFileSync(join(stateDir, "forks.json"), "utf8")) as {
            records: Record<string, Record<string, string>>;
          }
        ).records,
      );
      assert.equal(recs.length, 1);
      assert.equal(recs[0]?.baseBranch, "trunk", "base ref comes from the session's checkout");
      assert.equal(recs[0]?.missionId, wi.id, "the Ledger work item stands in for the Mission");
      assert.equal(recs[0]?.repoRoot, rt.git?.root);
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, "PI_ENGINEERING_STATE_DIR");
      else process.env.PI_ENGINEERING_STATE_DIR = prior;
      await rt.close();
    }
  });
});
