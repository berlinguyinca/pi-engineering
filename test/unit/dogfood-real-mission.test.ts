import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { allComplete, buildDogfoodRecord, summariseMission } from "../../src/orchestration/dogfoodRecord.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const exec = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "dogfood-real-mission.ts");

/** Seed a mission with agent + validation executions carrying typed usage. */
function seed(store: MissionStore, missionId: string) {
  store.createMission({
    mission_id: missionId,
    title: "dogfood",
    goal: "g",
    user_request: "g",
    repository: ".",
    base_ref: "HEAD",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
  const task = store.createTask({ mission_id: missionId, kind: "agent", role: "implementer", objective: "o" });
  const usage = [
    { backend: "agent" as const, model: "dogfood/qwen", usage: { input: 1000, output: 200 } },
    { backend: "agent" as const, model: "dogfood/qwen", usage: { promptTokens: 500, completionTokens: 50 } },
    { backend: "validation" as const, model: null, usage: {} },
  ];
  for (const u of usage) {
    const ex = store.createExecution({
      task_id: task.task_id,
      backend: u.backend,
      mission_id: missionId,
      model: u.model,
    });
    store.setExecutionStatus(ex.execution_id, "RUNNING");
    store.setExecutionStatus(ex.execution_id, "SUCCEEDED", { usage: u.usage });
  }
  store.transitionMission(missionId, "CLASSIFYING");
  return task;
}

describe("dogfood real mission record", () => {
  it("summarises a mission replayed from a real event file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dogfood-record-"));
    try {
      const file = join(dir, "orchestration.jsonl");
      const backend = await JsonlEventStore.open(file);
      const writer = MissionStore.open(backend);
      seed(writer, "MSN-d1");
      await writer.flush();
      backend.close();

      const replayBackend = await JsonlEventStore.open(file);
      const replayed = MissionStore.open(replayBackend);
      const summary = summariseMission(replayed, "MSN-d1", {
        goal: "add multiply",
        wallMs: 4321,
        fallbackCandidateSha: "abc123",
      });
      assert.equal(summary.missionId, "MSN-d1");
      assert.equal(summary.goal, "add multiply");
      assert.equal(summary.calls, 2, "only agent executions are model calls");
      assert.equal(summary.inputTokens, 1500);
      assert.equal(summary.outputTokens, 250);
      assert.equal(summary.model, "dogfood/qwen");
      assert.equal(summary.wallMs, 4321);
      assert.equal(summary.candidateSha, "abc123", "falls back when the store holds no candidate");
      assert.equal(summary.status, "CLASSIFYING");
      replayBackend.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown mission", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    assert.throws(() => summariseMission(store, "MSN-nope", { goal: "g", wallMs: 1 }), /unknown mission/);
  });

  it("builds the dogfood_mission document and judges completion", () => {
    const base = {
      goal: "g",
      missionId: "m",
      candidateSha: null,
      wallMs: 1,
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      model: "x",
    };
    const ranAt = new Date("2026-10-15T03:00:00Z");
    const ok = buildDogfoodRecord(
      "deadbeef",
      [
        { ...base, status: "COMPLETE" },
        { ...base, status: "COMPLETE" },
      ],
      ranAt,
    );
    assert.equal(ok.kind, "dogfood_mission");
    assert.equal(ok.sha, "deadbeef");
    assert.equal(ok.ranAt, "2026-10-15T03:00:00.000Z");
    assert.ok(allComplete(ok));
    assert.ok(
      !allComplete(
        buildDogfoodRecord(
          "s",
          [
            { ...base, status: "COMPLETE" },
            { ...base, status: "BLOCKED" },
          ],
          ranAt,
        ),
      ),
    );
    assert.ok(!allComplete(buildDogfoodRecord("s", [], ranAt)));
  });

  it("refuses to run without the gateway env (exit 2, names the missing variables)", async () => {
    const env = { ...process.env };
    for (const k of ["PI_DOGFOOD_GATEWAY_BASE_URL", "PI_DOGFOOD_GATEWAY_API_KEY", "PI_DOGFOOD_MODEL"]) delete env[k];
    await assert.rejects(
      exec("node", [SCRIPT, "--out", join(tmpdir(), "never-written.json")], { env }),
      (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 2);
        assert.match(err.stderr ?? "", /PI_DOGFOOD_GATEWAY_BASE_URL, PI_DOGFOOD_GATEWAY_API_KEY, PI_DOGFOOD_MODEL/);
        return true;
      },
    );
  });
});
