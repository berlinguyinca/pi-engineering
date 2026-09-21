/**
 * CAV-16 Concurrency and Isolation: safe parallel workers, ephemeral ports,
 * isolated test data and collision-free ledger writes.
 *
 * Reconciles with the existing EventStore (concurrency-safe append chain) and
 * the git-worktree isolation machinery. This helper provides an ephemeral-port
 * allocator and a parallel-ledger-write runner so parallel CAV work does not
 * collide on ports or corrupt the evidence ledger.
 */
import type { CavEvidenceLedger } from "./evidence.ts";

export interface EphemeralPort {
  port: number;
  release: () => void;
}

/** Reserve an ephemeral, currently-unused port from a deterministic range. */
export async function reserveEphemeralPort(
  range: [number, number],
  isFree: (port: number) => Promise<boolean>,
): Promise<EphemeralPort> {
  const [lo, hi] = range;
  // Try a bounded number of candidates; fail closed if none is free.
  for (let i = 0; i < 100; i++) {
    const port = lo + Math.floor(Math.random() * (hi - lo + 1));
    if (await isFree(port)) return { port, release: () => {} };
  }
  throw new Error(`no free ephemeral port in range ${lo}-${hi}`);
}

export interface ParallelWriteResult {
  written: number;
  uniqueRunIds: number;
  noCorruption: boolean;
}

/**
 * Run many parallel evidence writes against the ledger and assert the append
 * chain keeps them collision-free and lossless (EventStore serializes appends).
 */
export async function parallelLedgerWrites(
  ledger: CavEvidenceLedger,
  requirementId: string,
  count: number,
): Promise<ParallelWriteResult> {
  const writes = Array.from({ length: count }, (_, i) =>
    ledger.record(requirementId, "SPECIFIED", {
      gitSha: "x",
      role: i % 2 ? "implementer" : "reviewer",
      workerRunId: `RUN-${i}`,
      gateType: "concurrency",
      tool: "node",
      command: "parallel",
      exitCode: 0,
    }),
  );
  await Promise.all(writes);
  const all = ledger.all().filter((r) => r.requirement_id === requirementId);
  const uniqueRunIds = new Set(all.map((r) => r.worker_run_id)).size;
  return { written: all.length, uniqueRunIds, noCorruption: all.length === count && uniqueRunIds === count };
}
