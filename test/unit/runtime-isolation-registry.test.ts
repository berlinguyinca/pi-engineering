/**
 * Machine registry + generation-fenced leases (spec §6, §9–§11, §18, §34).
 * Real SQLite files, real processes for liveness; PID reuse and reboot are
 * simulated by forging the recorded process incarnation.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LeaseMissionCustody } from "../../src/runtime/isolation/MissionCustody.ts";
import { RecoveryManager } from "../../src/runtime/isolation/RecoveryManager.ts";
import { RuntimeRegistry } from "../../src/runtime/isolation/RuntimeRegistry.ts";
import {
  type ProcessIdentity,
  currentProcessIdentity,
  readBootId,
  readProcessStartTime,
} from "../../src/runtime/isolation/processIdentity.ts";
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
  it("opens read-only in a way that actually blocks writes and never creates a file", async () => {
    const file = await registryFile();
    const writer = RuntimeRegistry.open(file);
    try {
      register(writer, "s-ro");
      writer.leases.acquire("worktree:ro", { sessionId: "s-ro", process: currentProcessIdentity() }, 60_000);
    } finally {
      writer.close();
    }

    const reader = RuntimeRegistry.openReadOnly(file);
    try {
      assert.equal(reader.leases.list().length, 1, "reads work while no writer holds the lock");
      // node:sqlite's openReadOnly flag does not block writes on Node 26; query_only does.
      assert.throws(() => reader.db.exec("DELETE FROM leases"), /readonly|query only|error/iu);
      assert.throws(
        () => reader.leases.acquire("worktree:other", { sessionId: "s-ro", process: currentProcessIdentity() }, 60_000),
        /readonly|query only|error/iu,
      );
      assert.equal(reader.leases.list().length, 1, "the failed writes wrote nothing");
    } finally {
      reader.close();
    }

    // A path that does not exist is an error, and must not be created — neither the
    // file nor its directory — because a status command with a mistyped path has no
    // business leaving a registry behind.
    const dir = await mkdtemp(join(tmpdir(), "pi-eng-registry-missing-"));
    const missing = join(dir, "absent", "registry.db");
    await assert.rejects(async () => RuntimeRegistry.openReadOnly(missing), /never creates one|no database at/iu);
    assert.equal(existsSync(missing), false);
    assert.equal(existsSync(join(dir, "absent")), false);

    // A database that exists but is not a pi-engineering registry says so.
    const partial = await registryFile();
    const maker = RuntimeRegistry.open(partial);
    maker.db.exec("DROP TABLE leases");
    maker.close();
    assert.throws(() => RuntimeRegistry.openReadOnly(partial), /no leases table/iu);
  });

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

  it("a stale unregister cannot release the current generation's leases", async () => {
    const registry = RuntimeRegistry.open(await registryFile());
    try {
      const old = register(registry, "same-session");
      const current = register(registry, "same-session");
      const owned = registry.leases.acquire("res", {
        sessionId: current.sessionId,
        process: currentProcessIdentity(),
      });
      assert.ok(owned.ok);
      assert.equal(registry.unregister(old.sessionId, old.generationId), false);
      assert.equal(registry.get(current.sessionId)?.state, "healthy");
      assert.equal(registry.leases.get("res")?.generationId, owned.lease.generationId);
      register(registry, "contender");
      assert.equal(
        registry.leases.acquire("res", {
          sessionId: "contender",
          process: currentProcessIdentity(),
        }).ok,
        false,
        "the live owner remains exclusive after stale shutdown",
      );
      assert.equal(registry.unregister(current.sessionId, current.generationId), true);
      assert.equal(registry.leases.get("res"), undefined);
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
      // Whether this host can read an incarnation at all decides which DEATH reason is
      // provable: `/proc/<pid>/stat` gives the start time that distinguishes "the pid is
      // gone" from "the pid is a different process". Where it cannot be read (macOS), both
      // land on pid_not_alive. The safety property — a mismatched or missing incarnation is
      // dead, never alive — holds on every platform; only the reason name differs.
      const incarnationReadable = readProcessStartTime(process.pid).state === "present";
      const live = register(registry, "live");
      const gone = register(registry, "gone", forged({ pid: deadPid() }));
      const reused = register(registry, "reused", forged({ processStartTime: "1" }));
      const rebooted = register(registry, "rebooted", forged({ bootId: "00000000-0000-0000-0000-000000000000" }));
      // A reboot is provable only where a boot id exists. Without one, a record written
      // before the restart looks like any other live-pid-but-unproven session, and what
      // unblocks the resource is lease expiry — so the assertion runs where the platform
      // can actually make the proof, and the rest of this test keeps checking the reasons
      // that are provable everywhere.
      const bootIdReadable = readBootId() !== null;
      assert.equal(registry.assess(live).verdict, "live");
      assert.deepEqual(registry.assess(gone), { verdict: "dead", reason: "pid_not_alive" });
      assert.deepEqual(registry.assess(reused), {
        verdict: "dead",
        reason: incarnationReadable ? "pid_reused" : "pid_not_alive",
      });
      if (bootIdReadable) assert.deepEqual(registry.assess(rebooted), { verdict: "dead", reason: "rebooted" });
      else
        assert.equal(
          registry.assess(rebooted).verdict,
          "live",
          "no boot id, no proof — doctor surfaces it as unverified",
        );
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
      // Where the incarnation is readable, a live process is simply live and the gap is
      // irrelevant. Where it is not (no /proc), the honest verdict is `uncertain` — still
      // not `dead`, which is the property this test exists to protect.
      if (readProcessStartTime(process.pid).state === "present") assert.equal(registry.assess(record).verdict, "live");
      else assert.deepEqual(registry.assess(record), { verdict: "uncertain", reason: "heartbeat_expired_unverified" });
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
      assert.ok(mine.ok, "a holder whose recorded incarnation does not match its live pid is never honored");
      // The reclaim itself is the safety property; the reason name depends on whether this
      // host can read an incarnation to prove reuse (Linux) or only that the recorded
      // identity is unverifiable (no /proc).
      assert.equal(
        mine.reclaimed?.reason,
        readProcessStartTime(process.pid).state === "present" ? "pid_reused" : "pid_not_alive",
      );
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
      // On a host without /proc the start time cannot be read, and the holder is then
      // live-but-unverifiable rather than verifiably live. The lease must be honoured in
      // both cases, so the assertion below is the one that matters on every platform.
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

  it("a heartbeat gap alone never kills a live holder; where the incarnation is provable, custody survives expiry", async () => {
    let now = Date.now();
    const registry = RuntimeRegistry.open(await registryFile(), { now: () => now });
    try {
      register(registry, "live-owner");
      const held = registry.leases.acquire("res", { sessionId: "live-owner", process: currentProcessIdentity() });
      assert.ok(held.ok);
      now += 12 * 60 * 60_000;
      // The gap on its own must not read as death, on any platform.
      assert.notEqual(registry.assess(registry.get("live-owner")!).verdict, "dead");
      register(registry, "contender");
      const challenged = registry.leases.acquire("res", {
        sessionId: "contender",
        process: currentProcessIdentity(),
      });
      if (readProcessStartTime(process.pid).state === "present") {
        // With an incarnation proof the holder is identified, not merely alive: nothing
        // displaces it, not even a lease that timed out while it kept working.
        assert.equal(challenged.ok, false);
        assert.deepEqual(registry.leases.reapStale(), []);
        assert.equal(registry.leases.get("res")?.generationId, held.lease.generationId);
      } else {
        // Without one, the lease TTL is what bounds a possibly-recycled pid: it may be
        // taken, and only ever for being expired — never because the holder "died".
        assert.equal(challenged.ok, true);
        assert.equal(challenged.reclaimed?.reason, "lease_expired");
      }
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
