/**
 * The real EngineeringRuntime honours the operator pin: a mission started from
 * this session dispatches its workers on the model the operator chose with
 * `/model`, not on the role pin, records the session that started it, persists
 * the pin across a restart, and logs the MODEL_TRANSITION.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/index.ts";
import { type ModelRef, modelKey } from "../../src/lifecycle/types.ts";
import { RuntimeSession } from "../../src/runtime/isolation/RuntimeSession.ts";
import { onOperatorModelSelect, resetSessionModelChoice } from "../../src/runtime/operatorModelPin.ts";
import { type TelemetryNotice, setTelemetrySink } from "../../src/telemetry/sink.ts";
import type { WorkerExecutor, WorkerRequest } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const GLM: ModelRef = { provider: "gw", id: "glm5.3-flash-modality-vision-quant-q6_k_xl" };
const DEEPSEEK: ModelRef = { provider: "gw", id: "deepseek_v4-flash-modality-text-quant-mxfp4" };

function recordingWorker(seen: WorkerRequest[]): WorkerExecutor {
  return {
    async run(request) {
      seen.push({ ...request });
      if (request.role === "implementer") {
        await writeFile(join(request.cwd, "src", "add.js"), "export function add(a, b) { return a + b; }\n");
      }
      return {
        result: {
          status: "completed",
          summary: `${request.role} completed`,
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
        usage: null,
        toolCalls: 0,
        structured:
          request.resultTool === "review_result"
            ? {
                verdict: "approve",
                findings: [],
                missingTests: [],
                specGaps: [],
                acceptanceResults: [...request.task.matchAll(/Acceptance criterion ([^:]+):/g)].map((m) => ({
                  acceptanceId: m[1]!,
                  status: "passed" as const,
                  detail: "checked",
                })),
                summary: "approved",
              }
            : undefined,
      };
    },
  };
}

test("runtime: missions from this session dispatch on the operator pin over the role pin", async () => {
  const fixture = await makeFixtureRepo();
  const notices: TelemetryNotice[] = [];
  const uninstall = setTelemetrySink((notice) => notices.push(notice));
  const sessionId = RuntimeSession.current().sessionId;
  const seen: WorkerRequest[] = [];
  let runtime: EngineeringRuntime | undefined;
  try {
    runtime = await EngineeringRuntime.open({
      cwd: fixture.root,
      workDir: join(fixture.root, ".pi-eng"),
      // engineering.yaml pins every role onto the exhausted model.
      roleRouter: { route: async () => ({ ...GLM }) },
      model: { ...GLM, api: "openai-completions", contextWindow: 262_144, maxTokens: 4096 } as never,
      worker: recordingWorker(seen),
    });
    resetSessionModelChoice(sessionId, GLM);
    assert.equal(onOperatorModelSelect(sessionId, { model: DEEPSEEK, source: "set" }).action, "pinned");

    const result = await runtime.orchestrator!.orchestrate("Make add return the sum", {
      repository: fixture.root,
      baseRef: await runtime.git!.headCommit(),
      mutationRequested: true,
    });
    const missionId = result.mission.mission_id;
    const implementers = seen.filter((request) => request.role === "implementer");
    assert.ok(implementers.length > 0, JSON.stringify(seen.map((r) => r.role)));
    for (const request of implementers) {
      assert.deepEqual(request.modelOverride, DEEPSEEK, "the implementer runs on the operator's choice");
      assert.equal(request.operatorPinned, true);
    }
    const reviewer = seen.find((request) => request.role === "reviewer");
    if (reviewer) {
      assert.notDeepEqual(reviewer.modelOverride, DEEPSEEK, "review stays independent of the producing model");
    }

    const mission = runtime.missionStore!.getMission(missionId)!;
    assert.equal(mission.parent_session_id, sessionId);
    assert.equal(mission.operator_model_pin?.id, DEEPSEEK.id);
    assert.ok(
      notices.some(
        (notice) =>
          (notice.detail as { type?: string } | undefined)?.type === "MODEL_TRANSITION" &&
          notice.text.includes(`model: ${modelKey(DEEPSEEK)} (operator pin)`),
      ),
      JSON.stringify(notices.map((n) => n.text)),
    );

    // Restart: the persisted pin survives.
    await runtime.close();
    runtime = await EngineeringRuntime.open({
      cwd: fixture.root,
      workDir: join(fixture.root, ".pi-eng"),
      roleRouter: { route: async () => ({ ...GLM }) },
      worker: recordingWorker([]),
    });
    assert.equal(runtime.missionStore!.getMission(missionId)?.operator_model_pin?.id, DEEPSEEK.id);
  } finally {
    uninstall();
    await runtime?.close();
    await fixture.cleanup();
  }
});
