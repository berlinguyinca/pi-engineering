/**
 * One contender in the multi-process coordination race (spec §34).
 *
 *   node test/support/leaseRaceChild.ts <registryFile> <occupancyDir> <iterations> <startAt> <resources>
 *
 * Randomly interleaves register / heartbeat / lease acquire / renew / release
 * (including stale releases of old generations) / rebind / reconcile /
 * re-registration. Mutual exclusion is verified with REAL filesystem
 * side effects: while a lease is held the holder creates
 * `<occupancyDir>/<resource>` with O_EXCL; a second simultaneous holder would
 * hit EEXIST. Reports violations as one JSON line.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RecoveryManager } from "../../src/runtime/isolation/RecoveryManager.ts";
import { RuntimeRegistry } from "../../src/runtime/isolation/RuntimeRegistry.ts";
import { currentProcessIdentity } from "../../src/runtime/isolation/processIdentity.ts";

const [registryFile, occupancyDir, iterationsArg, startAtArg, resourcesArg] = process.argv.slice(2);
const iterations = Number(iterationsArg);
const resources = Number(resourcesArg);

/**
 * "The registry's write lock stayed taken for the whole bounded wait (2 s)": a SqliteBusyError from a transaction, or the
 * raw SQLITE_BUSY ("database is locked") from a statement outside one. The registry's contract (sqlite.ts) is that this
 * is transient and the caller retries on its next tick. With 24 contenders on a loaded host it is expected, so it is
 * counted, never an invariant violation or a crash; every other error still propagates and fails the child.
 */
function isBusy(error: unknown): boolean {
  return /SQLITE_BUSY|database is locked|registry busy/i.test(error instanceof Error ? error.message : String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (!registryFile || !occupancyDir) throw new Error("usage");
  const delay = Number(startAtArg) - Date.now();
  if (delay > 0) await sleep(delay);
  const sessionId = randomUUID();
  const identity = currentProcessIdentity();
  // Joining and leaving are not part of the race; a busy registry there is retried until it answers.
  const untilNotBusy = async <T>(fn: () => T): Promise<T> => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        return fn();
      } catch (error) {
        if (!isBusy(error) || Date.now() > deadline) throw error;
        await sleep(20 + Math.floor(Math.random() * 50));
      }
    }
  };
  const registry = await untilNotBusy(() => RuntimeRegistry.open(registryFile));
  let generation = (
    await untilNotBusy(() => registry.register({ sessionId, process: identity, startedAt: new Date().toISOString() }))
  ).generationId;
  const owner = { sessionId, process: identity };
  const violations: string[] = [];
  const stats = { acquired: 0, contended: 0, reclaimed: 0, staleReleaseRejected: 0, reregistered: 0, busy: 0, ops: 0 };
  const oldGenerations = new Map<string, string>();

  const occupancy = (resource: string) => join(occupancyDir, encodeURIComponent(resource));

  /**
   * Create the occupancy marker. A leftover marker is only legitimate if its
   * writer is gone (SIGKILLed inside the critical section); a marker of a
   * LIVE session means two live holders at once — a mutual-exclusion breach.
   */
  const enterCriticalSection = (resource: string): boolean => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(occupancy(resource), sessionId, { flag: "wx" });
        return true;
      } catch {
        let holder = "";
        try {
          holder = readFileSync(occupancy(resource), "utf8");
        } catch {
          continue;
        }
        if (holder && holder !== sessionId && !registry.isSessionLive(holder)) {
          rmSync(occupancy(resource), { force: true });
          continue;
        }
        violations.push(`double holder on ${resource}: ${sessionId} vs ${holder || "?"}`);
        return false;
      }
    }
    violations.push(`could not enter ${resource}`);
    return false;
  };

  /**
   * SqliteBusyError is the registry's documented transient (sqlite.ts): another process held the write lock for the
   * whole bounded wait (2 s). With 24 contenders on a loaded host that is expected, and the contract is "retry on the
   * next tick" - not "the session is gone". It is counted, never treated as an invariant violation or a crash; every
   * other error still propagates and fails the child.
   */
  for (let i = 0; i < iterations; i++) {
    // The marker is only meaningful while the lease is held: if the iteration is cut short by a busy registry the
    // marker must not outlive it, or the next holder would read it as a second live holder.
    let marker: string | null = null;
    const body = async (): Promise<void> => {
      stats.ops++;
      const resource = `res-${Math.floor(Math.random() * resources)}`;
      const roll = Math.random();
      if (roll < 0.55) {
        const outcome = registry.leases.acquire(resource, owner, 2_000);
        if (!outcome.ok) {
          stats.contended++;
          return;
        }
        stats.acquired++;
        if (outcome.reclaimed) stats.reclaimed++;
        if (!enterCriticalSection(resource)) return;
        marker = resource;
        await sleep(Math.floor(Math.random() * 3));
        if (!registry.leases.renew(resource, outcome.lease.generationId, 2_000)) {
          violations.push(`lost lease ${resource} while holding it`);
        }
        rmSync(occupancy(resource), { force: true });
        marker = null;
        if (Math.random() < 0.8) {
          registry.leases.release(resource, outcome.lease.generationId);
          oldGenerations.set(resource, outcome.lease.generationId);
        }
      } else if (roll < 0.65) {
        // Stale release: an old generation must never remove a newer lease.
        const old = oldGenerations.get(resource);
        if (!old) return;
        const current = registry.leases.get(resource);
        if (current && current.generationId !== old) {
          if (registry.leases.release(resource, old)) violations.push(`stale generation released ${resource}`);
          else stats.staleReleaseRejected++;
        }
      } else if (roll < 0.8) {
        if (!registry.heartbeat(sessionId, generation)) {
          // We are alive with a verifiable incarnation: nobody may orphan us.
          violations.push(`live session ${sessionId} was declared dead`);
          generation = registry.register({
            sessionId,
            process: identity,
            startedAt: new Date().toISOString(),
          }).generationId;
        }
      } else if (roll < 0.88) {
        registry.rebind(sessionId, generation, {
          repoId: "repo",
          worktreeId: `wt-${Math.floor(Math.random() * 3)}`,
          worktreePath: `/wt/${i}`,
          runtimePath: null,
        });
      } else if (roll < 0.97) {
        new RecoveryManager(registry, { selfSessionId: sessionId }).reconcile();
      } else {
        // Re-registration issues a NEW generation; the old one is dead for good.
        const previous = generation;
        generation = registry.register({
          sessionId,
          process: identity,
          startedAt: new Date().toISOString(),
        }).generationId;
        stats.reregistered++;
        if (generation === previous) violations.push("re-registration reused a generation");
        if (registry.heartbeat(sessionId, previous)) violations.push("an old generation was resurrected");
      }
    };
    await body().catch((error: unknown) => {
      if (!isBusy(error)) throw error;
      stats.busy++;
      if (marker) rmSync(occupancy(marker), { force: true });
    });
  }

  await untilNotBusy(() => registry.unregister(sessionId, generation));
  registry.close();
  process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid, sessionId, violations, stats })}\n`);
}

main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ ok: false, pid: process.pid, error: String(error) })}\n`);
  process.exit(1);
});
