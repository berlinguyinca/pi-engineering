/**
 * AgentRuntime contract tests — HERDR runtime (herdr spec 02/03/15).
 *
 * Runs the SAME contract as the legacy runtime against `HerdrAgentRuntime`,
 * using a fake `HerdrCli` (no live server required for the contract). Also
 * proves the capability/version negotiation path. A separate integration test
 * (not here) exercises the real `herdr` binary when the server is reachable.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HerdrAgentRuntime } from "../../src/runtime/herdr/HerdrAgentRuntime.ts";
import type { HerdrAgent, HerdrCli, HerdrStatus } from "../../src/runtime/herdr/HerdrCli.ts";
import { createAgentRuntime, negotiateHerdr } from "../../src/runtime/index.ts";
import { runAgentRuntimeContract } from "./agentruntime-contract.ts";

/** A deterministic fake Herdr CLI that simulates prompt -> working -> done. */
class FakeHerdrCli implements HerdrCli {
  readonly agents = new Map<string, HerdrAgent>();
  statusVal: HerdrStatus = { ok: true, serverVersion: "0.9.1", protocol: 22 };
  promptCalls = 0;
  startCalls: Array<{ paneId: string; name: string }> = [];
  workspaceCalls = 0;

  constructor() {
    this.agents.set("fake-pane", {
      agent_status: "idle",
      cwd: "/tmp",
      pane_id: "fake-pane",
      workspace_id: "w1",
      revision: 1,
      state_change_seq: 1,
    });
  }

  async status(): Promise<HerdrStatus> {
    return this.statusVal;
  }
  async listAgents(): Promise<HerdrAgent[]> {
    return [...this.agents.values()];
  }
  async getAgent(target: string): Promise<HerdrAgent | null> {
    return this.agents.get(target) ?? null;
  }
  async readAgent(): Promise<string> {
    return "implemented add a health endpoint";
  }
  async prompt(target: string, _text: string, _timeoutMs?: number): Promise<void> {
    this.promptCalls++;
    this.agents.set(target, { ...this.agents.get(target)!, agent_status: "done", revision: 2, state_change_seq: 2 });
  }
  async wait(target: string, _until: string[], _timeoutMs?: number): Promise<HerdrAgent> {
    return (
      this.agents.get(target) ?? {
        agent_status: "done",
        cwd: "/tmp",
        pane_id: target,
        workspace_id: "w1",
        revision: 2,
        state_change_seq: 2,
      }
    );
  }
  async startAgent(paneId: string, _kind: string, name: string): Promise<void> {
    this.startCalls.push({ paneId, name });
    if (!this.agents.has(paneId)) {
      this.agents.set(paneId, {
        agent_status: "idle",
        cwd: "/tmp",
        pane_id: paneId,
        workspace_id: "w1",
        revision: 1,
        state_change_seq: 1,
      });
    }
  }
  async sendKeys(): Promise<void> {}
  async closePane(target: string): Promise<void> {
    this.agents.delete(target);
  }
  async createWorkspace(repo: string) {
    this.workspaceCalls++;
    return { workspaceId: "w1", paneId: `w1:p${this.workspaceCalls}`, path: repo };
  }
  async createWorktree(repo: string) {
    return { workspaceId: "wt1", paneId: "wt1:p1", path: `${repo}-wt` };
  }
}

test("Herdr provisioning starts a real pane in a new workspace", async () => {
  const cli = new FakeHerdrCli();
  const rt = new HerdrAgentRuntime({ cli });
  const rid = await rt.create({ role: "implementer", objective: "A", isolation: "none", cwd: "/tmp/repo" });
  await rt.start(rid);
  assert.equal(cli.startCalls[0]!.paneId, "w1:p1");
  assert.equal(cli.workspaceCalls, 1);
  assert.match(cli.startCalls[0]!.name, /^[a-z][a-z0-9_-]{0,31}$/);
});

test("Herdr worktree provisioning starts its root pane and preserves checkout path", async () => {
  const cli = new FakeHerdrCli();
  const rt = new HerdrAgentRuntime({ cli });
  const rid = await rt.create({ role: "implementer", objective: "A", isolation: "worktree", cwd: "/tmp/repo" });
  const worker = await rt.start(rid);
  assert.equal(cli.startCalls[0]!.paneId, "wt1:p1");
  assert.equal(worker.worktree, "/tmp/repo-wt");
  assert.equal(cli.workspaceCalls, 0);
});

