import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { EngineeringRuntime } from "../../src/index.ts";
import { planMission, scopeTaskDomains } from "../../src/orchestration/missionPlanner.ts";
import { explainMission, formatMissionWhy } from "../../src/orchestration/missionWhy.ts";
import { PLANNER_CLARIFICATION_CATEGORY } from "../../src/orchestration/types.ts";
import { scopesOverlap } from "../../src/plan/taskDag.ts";
import { parsePlannerOutput } from "../../src/plannerWorker/contract.ts";
import { PLANNER_PROMPT } from "../../src/plannerWorker/prompts.ts";
import { missionReportLines } from "../../src/tools/missionReport.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const PLAN = JSON.stringify({
  decisions: ["split by package"],
  contracts: [
    {
      task_id: "api",
      objective: "Add the REST endpoint in src/api",
      scope: { allowed: ["src/api/**"] },
      acceptance: ["endpoint responds"],
      verification: ["npm test -- api"],
      relevant_files: ["src/api/routes.ts"],
    },
    {
      task_id: "ui",
      objective: "Add the settings page in src/ui",
      scope: { allowed: ["src/ui/**"] },
      acceptance: ["page renders"],
      verification: ["npm test -- ui"],
      relevant_files: ["src/ui/Settings.tsx"],
    },
    {
      task_id: "docs",
      objective: "Document both in docs/",
      depends_on: ["api", "ui"],
      scope: { allowed: ["docs/**"] },
      acceptance: ["docs updated"],
      verification: ["true"],
      relevant_files: ["docs/usage.md"],
    },
  ],
});

const BIG_GOAL =
  "Add a REST endpoint under src/api for exporting reports, build a settings page under src/ui to trigger the export, and document both features in docs/usage.md with examples and migration notes for existing users.";

type Reply =
  | { kind: "text"; text: string }
  | { kind: "result"; args: Record<string, unknown> }
  | { kind: "http500" }
  | { kind: "hang" };

