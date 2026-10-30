/**
 * Handoff instead of compaction keeps the model: a worker whose context crosses the emergency level -> ContextHandoffTrigger
 * -> a `context` record with cause=context_pressure and fromModel == toModel (the routable provider/id) -> HandoffDriver
 * (verify -> pin the task to that model -> fence the source writer) -> the scheduler's ordinary retry runs the SUCCESSOR in
 * a new session on the SAME model from the verified checkpoint -> acknowledged. A model that cannot be pinned (gone from the
 * registry, marked unavailable) is said so and the successor routes normally. Entered through Orchestrator.orchestrate().
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { ExecutionBroker } from "../../src/orchestration/broker.ts";
import type { BrokerBackends, IntegrationHandoff } from "../../src/orchestration/broker.ts";
import type { HandoffVerifyDeps } from "../../src/orchestration/handoffProtocol.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { buildContinuityConfig } from "../../src/runtime/continuityWiring.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { createLineageEmitter } from "../../src/runtime/herdr/lineage.ts";
import { CONTEXT_USAGE_SUMMARY } from "../../src/workers/activity.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Call {
  model: unknown;
  sawFirstWorkersCommit: boolean;
  sessionId: string | undefined;
}

interface HarnessOptions {
  /** Calls (1-based) whose worker crosses the emergency context level. Default: only the first. */
  pressureCalls?: number[];
  maxAttempts?: number;
  /** Task model pin; null = role-routed, no model on the task. */
  pin?: string | null;
  /** Model the worker reports serving in its context reading. Default: the task pin. */
  reportsModel?: string;
  /** Registry the continuity config resolves ids against. Default: gw/primary, gw/fallback, gw/fallback2. */
  registry?: Array<{ provider: string; id: string; contextWindow: number }>;
  /** Models the runtime marks unavailable (provider/id). */
  unavailable?: string[];
}

