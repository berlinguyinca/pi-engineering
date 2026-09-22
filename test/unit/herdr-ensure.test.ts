/**
 * Opt-in Herdr local-environment helper tests (herdr spec 03).
 *
 * Proves Pi-Engineering does NOT auto-install on its own: detection is
 * side-effect-free, and the install command only runs when the operator
 * explicitly supplies BOTH `installCommand` and `autoInstall: true`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HerdrAgent, HerdrCli, HerdrStatus } from "../../src/runtime/herdr/HerdrCli.ts";
import { herdrEnsureLocal } from "../../src/runtime/herdr/ensureHerdr.ts";

class StubCli implements HerdrCli {
  statusVal: HerdrStatus = { ok: true, serverVersion: "0.9.1", protocol: 22 };
  statusCalls = 0;
  async status(): Promise<HerdrStatus> {
    this.statusCalls++;
    return this.statusVal;
  }
  async listAgents() {
    return [];
  }
  async getAgent() {
    return null;
  }
  async readAgent() {
    return "";
  }
  async prompt() {}
  async wait(): Promise<HerdrAgent> {
    return { agent_status: "idle", cwd: "", pane_id: "", workspace_id: "", revision: 0, state_change_seq: 0 };
  }
  async startAgent() {}
  async sendKeys() {}
  async closePane() {}
  async createWorktree(repo: string) {
    return { workspaceId: "w", path: repo };
  }
}

test("herdrEnsureLocal reports ok when binary present and server healthy", async () => {
  const cli = new StubCli();
  const res = await herdrEnsureLocal({ cli });
  assert.equal(res.ok, true);
  assert.equal(res.action, "ok");
  assert.equal(res.detection.serverRunning, true);
  assert.equal(res.detection.status?.protocol, 22);
});

test("herdrEnsureLocal flags start-server when binary present but server unreachable", async () => {
  const cli = new StubCli();
  // Force status to fail.
  cli.statusVal = { ok: false, serverVersion: "unreachable", protocol: 0 };
  // Simulate unreachable by throwing: replace status.
  const orig = cli.status.bind(cli);
  cli.status = async () => {
    throw new Error("socket not found");
  };
  const res = await herdrEnsureLocal({ cli });
  assert.equal(res.ok, false);
  assert.equal(res.action, "start-server");
  assert.match(res.message, /server not reachable|install/i);
  cli.status = orig;
});

test("herdrEnsureLocal reports install-needed and does NOT auto-install by default", async () => {
  // Binary missing is detected by a stub that is also missing; we simulate by
  // forcing detection to false via a bin name that cannot exist.
  const res = await herdrEnsureLocal({
    cli: new StubCli(),
    bin: "__definitely_not_a_real_binary__",
    installCommand: "echo SHOULD_NOT_RUN > /tmp/should-not-exist-herdr-test",
  });
  assert.equal(res.ok, false);
  assert.equal(res.action, "install-needed");
  assert.match(res.message, /not installed|install/i);
});

test("herdrEnsureLocal only installs with BOTH installCommand and autoInstall=true", async () => {
  // With autoInstall false (the default), even a supplied command must not run.
  const marker = `/tmp/herdr-autoininstall-${Date.now()}`;
  try {
    const res = await herdrEnsureLocal({
      cli: new StubCli(),
      bin: "__definitely_not_a_real_binary__",
      installCommand: `echo ran > ${marker}`,
      autoInstall: false,
    });
    assert.equal(res.ok, false);
    assert.equal(res.action, "install-needed");
    // The command must NOT have run.
    await assert.rejects(() => import("node:fs/promises").then((fs) => fs.access(marker)));
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(marker, { force: true });
  }
});

test("herdrEnsureLocal enforces minimum protocol", async () => {
  const cli = new StubCli();
  cli.statusVal = { ok: true, serverVersion: "0.9.1", protocol: 12 };
  const res = await herdrEnsureLocal({ cli, minProtocol: 20 });
  assert.equal(res.ok, false);
  assert.match(res.message, /below required minimum/);
});
