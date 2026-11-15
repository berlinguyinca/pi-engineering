/**
 * Phase 6: the UI-facing worker activity of the omp path equals the legacy executor's. A mission agent task runs
 * through `realBackends` (the production seam the mission UI is fed from) on the legacy `PiWorkerExecutor` and on a
 * REAL omp (gated on OMP_BIN), both against the same scripted model over real HTTP. The activity each emits through
 * `onActivity` is normalized and compared; each event is then rendered by the real footer formatter
 * (`formatMissionActivity`) into a deterministic text capture, and the legacy capture is a checked-in golden.
 * Set UPDATE_GOLDEN=1 to rewrite it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { selectOmpWorker } from "../../src/omp/selectWorker.ts";
import { ContextHandoffTrigger } from "../../src/orchestration/contextHandoffTrigger.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import type { RuntimeMissionActivityEvent } from "../../src/runtime/EngineeringRuntime.ts";
import type { HandoffRecord } from "../../src/runtime/host/handoffKinds.ts";
import { formatMissionActivity } from "../../src/status/missionActivity.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import type { WorkerActivity, WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { engineerModelScript, realOmpEnv, startOfflineOmp } from "../support/ompOffline.ts";
import { startScriptedModel } from "../support/scriptedModelServer.ts";

const skip = realOmpEnv() ? false : "UNVERIFIED: OMP_BIN not set; no real omp available";
const ADD_OK = "export function add(a, b) {\n  return a + b;\n}\n";
const GOLDEN = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "fixtures",
  "legacy-golden",
  "ui-activity-engineer.golden.txt",
);
const scratch = mkdtempSync(join(tmpdir(), "pe-parity-ui-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const normalize = (events: WorkerActivity[]): string[] =>
  events.map((e) =>
    [
      e.kind,
      e.phase ?? "-",
      e.toolName ?? "-",
      e.toolTarget ?? "-",
      e.toolCommand ?? "-",
      e.summary,
      e.context ? `${e.context.model}:${e.context.tokens}/${e.context.window}` : "-",
    ].join(" | "),
  );

/** One deterministic footer line per activity: the real formatter over a fixed mission frame. */
function render(events: WorkerActivity[]): string {
  return `${events
    .map((e) => {
      const frame: RuntimeMissionActivityEvent = {
        missionId: "m-1",
        title: "t",
        phase: "run",
        state: "running",
        health: "healthy",
        approximatePercent: 0,
        acceptanceCoverage: { completed: 0, total: 1, approximatePercent: 0 },
        workflowProgress: { completed: 0, total: 1, approximatePercent: 0 },
        summary: "running",
        activeWorkers: 1,
        waitingWorkers: 0,
        failedWorkers: 0,
        lastMeaningfulProgressAt: null,
        action: "monitor",
        reason: "worker running",
        recovery: { attempt: 0, maxAttempts: 3 },
        nextAction: "monitor",
        nextActionAt: null,
        owner: "o",
        repository: "r",
        task: "task-1",
        preservedWork: [],
        observedAt: "2026-01-01T00:00:00.000Z",
        workersDetail: [{ workerId: "w", taskId: "task-1", status: "running", currentActivity: e.summary }],
      };
      return formatMissionActivity(frame).detail;
    })
    .join("\n")}\n`;
}

function legacyAgentDir(baseUrl: string): string {
  const dir = mkdtempSync(join(scratch, "legacy-agent-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        pelocal: {
          baseUrl,
          api: "openai-completions",
          apiKey: "sk-local-not-used",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
          models: [
            {
              id: "scripted",
              name: "scripted",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ defaultProvider: "pelocal", defaultModel: "scripted", enabledModels: ["pelocal/scripted"] }),
  );
  return dir;
}

/**
 * Feed the context signals of a run to the real handoff trigger, exactly as the orchestrator does
 * (`observeContinuitySignals`), with thresholds set so the scripted usage crosses preferred then emergency.
 */
async function triggerRecords(events: WorkerActivity[]): Promise<Array<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = [];
  const trigger = new ContextHandoffTrigger({
    thresholdsFor: () => ({ soft: 0.0001, preferred: 0.004, emergency: 0.005 }),
    requestCheckpoint: async () => true,
    latestCheckpointSha: () => "d".repeat(40),
    addHandoff: (record) => {
      records.push(record as unknown as Record<string, unknown>);
      return record as unknown as HandoffRecord;
    },
    endpoint: () => ({ sessionId: "sess-1", generation: 0 }),
    report: () => {},
  });
  for (const e of events) {
    if (!e.context) continue;
    await trigger.observe({ missionId: "m-1", taskId: "t-1", executionId: "e-1", ...e.context });
    await trigger.safePoint("e-1");
  }
  return records.map(({ id: _id, createdAt: _createdAt, ...rest }) => rest);
}

async function capture(worker: WorkerExecutor, cwd: string): Promise<WorkerActivity[]> {
  const events: WorkerActivity[] = [];
  const backends = realBackends({
    worker,
    verifier: {} as never,
    artifacts: {} as never,
    git: null,
    cwd,
  });
  const run = await backends.agent.runAgent({
    role: "implementer",
    objective: "implement add",
    worktree: cwd,
    signal: new AbortController().signal,
    onActivity: (event) => events.push(event),
  });
  assert.equal(run.exitStatus, "succeeded", run.error);
  return events;
}

async function legacyEvents(): Promise<WorkerActivity[]> {
  const fx = await makeFixtureRepo();
  const server = await startScriptedModel(engineerModelScript({ implement: ADD_OK }));
  try {
    const worker = new PiWorkerExecutor({
      agentDir: legacyAgentDir(server.baseUrl),
      aps: false,
      gatewayConfig: resolveGatewayConfig({ enabled: false }),
    });
    return await capture(worker, fx.root);
  } finally {
    await server.close();
    await fx.cleanup();
  }
}

async function ompEvents(): Promise<WorkerActivity[]> {
  const fx = await makeFixtureRepo();
  const offline = await startOfflineOmp(engineerModelScript({ implement: ADD_OK }));
  try {
    const picked = await selectOmpWorker(
      () => ({
        run: async () => {
          throw new Error("the legacy executor must never run");
        },
      }),
      offline.env,
    );
    assert.equal(picked?.selection.path, "omp");
    return await capture(picked!.executor, fx.root);
  } finally {
    await offline.close();
    await fx.cleanup();
  }
}

describe("UI-facing worker activity: omp path equals legacy (real omp)", { skip, timeout: 300_000 }, () => {
  it("the normalized activity sequence and its rendered footer lines are identical, and match the legacy golden", async () => {
    const legacy = await legacyEvents();
    const omp = await ompEvents();
    const l = normalize(legacy);
    assert.ok(l.length >= 4, `legacy emitted UI-facing activity (${l.length})`);
    assert.ok(
      l.some((line) => line.startsWith("tool | started | write")),
      "the run includes a write tool",
    );
    assert.deepEqual(normalize(omp), l, "same UI-facing activity events, in the same order, with the same shapes");
    const shown = render(legacy);
    assert.equal(render(omp), shown, "the rendered footer text is identical");
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, shown);
    assert.equal(shown, readFileSync(GOLDEN, "utf8"), "the legacy render matches the checked-in golden");

    const legacyHandoffs = await triggerRecords(legacy);
    assert.ok(legacyHandoffs.length >= 1, "the scripted usage fires the context-threshold trigger on legacy");
    assert.deepEqual(await triggerRecords(omp), legacyHandoffs, "the trigger fires identically on the omp path");
  });
});
