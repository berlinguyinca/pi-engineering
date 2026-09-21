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
  async prompt(target: string, _text: string): Promise<void> {
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
  async startAgent(paneId: string, _kind: string, _name: string): Promise<void> {
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
  async createWorktree(repo: string): Promise<{ workspaceId: string; path: string }> {
    return { workspaceId: "wt1", path: `${repo}-wt` };
  }
}

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