function frame(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("mission planner contract", () => {
  const cleanups: Array<() => Promise<void>> = [];
  let agentDir = "";
  before(async () => {
    process.env.PI_MISSION_PLANNER_TIMEOUT_MS = "30000";
    agentDir = await mkdtemp(join(tmpdir(), "pi-eng-agentdir-"));
  });
  after(async () => {
    delete process.env.PI_MISSION_PLANNER;
    delete process.env.PI_MISSION_PLANNER_TIMEOUT_MS;
    for (const c of cleanups) await c().catch(() => {});
    await rm(agentDir, { recursive: true, force: true });
  });

  async function openPlannerRuntime(replies: Reply[]) {
    const fx = await makeFixtureRepo();
    cleanups.push(fx.cleanup);
    const bodies: Array<Record<string, unknown>> = [];
    let n = 0;
    const server = await listen((_req, res, body) => {
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      const reply = replies[Math.min(n++, replies.length - 1)] as Reply;
      if (reply.kind === "hang") return;
      if (reply.kind === "http500") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "service unavailable" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const args =
        reply.kind === "result"
          ? reply.args
          : {
              status: "completed",
              summary: reply.text,
              claims: [],
              evidence_refs: [],
              new_hypotheses: [],
              proposed_tasks: [],
            };
      res.write(
        frame({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "c0",
              type: "function",
              function: { name: "worker_result", arguments: JSON.stringify(args) },
            },
          ],
        }),
      );
      res.write(frame({}, "tool_calls"));
      res.end("data: [DONE]\n\n");
    });
    cleanups.push(async () => {
      server.closeAllConnections();
      server.close();
    });
    const dir = await mkdtemp(join(tmpdir(), "pi-planner-models-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            api: "openai-completions",
            apiKey: "k",
            models: [{ id: "m", contextWindow: 100_000, maxTokens: 4096, reasoning: false }],
          },
        },
      }),
    );
    await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "m" }));
    const real = new PiWorkerExecutor({
      agentDir: dir,
      aps: false,
      gatewayConfig: resolveGatewayConfig({ enabled: true, maxRetries: 0, jitterMs: 0 }),
      admission: new AdmissionController({ maxConcurrency: 2, jitterMs: 0 }),
      transientSleep: async () => {},
      transientRand: () => 0,
    });
    // Real executor; only the model placement (routing is not configured here) is supplied.
    const worker = new Proxy(real, {
      get: (target, prop) =>
        prop === "run"
          ? (req: Parameters<PiWorkerExecutor["run"]>[0]) =>
              target.run({ ...req, modelOverride: { provider: "local", id: "m" } })
          : Reflect.get(target, prop),
    });
    const runtime = await EngineeringRuntime.open({ cwd: fx.root, agentDir: dir, worker });
    return { runtime, fx, bodies };
  }

  async function plan(goal: string, replies: Reply[], manifestRoots?: { writable: string[] }) {
    const { runtime, fx, bodies } = await openPlannerRuntime(replies);
    const store = runtime.missionStore!;
    const mission = store.createMission({
      title: "t",
      goal,
      user_request: goal,
      repository: fx.root,
      base_ref: "HEAD",
      risk_profile: {} as never,
      workflow_class: "engineering",
    });
    void manifestRoots;
    const tasks = await runtime.missionPlanner!(store.getMission(mission.mission_id)!, {} as never);
    return { tasks, bodies, store, mission };
  }

  const planReply = (text: string): Reply[] => [{ kind: "text", text }];

  it("non-trivial goal yields a DAG with disjoint parallel domains, contextRef and a thinking-allowed planner request", async () => {
    const { tasks, bodies } = await plan(BIG_GOAL, planReply(PLAN));
    assert.equal(bodies.length, 1);
    assert.equal(
      (bodies[0]?.chat_template_kwargs as Record<string, unknown> | undefined)?.enable_thinking,
      undefined,
      "planner keeps thinking (#201)",
    );
    assert.match(JSON.stringify(bodies[0]?.messages), /PLANNER of an engineering mission/);
    assert.equal(tasks.length, 3);
    const [api, ui, docs] = tasks;
    assert.deepEqual(api?.write_domains, ["src/api/**"]);
    assert.equal(scopesOverlap("src/api", "src/ui"), false);
    assert.deepEqual(api?.depends_on, []);
    assert.deepEqual(ui?.depends_on, []);
    assert.equal(docs?.depends_on.length, 2);
    for (const t of tasks) {
      assert.match(t.context_ref ?? "", /relevant_files/);
      assert.match(t.context_ref ?? "", /verification/);
    }
  });

  /** The worker_result the planner really produced live (MSN-0wDA7O). */
  async function liveWorkerResult(): Promise<Record<string, unknown>> {
    const lines = (await readFile(new URL("../fixtures/planner-transcript-MSN-0wDA7O.jsonl", import.meta.url), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind?: string; tool?: string; args?: Record<string, unknown> });
    const call = lines.find((l) => l.kind === "tool_call" && l.tool === "worker_result");
    assert.ok(call?.args);
    return call.args;
  }

  it("takes the contracts the planner worker puts in worker_result.details", async () => {
    const args = await liveWorkerResult();
    const { tasks, store, mission } = await plan(BIG_GOAL, [{ kind: "result", args }]);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.task_id, "a-1");
    assert.deepEqual(tasks[0]?.write_domains, ["src/calc.js", "test/calc.test.js"]);
    assert.match(tasks[0]?.objective ?? "", /Acceptance: divide\(a, b\) returns a \/ b/);
    assert.deepEqual(JSON.parse(tasks[0]?.context_ref ?? "{}").verification, ["npm test"]);
    // The deny globs that contradicted the allowed scope are noted, not silently lost.
    const findings = store.listFindings(mission.mission_id).filter((f) => f.category === "mission_planner");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "minor");
    assert.match(findings[0]?.evidence ?? "", /ignored deny globs.*\*\*\/\*/);
    assert.doesNotMatch(findings[0]?.evidence ?? "", /malformed/);
  });

  it("also accepts contracts at the top level, in proposed_tasks, or in a fenced summary block", async () => {
    const live = await liveWorkerResult();
    const contracts = (live.details as { contracts: unknown[] }).contracts;
    const variants: Array<Record<string, unknown>> = [
      // proposed_tasks entries are capped at 1000 chars by the tool: a compact contract fits.
      {
        ...live,
        details: {},
        proposed_tasks: [
          JSON.stringify({
            task_id: "a-1",
            objective: "Add divide",
            scope: { allowed: ["src/calc.js", "test/calc.test.js"] },
            acceptance: ["divide works"],
            verification: ["npm test"],
          }),
        ],
      },
      { ...live, details: {}, summary: `Plan:\n\`\`\`json\n${JSON.stringify({ contracts })}\n\`\`\`` },
    ];
    for (const args of variants) {
      const { tasks } = await plan(BIG_GOAL, [{ kind: "result", args }]);
      assert.equal(tasks.length, 1);
      assert.deepEqual(tasks[0]?.write_domains, ["src/calc.js", "test/calc.test.js"]);
    }
  });

  it("planMission reads top-level contracts on the planner result", async () => {
    const live = await liveWorkerResult();
    const contracts = (live.details as { contracts: unknown[] }).contracts;
    const planned = await planMission({
      goal: BIG_GOAL,
      mutates: true,
      mode: "on",
      acceptanceIds: [],
      single: () => {
        throw new Error("must not fall back");
      },
      runPlanner: async () => ({ summary: "plan", details: {}, ...{ contracts } }),
    });
    assert.equal(planned.tasks.length, 1);
    assert.deepEqual(planned.tasks[0]?.write_domains, ["src/calc.js", "test/calc.test.js"]);
  });

  it("planMission carries the planner's per-task execution requirement onto the task (P3)", async () => {
    const planned = await planMission({
      goal: BIG_GOAL,
      mutates: true,
      mode: "on",
      acceptanceIds: [],
      single: () => {
        throw new Error("must not fall back");
      },
      runPlanner: async () => ({
        summary: "plan",
        details: {},
        contracts: [
          {
            task_id: "calc",
            objective: "Implement divide in src/calc.js",
            scope: { allowed: ["src/calc.js", "test/calc.test.js"] },
            acceptance: ["divide works"],
            verification: ["npm test"],
            execution: { model: "gw/qwen3.8-27b", capabilities: ["long_context"] },
          },
        ],
      }),
    });
    assert.equal(planned.tasks.length, 1);
    assert.deepEqual(planned.tasks[0]?.execution_requirements, {
      model: "gw/qwen3.8-27b",
      capabilities: ["long_context"],
    });
  });

  it("planMission leaves execution_requirements empty when the planner assigns none (P3)", async () => {
    const live = await liveWorkerResult();
    const contracts = (live.details as { contracts: unknown[] }).contracts;
    const planned = await planMission({
      goal: BIG_GOAL,
      mutates: true,
      mode: "on",
      acceptanceIds: [],
      single: () => {
        throw new Error("must not fall back");
      },
      runPlanner: async () => ({ summary: "plan", details: {}, ...{ contracts } }),
    });
    assert.deepEqual(planned.tasks[0]?.execution_requirements, {});
  });

  const blockedArgs = (summary: string, details: Record<string, unknown> = {}) => ({
    status: "blocked",
    summary,
    claims: [],
    evidence_refs: [],
    new_hypotheses: [],
    proposed_tasks: [],
    details,
  });

  it("an explicit clarification question yields no tasks and a clarification finding", async () => {
    const { tasks, store, mission } = await plan(BIG_GOAL, [
      { kind: "result", args: blockedArgs("Which module should divide live in?") },
    ]);
    assert.equal(tasks.length, 0);
    const finding = store.listFindings(mission.mission_id).find((f) => f.category === PLANNER_CLARIFICATION_CATEGORY);
    assert.match(finding?.evidence ?? "", /Which module/);
  });

  it("details.clarification_question is an explicit clarification even without a question mark", async () => {
    const { tasks, store, mission } = await plan(BIG_GOAL, [
      { kind: "result", args: blockedArgs("Need input", { clarification_question: "Name the target module" }) },
    ]);
    assert.equal(tasks.length, 0);
    const finding = store.listFindings(mission.mission_id).find((f) => f.category === PLANNER_CLARIFICATION_CATEGORY);
    assert.equal(finding?.evidence, "Name the target module");
  });

  it("a blocked planner without a question (a tool failure) still falls back to the single task", async () => {
    const { tasks, store, mission } = await plan(BIG_GOAL, [
      { kind: "result", args: blockedArgs("read tool failed: EACCES on src/") },
    ]);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0]?.write_domains, ["**"]);
    const findings = store.listFindings(mission.mission_id);
    assert.equal(findings.filter((f) => f.category === PLANNER_CLARIFICATION_CATEGORY).length, 0);
    assert.match(findings.find((f) => f.category === "mission_planner")?.evidence ?? "", /malformed/);
  });

  it("surfaces the planner's question to the operator and waits once", async () => {
    const question = "Which module should divide live in?";
    const { runtime, fx } = await openPlannerRuntime([{ kind: "result", args: blockedArgs(question) }]);
    const store = runtime.missionStore!;
    const result = await runtime.orchestrator!.orchestrate(BIG_GOAL, {
      repository: fx.root,
      baseRef: "",
      mutationRequested: true,
    });
    const missionId = result.mission.mission_id;
    assert.equal(store.listTasks(missionId).length, 0);

    await runtime.missionSupervisor!.tick(missionId);
    await runtime.missionSupervisor!.tick(missionId);
    await runtime.orchestrator!.repairBlockedMission(missionId);
    await runtime.missionSupervisor!.tick(missionId);

    const waits = store.listRecoveryDecisions(missionId).filter((d) => d.action === "WAIT_FOR_REQUIREMENT");
    assert.equal(waits.length, 1, "exactly one requirement wait");
    assert.match(waits[0]?.operatorGuidance ?? "", /Which module should divide live in\?/);
    assert.equal(store.getMission(missionId)?.status, "WAITING_FOR_USER");
    assert.equal(store.listMissionStops(missionId).length, 0, "a wait for the operator is not a stop: resumable");
    assert.match(formatMissionWhy(explainMission(store, missionId)), /Which module should divide live in\?/);
    assert.match(
      missionReportLines(store, missionId).join("\n"),
      /Planner question: Which module should divide live in\?/,
    );
  });

  it("keeps the planning flag set until the plan is materialised and clears it when the planner throws", async () => {
    const fx = await makeFixtureRepo();
    cleanups.push(fx.cleanup);
    const dir = await mkdtemp(join(tmpdir(), "pi-planner-flag-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    let observed: boolean | undefined;
    const ref: { runtime?: EngineeringRuntime } = {};
    const runtime = await EngineeringRuntime.open({
      cwd: fx.root,
      agentDir: dir,
      orchestrationPlanner: async (mission) => {
        observed = ref.runtime?.orchestrator?.isPlanning(mission.mission_id);
        throw new Error("planner exploded");
      },
    });
    ref.runtime = runtime;
    await assert.rejects(
      runtime.orchestrator!.orchestrate(BIG_GOAL, { repository: fx.root, baseRef: "", mutationRequested: true }),
      /planner exploded/,
    );
    assert.equal(observed, true, "flag is set while the planner runs");
    const missionId = runtime.missionStore!.listMissions().at(-1)?.mission_id ?? "";
    assert.equal(runtime.orchestrator!.isPlanning(missionId), false, "flag is cleared after a planner failure");
  });

  it("serializes tasks whose write domains overlap", async () => {
    const overlapping = JSON.stringify({
      contracts: [
        { task_id: "a", objective: "one", scope: { allowed: ["src/**"] }, acceptance: ["x"], verification: ["true"] },
        {
          task_id: "b",
          objective: "two",
          scope: { allowed: ["src/api/**"] },
          acceptance: ["y"],
          verification: ["true"],
        },
      ],
    });
    const { tasks } = await plan(BIG_GOAL, planReply(overlapping));
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1]?.depends_on.length, 1);
  });

  it("trivial goal keeps the single task without a planner call", async () => {
    const { tasks, bodies } = await plan("Fix the typo in README", planReply(PLAN));
    assert.equal(bodies.length, 0);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0]?.write_domains, ["**"]);
  });

  it("malformed plan falls back to one task and records a finding", async () => {
    const { tasks, bodies, store, mission } = await plan(BIG_GOAL, planReply("I could not produce JSON, sorry"));
    assert.equal(bodies.length, 1);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0]?.write_domains, ["**"]);
    const finding = store.listFindings(mission.mission_id).find((f) => f.category === "mission_planner");
    assert.ok(finding);
    assert.match(finding.evidence ?? "", /malformed/);
    assert.notEqual(finding.severity, "blocking");
    // Malformed output is not an ambiguous goal: no recovery, no operator wait.
    // (The supervisor path is covered in mission-supervisor.test.ts: a fallback plan has tasks,
    // so PLANNING_EMPTY can never fire for it.)
    assert.equal(store.listFailureClassifications(mission.mission_id).length, 0);
    assert.equal(store.listRecoveryDecisions(mission.mission_id).length, 0);
    assert.notEqual(store.getMission(mission.mission_id)?.status, "WAITING_FOR_USER");
  });

  it("a plan whose domains escape the workspace falls back naming the rejected domains", async () => {
    for (const bad of ["/etc/**", "../sibling/**", ".git/**"]) {
      const escaping = JSON.stringify({
        contracts: [
          { task_id: "a", objective: "x", scope: { allowed: [bad] }, acceptance: ["x"], verification: ["true"] },
        ],
      });
      const { tasks, store, mission } = await plan(BIG_GOAL, planReply(escaping));
      assert.deepEqual(tasks[0]?.write_domains, ["**"], bad);
      const finding = store.listFindings(mission.mission_id).find((f) => f.category === "mission_planner");
      assert.ok(finding, bad);
      assert.match(finding.evidence ?? "", /rejected|scope glob|repository-relative/);
    }
  });

  it("a plan that only writes its own forbidden path falls back", async () => {
    const self = JSON.stringify({
      contracts: [
        {
          task_id: "a",
          objective: "x",
          scope: { allowed: ["src/api/**"], forbidden: ["src/**"] },
          acceptance: ["x"],
          verification: ["true"],
        },
      ],
    });
    const { tasks } = await plan(BIG_GOAL, planReply(self));
    assert.deepEqual(tasks[0]?.write_domains, ["**"]);
  });

  it("a transient planner failure is retried once, then falls back saying transient", async () => {
    const { tasks, bodies, store, mission } = await plan(BIG_GOAL, [{ kind: "http500" }]);
    assert.equal(tasks.length, 1);
    assert.ok(bodies.length >= 2, "retried");
    const finding = store.listFindings(mission.mission_id).find((f) => f.category === "mission_planner");
    assert.match(finding?.evidence ?? "", /transient/);
  });

  it("a transient failure then a good plan recovers", async () => {
    const { tasks } = await plan(BIG_GOAL, [{ kind: "http500" }, { kind: "text", text: PLAN }]);
    assert.equal(tasks.length, 3);
  });

  it("a hung planner is aborted by the timeout and falls back", async () => {
    process.env.PI_MISSION_PLANNER_TIMEOUT_MS = "1500";
    try {
      const { tasks, store, mission } = await plan(BIG_GOAL, [{ kind: "hang" }]);
      assert.equal(tasks.length, 1);
      assert.ok(store.listFindings(mission.mission_id).some((f) => f.category === "mission_planner"));
    } finally {
      delete process.env.PI_MISSION_PLANNER_TIMEOUT_MS;
    }
  });

  it("PI_MISSION_PLANNER=off never calls the planner", async () => {
    process.env.PI_MISSION_PLANNER = "off";
    try {
      const { tasks, bodies } = await plan(BIG_GOAL, planReply(PLAN));
      assert.equal(bodies.length, 0);
      assert.equal(tasks.length, 1);
    } finally {
      delete process.env.PI_MISSION_PLANNER;
    }
  });

  it("scopeTaskDomains drops read-only roots and domains outside the manifest's writable domains", () => {
    const parsed = parsePlannerOutput(
      JSON.stringify({
        contracts: [
          {
            task_id: "a",
            objective: "x",
            scope: { allowed: ["src/**", "vendor/**", "other/**"], forbidden: ["src/gen/**"] },
            acceptance: ["x"],
            verification: ["true"],
          },
        ],
      }),
    );
    assert.ok(parsed.ok);
    const contract = parsed.plan.contracts[0]!;
    const { kept, rejected } = scopeTaskDomains(contract, {
      writableDomains: ["src/**", "vendor/**"],
      readOnlyPrefixes: ["vendor"],
    });
    assert.deepEqual(kept, ["src/**"]);
    assert.deepEqual(rejected.sort(), ["other/**", "vendor/**"]);
  });
});
