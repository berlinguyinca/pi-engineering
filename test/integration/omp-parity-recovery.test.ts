/**
 * Phase 5 recovery parity: SIGKILL the PE runtime process in the middle of a worker run, reopen the repository and
 * compare what the ledger recorded on the omp path with the legacy path. Real processes throughout (a Node child
 * running a real EngineeringRuntime; on the omp path a real omp process talking to a scripted model that never
 * answers the implementer). Gated on OMP_BIN.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { legacyPath } from "../support/legacyGolden.ts";
import { engineerModelScript, realOmpEnv, startOfflineOmp } from "../support/ompOffline.ts";

const real = realOmpEnv();
const skip = real ? false : "UNVERIFIED: OMP_BIN not set; no real omp available";
const CHILD = join(fileURLToPath(new URL(".", import.meta.url)), "..", "support", "parityRecoveryChild.ts");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** pid -> ppid for every process, to walk a process tree (omp workers run in their own process group). */
function descendants(root: number): number[] {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift() as number;
    for (const [pid, ppid] of rows) {
      if (ppid === parent && !out.includes(pid)) {
        out.push(pid);
        queue.push(pid);
      }
    }
  }
  return out;
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface Outcome {
  /** Ledger event types after the kill, before the reopen. */
  afterKill: string[];
  /** Ledger event types after reopening and recording one more fact. */
  afterReopen: string[];
  /** Same, after a torn tail was left behind and the repository was reopened again. */
  afterTornReopen: string[];
  /** In-flight run handled: an agent.started with no terminal agent.* for the same run. */
  inFlight: number;
  orphans: number[];
}

async function killMidWorkerRun(path: "legacy" | "omp"): Promise<Outcome> {
  const fx = await makeFixtureRepo();
  // The omp script: the scout answers; the implementer's model call never returns.
  const answer = engineerModelScript({});
  const offline =
    path === "omp"
      ? await startOfflineOmp((turn) => (/# Role: implementer/.test(turn.system) ? { kind: "hang" } : answer(turn)))
      : undefined;
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["--experimental-strip-types", CHILD, path, fx.root], {
      env: { ...(offline?.env ?? process.env) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const out: string[] = [];
    child.stdout?.on("data", (b: Buffer) => out.push(String(b)));
    // Wait for the implementer's agent.started (and, on omp, for a real omp process under the child).
    const deadline = Date.now() + 90_000;
    let omp: number[] = [];
    for (;;) {
      if (child.exitCode !== null) throw new Error(`child exited early (${child.exitCode}); said ${out.join("")}`);
      if (Date.now() > deadline) throw new Error(`no in-flight implementer; child said ${out.join("")}`);
      const types = (await legacyPath.readEvents(fx.root, { tornLinesExpected: true })).filter(
        (e) => e.type === "agent.started" && (e.payload as { role?: string } | undefined)?.role === "implementer",
      );
      if (child.pid !== undefined) omp = descendants(child.pid);
      if (types.length > 0 && (path === "legacy" || omp.length > 0)) break;
      await sleep(150);
    }
    await sleep(300);
    if (child.pid !== undefined) omp = descendants(child.pid);
    child.kill("SIGKILL");
    await new Promise((r) => child?.once("exit", r));
    await sleep(2500); // an omp worker that notices its parent died exits on its own
    const orphans = omp.filter(alive);
    for (const pid of orphans) {
      try {
        process.kill(pid, "SIGKILL"); // never leave a stray behind, whatever the assertion says
      } catch {}
    }

    const types = async (opts?: { tornLinesExpected?: boolean }) =>
      (await legacyPath.readEvents(fx.root, opts)).map((e) => e.type);
    const afterKill = await types({ tornLinesExpected: true });
    const events = await legacyPath.readEvents(fx.root, { tornLinesExpected: true });
    const inFlight =
      events.filter((e) => e.type === "agent.started").length -
      events.filter((e) => e.type === "agent.completed" || e.type === "agent.failed").length;

    const reopen = async (): Promise<void> => {
      const rt = await EngineeringRuntime.open({
        cwd: fx.root,
        worker: new FakeWorkerExecutor({}),
        verifier: new CommandVerifier(),
      });
      try {
        await rt.ledger.createWorkItem("after recovery", "low", [fx.root], { type: "system" });
      } finally {
        await rt.close();
      }
    };
    await reopen();
    const afterReopen = await types({ tornLinesExpected: true });
    await legacyPath.tearLedgerTail(fx.root);
    await reopen();
    const afterTornReopen = await types({ tornLinesExpected: true });
    return { afterKill, afterReopen, afterTornReopen, inFlight, orphans };
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await offline?.close();
    await fx.cleanup();
  }
}

describe("recovery after SIGKILL mid worker run: omp path equals legacy", { skip, timeout: 300_000 }, () => {
  it("ledger replays, the in-flight run is handled the same way, torn tail unchanged, no orphan omp", async () => {
    const legacy = await killMidWorkerRun("legacy");
    const omp = await killMidWorkerRun("omp");
    assert.ok(legacy.afterKill.includes("agent.started"), "legacy recorded the in-flight run");
    assert.equal(legacy.inFlight, 1, "legacy left exactly one run in flight");
    assert.deepEqual(omp.afterKill, legacy.afterKill, "event types at the moment of the kill");
    assert.deepEqual(omp.afterReopen, legacy.afterReopen, "ledger replays and accepts new facts");
    assert.deepEqual(omp.afterTornReopen, legacy.afterTornReopen, "torn-tail handling");
    assert.equal(omp.inFlight, legacy.inFlight, "the unfinished run is left unfinished the same way");
    assert.deepEqual(omp.orphans, [], "no omp process survives the PE process");
  });
});