test("Herdr provisioning fails closed when isolation cannot be created", async () => {
  const cli = new FakeHerdrCli();
  cli.createWorktree = async () => {
    throw new Error("worktree rejected");
  };
  const rt = new HerdrAgentRuntime({ cli });
  const rid = await rt.create({ role: "implementer", objective: "A", isolation: "worktree" });
  await assert.rejects(rt.start(rid), /worktree rejected/);
  assert.equal(cli.startCalls.length, 0);
});

test("retrying agent startup reuses the already allocated pane", async () => {
  const cli = new FakeHerdrCli();
  const start = cli.startAgent.bind(cli);
  let attempts = 0;
  cli.startAgent = async (pane, kind, name) => {
    if (++attempts === 1) throw new Error("startup failed");
    await start(pane, kind, name);
  };
  const rt = new HerdrAgentRuntime({ cli });
  const rid = await rt.create({ role: "planner", objective: "A", isolation: "none" });
  await assert.rejects(rt.start(rid), /startup failed/);
  await rt.start(rid);
  assert.equal(cli.workspaceCalls, 1);
  assert.equal(cli.startCalls[0]!.paneId, "w1:p1");
});

test("concurrent starts share one allocation and one agent startup", async () => {
  const cli = new FakeHerdrCli();
  const rt = new HerdrAgentRuntime({ cli });
  const rid = await rt.create({ role: "planner", objective: "A", isolation: "none" });
  await Promise.all([rt.start(rid), rt.start(rid)]);
  assert.equal(cli.workspaceCalls, 1);
  assert.equal(cli.startCalls.length, 1);
  assert.equal(cli.startCalls[0]!.paneId, "w1:p1");
});

test("concurrent start and sendTask share the provisioned pane", async () => {
  const cli = new FakeHerdrCli();
  const rt = new HerdrAgentRuntime({ cli });
  const rid = await rt.create({ role: "planner", objective: "A", isolation: "none" });
  await Promise.all([rt.start(rid), rt.sendTask(rid, "A")]);
  assert.equal(cli.workspaceCalls, 1);
  assert.equal(cli.startCalls.length, 1);
  assert.equal(cli.promptCalls, 1);
  assert.equal(cli.startCalls[0]!.paneId, "w1:p1");
});

test("sendTask forwards the declared worker deadline to prompt submission", async () => {
  const cli = new FakeHerdrCli();
  let submittedTimeout: number | undefined;
  cli.prompt = async (_target, _text, timeoutMs) => {
    submittedTimeout = timeoutMs;
  };
  const rt = new HerdrAgentRuntime({ cli });
  const rid = await rt.create({ role: "planner", objective: "A", isolation: "none", timeoutMs: 180_000 });
  await rt.sendTask(rid, "A");
  assert.equal(submittedTimeout, 180_000);
});

test("parallel same-role workers receive distinct legal Herdr names", async () => {
  const cli = new FakeHerdrCli();
  const rt = new HerdrAgentRuntime({ cli });
  const workers = await Promise.all(
    ["A", "B"].map((objective) => rt.create({ role: "implementer", objective, isolation: "none" })),
  );
  await Promise.all(workers.map((rid) => rt.start(rid)));
  assert.notEqual(cli.startCalls[0]!.name, cli.startCalls[1]!.name);
  assert.notEqual(cli.startCalls[0]!.paneId, cli.startCalls[1]!.paneId);
});

test("waitFor never treats a still-working worker as settled", async () => {
  const cli = new FakeHerdrCli();
  const wait = cli.wait.bind(cli);
  cli.wait = async (target, until, timeout) => {
    assert.ok(!until.includes("working"));
    return wait(target, until, timeout);
  };
  const rt = new HerdrAgentRuntime({ cli });
  const rid = await rt.create({ role: "planner", objective: "A", isolation: "none" });
  await rt.sendTask(rid, "A");
  assert.equal((await rt.waitFor(rid, 5000)).status, "COMPLETED");
});

test("AgentRuntime contract: Herdr runtime passes all contract assertions", async () => {
  const rt = new HerdrAgentRuntime({ cli: new FakeHerdrCli(), maxContextTokens: 128_000 });
  await runAgentRuntimeContract(rt);
});

