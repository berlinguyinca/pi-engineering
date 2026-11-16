/**
 * Child process for the Phase 5 recovery parity test: a real EngineeringRuntime running /engineer whose implementer
 * never finishes (legacy: an executor that never settles; omp: a real omp process whose scripted model never
 * answers), so the parent can SIGKILL the runtime mid-worker-run.
 *
 *   node parityRecoveryChild.ts <legacy|omp> <cwd>
 *
 * The omp path reads its flags, binary, isolated HOME and model server from the environment the parent gave it.
 */
import { selectOmpWorker } from "../../src/omp/selectWorker.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";

const [path, cwd] = process.argv.slice(2);
if (!path || !cwd) throw new Error("usage: parityRecoveryChild <legacy|omp> <cwd>");

let worker: WorkerExecutor;
if (path === "omp") {
  const picked = await selectOmpWorker(() => ({
    run: async () => {
      throw new Error("the legacy fallback must never run");
    },
  }));
  if (picked?.selection.path !== "omp") throw new Error("omp path not selected");
  worker = picked.executor;
} else {
  worker = new FakeWorkerExecutor({
    scout: () => ({ status: "completed", summary: "scouted", details: {} }),
    implementer: () => new Promise(() => {}),
  });
}
const rt = await EngineeringRuntime.open({ cwd, worker, verifier: new CommandVerifier() });
setInterval(() => {}, 60_000); // an executor that never settles must not let the event loop drain
process.stdout.write(`OPEN ${process.pid}\n`);
await rt.engineer("Implement add(a, b) to return the sum of a and b");
process.stdout.write("FINISHED\n");
await rt.close();