async function harness(yaml: string | null, opts: HarnessOptions = {}) {
  const pressureCalls = opts.pressureCalls ?? [1];
  const pin = opts.pin === undefined ? "gw/primary" : opts.pin;
  const logs: string[] = [];
  const fx = await makeFixtureRepo();
  cleanups.push(() => fx.cleanup());
  const agentDir = await mkdtemp(join(tmpdir(), "ctx-agent-"));
  cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
  if (yaml !== null) await writeFile(join(agentDir, "engineering.yaml"), yaml);
  const phaseHandoff = await buildContinuityConfig({
    agentDir,
    models: async () =>
      opts.registry ?? [
        { provider: "gw", id: "primary", contextWindow: 1000 },
        { provider: "gw", id: "fallback", contextWindow: 1000 },
        { provider: "gw", id: "fallback2", contextWindow: 1000 },
      ],
    isModelUnavailable: (m) => opts.unavailable?.includes(`${m.provider}/${m.id}`) === true,
    log: (line) => logs.push(line),
  });
  const git = (await GitRepo.open(fx.root))!;
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const envelopes = new EnvelopeStore({ dir: await mkdtemp(join(tmpdir(), "ctx-env-")), source: "pi-h-00000001" });
  const lineage = createLineageEmitter({ store: envelopes }, { host: "pi-h-00000001" })!;
  store.setLineage(lineage);
  const calls: Call[] = [];
  const reports: string[] = [];
  const backends: BrokerBackends = {
    agent: {
      runAgent: async ({ worktree, signal, onActivity, sessionId, modelRequirements }) => {
        const n = calls.length + 1;
        calls.push({
          model: modelRequirements?.model,
          sawFirstWorkersCommit: existsSync(join(worktree!, "src", "w1.js")),
          sessionId,
        });
        await mkdir(join(worktree!, "src"), { recursive: true });
        await writeFile(join(worktree!, "src", `w${n}.js`), `export const a = ${n};\n`);
        await git.commitAll(worktree!, `work ${n}`);
        if (pressureCalls.includes(n)) {
          const serving = opts.reportsModel ?? pin;
          if (serving) {
            onActivity?.({
              kind: "state",
              summary: CONTEXT_USAGE_SUMMARY,
              meaningfulProgress: false,
              context: { tokens: 950, window: 1000, model: serving },
            });
          }
          // Keep running until the handoff either fences this writer or reports that it is blocked.
          const end = Date.now() + 15_000;
          while (
            Date.now() < end &&
            !signal.aborted &&
            !store
              .listHandoffRecords()
              .some(
                (h) =>
                  h.predecessor.sessionId === sessionId &&
                  (h.sourceFencedAt || h.blockedReason || h.state === "aborted"),
              )
          ) {
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        return { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
      },
    },
    integration: {
      runIntegration: async ({ handoffs }: { handoffs: IntegrationHandoff[] }) => {
        for (const h of handoffs) await git.mergeBranch(h.ref ?? h.worktree.branch);
        return { executionId: "i", exitStatus: "succeeded", summary: "merged", artifactRefs: [], usage: {} };
      },
    },
  };
  const orchestrator = new Orchestrator({
    store,
    backends,
    git,
    parentSessionId: "sess-parent",
    phaseHandoff,
    planner: async (mission) => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "build",
        mutates_repo: true,
        write_domains: ["src/**"],
        isolation: "worktree" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: pin === null ? {} : { model: pin },
        acceptance_ids: mission.acceptance_criteria.flatMap((c) => (c.acceptance_id ? [c.acceptance_id] : [])),
        deliverables: ["one"],
        max_attempts: opts.maxAttempts ?? 3,
        failure_policy: "retry" as const,
      },
    ],
  });
  const progress = (orchestrator as unknown as { progress: Map<string, (l: string) => void> }).progress;
  const originalGet = progress.get.bind(progress);
  progress.get = (key) => originalGet(key) ?? ((line: string) => void reports.push(line));

  const base = await git.headCommit();
  const run = async () => {
    const result = await orchestrator.orchestrate("build", {
      repository: fx.root,
      baseRef: base,
      mutationRequested: true,
    });
    await orchestrator.settleHandoffs();
    return result.mission.mission_id;
  };
  return { store, backend, orchestrator, calls, reports, run, lineage, envelopes, git, fx, logs };
}

const agentExecutions = (store: MissionStore, missionId: string) =>
  store.listExecutions(missionId).filter((e) => e.backend === "agent");

describe("a context handoff keeps the model through orchestrate()", () => {
  it("pressure -> verify -> pin -> fence -> successor in a NEW session on the SAME model from the checkpoint -> acknowledged", async () => {
    const h = await harness(null);
    const missionId = await h.run();
    const [record, ...more] = h.store.listHandoffRecords(missionId);
    const [fenced, successor, ...extra] = agentExecutions(h.store, missionId);
    assert.equal(more.length, 0, "one handoff");
    assert.equal(extra.length, 0, "exactly one successor, no double spawn");
    assert.ok(record);
    assert.equal(record.kind, "context");
    assert.equal(record.cause, "context_pressure");
    assert.equal(record.fromModel, "gw/primary");
    assert.equal(record.toModel, "gw/primary", "the successor is pinned to the predecessor's own model");
    assert.equal(record.state, "acknowledged");
    assert.ok(record.verifiedAt && record.sourceFencedAt);
    assert.ok(Date.parse(record.verifiedAt as string) <= Date.parse(record.sourceFencedAt as string));
    assert.equal(fenced?.status, "CANCELED");
    assert.match(fenced?.exit_status ?? "", /late_result_rejected:handoff source fenced/);
    assert.equal(successor?.model, "gw/primary");
    assert.equal(successor?.status, "SUCCEEDED");
    assert.ok(successor?.session_id && successor.session_id !== fenced?.session_id, "a new session, not the old one");
    assert.equal(record.predecessor.sessionId, fenced?.session_id);
    assert.equal(record.successor?.sessionId, successor?.session_id);
    assert.deepEqual(
      h.calls.map((c) => c.model),
      ["gw/primary", "gw/primary"],
    );
    assert.equal(h.calls[1]?.sawFirstWorkersCommit, true, "the successor starts from the verified checkpoint");
    assert.notEqual(h.calls[0]?.sessionId, h.calls[1]?.sessionId);
    assert.ok(h.reports.some((l) => /source fenced \(successor pinned to gw\/primary\)/.test(l)));
  });

  it("the task is pinned durably to the checkpoint and the model", async () => {
    const h = await harness(null);
    const missionId = await h.run();
    const [record] = h.store.listHandoffRecords(missionId);
    const task = h.store.listTasks(missionId).find((t) => t.kind === "agent");
    assert.ok(record?.checkpointSha);
    assert.ok(task?.repair_base_candidate_sha?.startsWith(record.checkpointSha as string));
    assert.equal(task?.execution_requirements.model, "gw/primary");
    assert.equal(task?.status, "SUCCEEDED");
  });

  it("a role-routed task (no pin) that reports a bare id is pinned to the routable provider/id", async () => {
    const h = await harness(null, { pin: null, reportsModel: "primary" });
    const missionId = await h.run();
    const [record] = h.store.listHandoffRecords(missionId);
    assert.equal(record?.fromModel, "primary");
    assert.equal(record?.toModel, "gw/primary", "qualified through the registry, never the bare id");
    assert.equal(record?.state, "acknowledged");
    assert.deepEqual(
      h.calls.map((c) => c.model),
      [undefined, "gw/primary"],
      "the first worker was role-routed; its successor is explicitly on the model the first one served",
    );
    assert.equal(agentExecutions(h.store, missionId)[1]?.model, "gw/primary");
  });

  it("works unchanged when quota_fallbacks is not configured (no quotas): the context path never reads it", async () => {
    const h = await harness("# nothing configured\n");
    const missionId = await h.run();
    assert.equal(h.store.listHandoffRecords(missionId)[0]?.state, "acknowledged");
    assert.deepEqual(h.logs, []);
  });

  it("a model the runtime marked unavailable is not pinned: the record says so, the writer is still fenced, the successor routes normally", async () => {
    const h = await harness(null, { unavailable: ["gw/primary"] });
    const missionId = await h.run();
    const [record] = h.store.listHandoffRecords(missionId);
    assert.equal(record?.cause, "context_pressure");
    assert.equal(record?.fromModel, "gw/primary");
    assert.equal(record?.toModel, undefined, "never pinned to a model that cannot serve");
    assert.ok(record?.sourceFencedAt, "the context handoff still happens: the old session is out of room");
    assert.ok(
      h.reports.some((l) =>
        /successor not pinned to gw\/primary \(the gateway marked it unavailable\); it routes normally/.test(l),
      ),
    );
    assert.equal(agentExecutions(h.store, missionId).length >= 2, true, "a successor still ran");
  });

  it("a model absent from a readable registry is not pinned either", async () => {
    const h = await harness(null, {
      pin: null,
      reportsModel: "gw/ghost",
    });
    const missionId = await h.run();
    const [record] = h.store.listHandoffRecords(missionId);
    assert.equal(record?.toModel, undefined);
    assert.ok(h.reports.some((l) => /successor not pinned to gw\/ghost \(not in the model registry\)/.test(l)));
  });

  it("a second pressure crossing on the successor hands off again, same model, new session", async () => {
    const h = await harness(null, { pressureCalls: [1, 2] });
    const missionId = await h.run();
    const records = h.store.listHandoffRecords(missionId).filter((r) => r.cause === "context_pressure");
    assert.equal(records.length, 2);
    assert.ok(records.every((r) => r.fromModel === "gw/primary" && r.toModel === "gw/primary"));
    assert.deepEqual(
      h.calls.map((c) => c.model),
      ["gw/primary", "gw/primary", "gw/primary"],
    );
    assert.equal(new Set(agentExecutions(h.store, missionId).map((e) => e.session_id)).size, 3);
  });

  it("the lineage handoff edge carries the cause and the same from/to model", async () => {
    const h = await harness(null);
    await h.run();
    await h.lineage.idle();
    const events = (await h.envelopes.outbox.pending()).filter((e) => e.entity_type === "lineage");
    const edge = events.find(
      (e) =>
        e.event_type === "edge.add" &&
        (e.payload as { edge_type?: string }).edge_type === "handoff" &&
        (e.payload as { attrs?: { cause?: string } }).attrs?.cause === "context_pressure",
    );
    assert.ok(edge, "a handoff edge with the context cause was emitted");
    const attrs = (edge?.payload as { attrs: Record<string, unknown> }).attrs;
    assert.equal(attrs.from_model, "gw/primary");
    assert.equal(attrs.to_model, "gw/primary");
  });

  it("with no retry budget left the source is NOT fenced and the record is aborted with a reason", async () => {
    const h = await harness(null, { maxAttempts: 1 });
    const missionId = await h.run();
    const [record] = h.store.listHandoffRecords(missionId);
    assert.equal(record?.cause, "context_pressure");
    assert.equal(record?.state, "aborted");
    assert.match(record?.blockedReason ?? "", /no retry budget left.*successor on gw\/primary not started/);
    assert.equal(record?.sourceFencedAt, undefined);
    const executions = agentExecutions(h.store, missionId);
    assert.equal(executions.length, 1);
    assert.notEqual(executions[0]?.status, "CANCELED");
  });
});
