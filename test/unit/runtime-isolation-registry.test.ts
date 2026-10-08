/**
 * Machine registry + generation-fenced leases (spec §6, §9–§11, §18, §34).
 * Real SQLite files, real processes for liveness; PID reuse and reboot are
 * simulated by forging the recorded process incarnation.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LeaseMissionCustody } from "../../src/runtime/isolation/MissionCustody.ts";
import { RecoveryManager } from "../../src/runtime/isolation/RecoveryManager.ts";
import { RuntimeRegistry } from "../../src/runtime/isolation/RuntimeRegistry.ts";
import { type ProcessIdentity, currentProcessIdentity } from "../../src/runtime/isolation/processIdentity.ts";
import { journalMode } from "../../src/runtime/isolation/sqlite.ts";

async function registryFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pi-eng-registry-")), "registry.db");
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

function forged(overrides: Partial<ProcessIdentity>): ProcessIdentity {
  return { ...currentProcessIdentity(), ...overrides };
}

function register(registry: RuntimeRegistry, sessionId: string, identity: ProcessIdentity = currentProcessIdentity()) {
  return registry.register({ sessionId, process: identity, startedAt: new Date().toISOString() });
}

describe("RuntimeRegistry", () => {
  it("uses WAL and issues a fresh generation on every registration", async () => {
    const registry = RuntimeRegistry.open(await registryFile());
    try {
      assert.equal(journalMode(registry.db), "WAL");
      const first = register(registry, "s-1");
      const second = register(registry, "s-1");
      assert.notEqual(first.generationId, second.generationId);
      assert.equal(registry.heartbeat("s-1", second.generationId), true);
      assert.equal(registry.heartbeat("s-1", first.generationId), false, "an old generation cannot heartbeat");
    } finally {
      registry.close();
    }
  });

  it("prevents session resurrection: a session declared dead cannot heartbeat its old generation back to life", async () => {
    const registry = RuntimeRegistry.open(await registryFile());
    try {
      const record = register(registry, "s-dead");
      assert.equal(registry.markDead(record, "orphaned"), true);
      assert.equal(registry.heartbeat("s-dead", record.generationId), false);
      assert.equal(registry.get("s-dead")?.state, "orphaned");
      assert.equal(
        registry.list().some((s) => s.sessionId === "s-dead"),
        false,
      );
    } finally {
      registry.close();
    }
  });

  it("assesses liveness from process incarnation: dead pid, reused pid (forged start time) and reboot are dead", async () => {
    const registry = RuntimeRegistry.open(await registryFile());
    try {
      const live = register(registry, "live");
      const gone = register(registry, "gone", forged({ pid: deadPid() }));
      const reused = register(registry, "reused", forged({ processStartTime: "1" }));
      const rebooted = register(registry, "rebooted", forged({ bootId: "00000000-0000-0000-0000-000000000000" }));
      assert.equal(registry.assess(live).verdict, "live");
      assert.deepEqual(registry.assess(gone), { verdict: "dead", reason: "pid_not_alive" });
      assert.deepEqual(registry.assess(reused), { verdict: "dead", reason: "pid_reused" });
      assert.deepEqual(registry.assess(rebooted), { verdict: "dead", reason: "rebooted" });
    } finally {
      registry.close();
    }
  });

  it("a stale heartbeat alone does not kill a verifiably live process", async () => {
    let now = Date.now();
    const registry = RuntimeRegistry.open(await registryFile(), { staleAfterMs: 1_000, now: () => now });
    try {
      const record = register(registry, "slow");
      now += 60_000;
      assert.equal(registry.assess(record).verdict, "live");
    } finally {
      registry.close();
    }
  });

  it("reboot simulation: startup reconciliation orphans sessions whose PIDs no longer exist and frees their leases", async () => {
    const file = await registryFile();
    const registry = RuntimeRegistry.open(file);
    try {
      const ghosts = [deadPid(), deadPid(), deadPid()];
      ghosts.forEach((pid, index) => {
        const record = register(registry, `ghost-${index}`, forged({ pid }));
        assert.equal(
          registry.leases.acquire(`wt#mission:M-${index}`, { sessionId: record.sessionId, process: forged({ pid }) })
            .ok,
          true,
        );
      });
      const self = register(registry, "self");
      const report = new RecoveryManager(registry, { selfSessionId: self.sessionId }).reconcile();
      assert.equal(report.orphanedSessions.length, 3);
      assert.equal(registry.leases.list().length, 0, "orphaned sessions' leases are released");
      assert.equal(registry.get("self")?.state, "healthy", "the reconciling session is untouched");
      const again = new RecoveryManager(registry, { selfSessionId: self.sessionId }).reconcile();
      assert.deepEqual(again.orphanedSessions, [], "reconciliation is idempotent");
    } finally {
      registry.close();
    }
  });
});

describe("LeaseManager", () => {
  it("is generation-fenced: an old holder can neither renew nor release a reclaimed lease (ABA)", async () => {
    const registry = RuntimeRegistry.open(await registryFile());
    try {
      const oldIdentity = forged({ pid: deadPid() });
      register(registry, "old", oldIdentity);
      const first = registry.leases.acquire("res", { sessionId: "old", process: oldIdentity });
      assert.equal(first.ok, true);
      register(registry, "new");
      const second = registry.leases.acquire("res", { sessionId: "new", process: currentProcessIdentity() });
      assert.ok(second.ok);
      assert.equal(second.reclaimed?.reason, "pid_not_alive");
      assert.ok(first.ok);
      assert.equal(registry.leases.renew("res", first.lease.generationId), false);
      assert.equal(registry.leases.release("res", first.lease.generationId), false, "old process cannot release");
      assert.equal(registry.leases.get("res")?.generationId, second.lease.generationId, "new lease intact");
    } finally {
      registry.close();
    }
  });

  it("PID reuse: a lease recorded with a forged start time for a live pid is reclaimed, never honored", async () => {
    const registry = RuntimeRegistry.open(await registryFile());
    try {
      const impostor = forged({ processStartTime: "1" });
      register(registry, "impostor", impostor);
      assert.equal(registry.leases.acquire("res", { sessionId: "impostor", process: impostor }).ok, true);
      register(registry, "me");
      const mine = registry.leases.acquire("res", { sessionId: "me", process: currentProcessIdentity() });
      assert.ok(mine.ok);
      assert.equal(mine.reclaimed?.reason, "pid_reused");
    } finally {
      registry.close();
    }
  });

  it("respects a lease held by a live session in another process", async () => {
    const file = await registryFile();
    const registry = RuntimeRegistry.open(file);
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const pid = holder.pid!;
      const start = (await import("../../src/runtime/isolation/processIdentity.ts")).readProcessStartTime(pid);
      assert.equal(start.state, "present");
      const identity = forged({ pid, processStartTime: start.state === "present" ? start.value : null });
      register(registry, "other", identity);
      assert.equal(registry.leases.acquire("res", { sessionId: "other", process: identity }).ok, true);
      register(registry, "me");
      const contended = registry.leases.acquire("res", { sessionId: "me", process: currentProcessIdentity() });
      assert.equal(contended.ok, false);
      holder.kill("SIGKILL");
      await new Promise((resolve) => holder.once("exit", resolve));
      const taken = registry.leases.acquire("res", { sessionId: "me", process: currentProcessIdentity() });
      assert.ok(taken.ok, "a SIGKILLed holder is reclaimed immediately");
      assert.equal(taken.reclaimed?.reason, "pid_not_alive");
    } finally {
      holder.kill("SIGKILL");
      registry.close();
    }
  });

  it("is re-entrant for the holding session and released with the session on unregister", async () => {
    const registry = RuntimeRegistry.open(await registryFile());
    try {
      const me = register(registry, "me");
      const first = registry.leases.acquire("res", { sessionId: "me", process: currentProcessIdentity() });
      const again = registry.leases.acquire("res", { sessionId: "me", process: currentProcessIdentity() });
      assert.ok(first.ok && again.ok);
      assert.equal(again.reentrant, true);
      assert.equal(again.lease.generationId, first.lease.generationId);
      registry.unregister("me", me.generationId);
      assert.equal(registry.leases.get("res"), undefined);
    } finally {
      registry.close();
    }
  });

  it("an unverifiable (remote-host) holder is displaced only after its lease expires", async () => {
    let now = Date.now();
    const registry = RuntimeRegistry.open(await registryFile(), { now: () => now, staleAfterMs: 10_000_000 });
    try {
      const remote = forged({ host: "some-other-host" });
      register(registry, "remote", remote);
      assert.equal(registry.leases.acquire("res", { sessionId: "remote", process: remote }, 5_000).ok, true);
      register(registry, "me");
      assert.equal(registry.leases.acquire("res", { sessionId: "me", process: currentProcessIdentity() }).ok, false);
      now += 6_000;
      const after = registry.leases.acquire("res", { sessionId: "me", process: currentProcessIdentity() });
      assert.ok(after.ok);
      assert.equal(after.reclaimed?.reason, "lease_expired");
    } finally {
      registry.close();
    }
  });

  it("LeaseMissionCustody namespaces resources and reports the live holder", async () => {
    const registry = RuntimeRegistry.open(await registryFile());
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const { readProcessStartTime } = await import("../../src/runtime/isolation/processIdentity.ts");
      const start = readProcessStartTime(holder.pid!);
      const other = forged({ pid: holder.pid!, processStartTime: start.state === "present" ? start.value : null });
      register(registry, "other-session-0000", other);
      register(registry, "me");
      const theirs = new LeaseMissionCustody(
        () => registry.leases,
        "ns",
        () => ({ sessionId: "other-session-0000", process: other }),
      );
      const mine = new LeaseMissionCustody(
        () => registry.leases,
        "ns",
        () => ({ sessionId: "me", process: currentProcessIdentity() }),
      );
      assert.deepEqual(await theirs.claim("mission:M"), { ok: true, reclaimed: false });
      const contended = await mine.claim("mission:M");
      assert.equal(contended.ok, false);
      assert.match(contended.ok ? "" : contended.holder, new RegExp(`pid ${holder.pid}`));
      assert.equal(registry.leases.get("ns#mission:M")?.sessionId, "other-session-0000");
      await theirs.release("mission:M");
      assert.equal((await mine.claim("mission:M")).ok, true);
    } finally {
      holder.kill("SIGKILL");
      registry.close();
    }
  });
});