test("createAgentRuntime selects Herdr behind the flag and negotiates protocol", async () => {
  const cli = new FakeHerdrCli();
  const rt = await createAgentRuntime({ runtime: "herdr", herdrCli: cli, herdrMinProtocol: 20 });
  assert.equal(rt.capabilities.name, "herdr");
  assert.ok(rt.capabilities.remoteHosts);
  assert.ok(rt.capabilities.recovery);
  assert.ok(rt.capabilities.attach);
});

test("negotiation rejects a Herdr server below the minimum protocol", async () => {
  const cli = new FakeHerdrCli();
  cli.statusVal = { ok: true, serverVersion: "0.9.1", protocol: 12 };
  await assert.rejects(() => negotiateHerdr(cli, 20), /below required minimum 20/);
});

test("negotiation rejects an unreachable Herdr server", async () => {
  const cli = new FakeHerdrCli();
  cli.statusVal = { ok: false, serverVersion: "unreachable", protocol: 0 };
  await assert.rejects(() => negotiateHerdr(cli, 20), /unreachable/);
});

test("createAgentRuntime(runtime='herdr') requires herdrCli", async () => {
  await assert.rejects(() => createAgentRuntime({ runtime: "herdr" }), /requires herdrCli/);
});

test("interrupt maps to send_keys and terminate maps to pane close", async () => {
  const cli = new FakeHerdrCli();
  const rt = new HerdrAgentRuntime({ cli });
  const rid = await rt.create({ role: "engineer", objective: "long" });
  await rt.sendTask(rid, "long");
  assert.equal((await rt.interrupt(rid)).status, "INTERRUPTED");
  assert.equal(await rt.terminate(rid), true);
  assert.equal((await rt.get(rid))?.status, "TERMINATED");
});

test("a helper worker reports the worker that started it as its parent session", async () => {
  const { ControlPlaneIngest } = await import("../../src/runtime/herdr/ControlPlaneIngest.ts");
  const sent: Array<{ entity_id?: string; event_type?: string; payload?: Record<string, unknown> }> = [];
  const ingest = new ControlPlaneIngest({
    url: "http://cp",
    host: { hostId: "bender" },
    fetch: (async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  const rt = new HerdrAgentRuntime({ cli: new FakeHerdrCli(), maxContextTokens: 128_000, ingest });
  const lead = await rt.create({ role: "lead", objective: "x" });
  await rt.start(lead);
  const helper = await rt.create({ role: "helper", objective: "y", parentRuntimeId: lead });
  await rt.start(helper);
  await new Promise((r) => setTimeout(r, 20));
  const started = sent.filter((e) => e.event_type === "session.started");
  assert.equal(started.find((e) => e.entity_id === lead)?.payload?.parent_session_id, undefined);
  assert.equal(started.find((e) => e.entity_id === helper)?.payload?.parent_session_id, lead);
});

test("worker identity is exported into the pane before the agent starts (launcher runtime selection)", async () => {
  const order: string[] = [];
  const exported: Array<Record<string, string>> = [];
  class Spy extends FakeHerdrCli {
    async exportEnv(_pane: string, vars: Record<string, string>): Promise<void> {
      order.push("export");
      exported.push(vars);
    }
    async startAgent(paneId: string, kind: string, name: string): Promise<void> {
      order.push("start");
      await super.startAgent(paneId, kind, name);
    }
  }
  const rt = new HerdrAgentRuntime({ cli: new Spy(), maxContextTokens: 128_000 });
  const id = await rt.create({ role: "reviewer", objective: "x", missionId: "mission-7" });
  await rt.start(id);
  assert.deepEqual(order, ["export", "start"]);
  assert.deepEqual(exported[0], { PI_ENGINEERING_ROLE: "reviewer", PI_ENGINEERING_MISSION_ID: "mission-7" });
});

test("an env export failure never blocks the agent from starting", async () => {
  class Failing extends FakeHerdrCli {
    async exportEnv(): Promise<void> {
      throw new Error("pane busy");
    }
  }
  const rt = new HerdrAgentRuntime({ cli: new Failing(), maxContextTokens: 128_000 });
  const id = await rt.create({ role: "planner", objective: "x" });
  const w = await rt.start(id);
  assert.equal(w.status, "READY");
});
