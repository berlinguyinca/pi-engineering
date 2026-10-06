/**
 * A real Pi Engineering session in a child process, for multi-process
 * concurrency, crash and recovery tests. No mocks: it opens the real
 * EngineeringRuntime against a real git repository with the state dir it is
 * given, and reports what it saw as one JSON line on stdout.
 *
 *   node test/support/runtimeChild.ts <action> <cwd> [startAtEpochMs]
 *
 * Actions:
 *   open   open, create + fail one mission (a durable write), report, close
 *   hold   open, create one nonterminal mission, take custody + its lease,
 *          report, then idle until killed (SIGKILL tests)
 *   adopt  open and take over mission $PI_TEST_ADOPT_MISSION (custody + lease),
 *          report the acquired lease generation, close
 *   tear   like hold, but then start writing one more record and stop halfway
 *          through it (a writer killed mid-record)
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { RuntimeSession } from "../../src/runtime/isolation/RuntimeSession.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";

const [action, cwd, startAt] = process.argv.slice(2);

const worker: WorkerExecutor = {
  async run(req) {
    return {
      result: {
        status: "completed",
        summary: `worker ${req.role} done`,
        claims: [],
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
        details: {},
      },
      usage: null,
      toolCalls: 0,
    };
  },
};

async function waitUntil(epochMs: number): Promise<void> {
  const delay = epochMs - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

function report(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  // Never touch the developer's real ~/.local/state/pi-engineering.
  if (!process.env.PI_ENGINEERING_STATE_DIR) throw new Error("runtimeChild requires PI_ENGINEERING_STATE_DIR");
  if (!action || !cwd) throw new Error("usage: runtimeChild <open|hold|adopt|tear> <cwd> [startAt]");
  if (startAt) await waitUntil(Number(startAt));
  const openedAt = Date.now();
  const rt = await EngineeringRuntime.open({ cwd, worker, verifier: new CommandVerifier() });
  const store = rt.missionStore;
  if (!store || !rt.orchestrator) throw new Error("orchestrator not initialized");
  if (action === "adopt") {
    const target = process.env.PI_TEST_ADOPT_MISSION ?? "";
    const lease = await rt.missionOwnership!.acquire(target);
    const session = RuntimeSession.current();
    report({
      ok: true,
      action,
      pid: process.pid,
      sessionId: session.sessionId,
      missionId: target,
      adoptedGeneration: lease.generation,
      heldLeases:
        session
          .registry()
          ?.leases.list({ sessionId: session.sessionId })
          .map((l) => l.resourceId) ?? [],
      reconciliation: session.lastReconciliation,
      health: session.health.state,
    });
    await rt.close();
    return;
  }
  const mission = store.createMission({
    title: `child ${process.pid}`,
    goal: "concurrency probe",
    user_request: "concurrency probe",
    repository: cwd,
    base_ref: "",
    risk_profile: "low",
    workflow_class: "conversation",
  });
  if (action === "open") store.failMission(mission.mission_id, "probe complete");
  // A holder takes real custody + an in-store lease, like a dispatching mission.
  if (action === "hold" || action === "tear") await rt.missionOwnership?.acquire(mission.mission_id);
  await store.flush();
  if (action === "tear" && rt.runtimeBinding?.eventsDir) {
    const stream = join(rt.runtimeBinding.eventsDir, `${RuntimeSession.current().sessionId}.jsonl`);
    appendFileSync(stream, '{"event_id":"oevt-torn","timestamp":"2026-10-06T00:00:00.000Z","type":"mission.upd');
  }
  const session = RuntimeSession.current();
  const registry = session.registry();
  report({
    ok: true,
    action,
    pid: process.pid,
    sessionId: session.sessionId,
    missionId: mission.mission_id,
    worktreeId: rt.runtimeBinding?.identity.worktreeId ?? null,
    bindingKind: rt.runtimeBinding?.kind ?? null,
    eventsDir: rt.runtimeBinding?.eventsDir ?? null,
    visibleMissions: store.listMissions().map((m) => m.mission_id),
    heldLeases: registry?.leases.list({ sessionId: session.sessionId }).map((lease) => lease.resourceId) ?? [],
    reconciliation: session.lastReconciliation,
    health: session.health.state,
    openMs: Date.now() - openedAt,
  });
  if (action === "hold" || action === "tear") {
    // Stay alive (as a live custodian) until the test kills us.
    setInterval(() => undefined, 60_000);
    return;
  }
  await rt.close();
}

main().catch((error: unknown) => {
  report({ ok: false, pid: process.pid, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
