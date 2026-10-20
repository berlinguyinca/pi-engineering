import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { plannerWorkerDir } from "../../src/plannerWorker/config.ts";
import { registerPlannerWorker } from "../../src/plannerWorker/extension.ts";
import { GatewayChatWorkerExecutor } from "../../src/plannerWorker/gatewayWorker.ts";
import { acquireMissionLock } from "../../src/plannerWorker/missionLock.ts";
import type { MissionAttentionSnapshot } from "../../src/runtime/herdr/MissionAttentionReporter.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { startGatewayServer } from "../support/gatewayServer.ts";

test("planner extension continuously displays activity and routes only final/stall attention", async (t) => {
  const fixture = await makeFixtureRepo();
  t.after(fixture.cleanup);
  await mkdir(join(fixture.root, ".pi"), { recursive: true });
  await writeFile(
    join(fixture.root, ".pi", "engineering.yaml"),
    "planner_worker:\n  mode: planner-worker\n  provider: iw\n",
  );
  const server = await startGatewayServer({
    models: [
      { id: "plan", x_capabilities: ["coding.planning", "coding.review"], x_context_window: 131072 },
      { id: "implement", x_capabilities: ["coding.implementation"], x_context_window: 131072 },
    ],
    respond: (req) => {
      if (req.system.startsWith("You are the PLANNER"))
        return {
          content: JSON.stringify({
            contracts: [
              {
                task_id: "alpha",
                objective: "write alpha",
                scope: { allowed: ["src/alpha/**"] },
                acceptance: ["file exists"],
                verification: ["test -f src/alpha/done.txt"],
              },
            ],
          }),
        };
      if (req.system.startsWith("You are an IMPLEMENTER"))
        return {
          content: JSON.stringify({
            status: "completed",
            summary: "wrote file",
            files: [{ path: "src/alpha/done.txt", content: "done" }],
          }),
        };
      return { content: JSON.stringify({ status: "pass", issues: [], required_changes: [] }) };
    },
  });
  t.after(() => server.close());
  const gateway = new GatewayChatWorkerExecutor({ baseUrl: server.baseUrl, defaultModel: "plan" });
  const widgets: Array<string[] | undefined> = [];
  const notices: string[] = [];
  const attention: MissionAttentionSnapshot[] = [];
  let delayed = false;
  const integration = registerPlannerWorker({ registerCommand() {}, on() {} } as unknown as ExtensionAPI, {
    host: async () => ({
      repoRoot: fixture.root,
      reportAttention: (snapshot) => attention.push(snapshot),
      worker: {
        async run(req) {
          if (!delayed) {
            delayed = true;
            req.onActivity?.({ kind: "state", summary: "Awaiting model response", meaningfulProgress: false });
            await new Promise((resolve) => setTimeout(resolve, 1150));
          }
          return gateway.run(req);
        },
      },
    }),
  });
  const context = {
    model: { provider: "iw", baseUrl: server.baseUrl },
    modelRegistry: { getProviderAuth: async () => ({ auth: { baseUrl: server.baseUrl } }) },
    ui: {
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
      setStatus() {},
      notify: (text: string) => notices.push(text),
    },
  } as unknown as ExtensionCommandContext;
  assert.equal(await integration.runIfSelected("write a file", context), true);
  assert.equal(notices.length, 1, "ordinary phases/tool events do not produce notifications");
  assert.match(notices[0]!, /\[completed\]/);
  assert.ok(
    widgets.some((lines) => lines?.some((line) => /Awaiting model response.*1s/.test(line))),
    "one-second tick refreshes a quiet model request",
  );
  assert.equal(widgets.at(-1), undefined, "display is cleared after completion");
  assert.equal(attention.at(-1)?.state, "completed");
  assert.ok(
    attention.slice(0, -1).every((snapshot) => snapshot.health === "active"),
    "routine observations remain non-notifying attention states",
  );
  const missionId = attention.at(-1)!.missionId;
  const stateDir = join(plannerWorkerDir(fixture.root), missionId);
  const attentionCount = attention.length;
  await integration.resumeIfOwned(missionId, context);
  assert.equal(attention.length, attentionCount, "already completed resume is a refusal, not a crash");
  const lock = await acquireMissionLock(stateDir);
  try {
    await integration.resumeIfOwned(missionId, context);
    assert.equal(attention.length, attentionCount, "live owner lock refusal must not report the mission as failed");
  } finally {
    await lock.release();
  }
  const saved = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
  saved.status = "failed";
  saved.base_commit = "nonexistent-revision";
  saved.integration_branch = "nonexistent-branch";
  await writeFile(join(stateDir, "state.json"), JSON.stringify(saved));
  await integration.resumeIfOwned(missionId, context);
  assert.equal(
    attention.at(-1)?.state,
    "failed",
    "failure after taking ownership and validating resume reports a genuine crash",
  );
});
