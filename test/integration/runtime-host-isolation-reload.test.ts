/**
 * Runtime isolation through a REAL Host reload (zero-config spec §32 with the
 * live self-update Host): the real package, loaded by Pi's own extension
 * loader from the Host entry, reloaded with `/engineering reload`.
 *
 * A Host reload imports the runtime from a fresh snapshot directory (a second
 * module graph in the same process) and replays session_shutdown/session_start
 * into the old/new generation. Through that, the logical session must keep its
 * id, its registry generation (no false stale registration), the leases it
 * holds, and its single event writer. The commands every merged feature adds
 * are forwarded by the Host exactly once and keep routing after the reload.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { RuntimeSession } from "../../src/runtime/isolation/RuntimeSession.ts";
import { listStreamFiles } from "../../src/runtime/isolation/SessionEventStore.ts";
import { worktreeRuntimeDir } from "../../src/runtime/isolation/stateDir.ts";
import { runtimeStatus } from "../../src/runtime/isolation/status.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeGitRepo } from "../support/childSessions.ts";
import { startPiSession } from "../support/piSession.ts";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const hostEntry = join(repoRoot, "src/runtime/host/extension.ts");

const ENV_KEYS = [
  "HOME",
  "PI_ENGINEERING_HOME",
  "PI_ENGINEERING_STATE_DIR",
  "PI_ENGINEERING_CONTROL_DIR",
  "PI_SELF_UPDATE",
  "PI_PANEL_AUTO_OPEN",
  "PI_PANEL_NARRATOR",
  "PI_ENGINEERING_UPDATE_CHECK",
] as const;
const saved: Record<string, string | undefined> = {};
let root = "";

before(() => {
  root = mkdtempSync(join(tmpdir(), "rt-host-isolation-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Nothing under the operator's real home, install root or state dir.
  process.env.HOME = join(root, "home");
  process.env.PI_ENGINEERING_HOME = join(root, "install");
  process.env.PI_ENGINEERING_STATE_DIR = join(root, "state");
  process.env.PI_ENGINEERING_CONTROL_DIR = join(root, "control");
  process.env.PI_SELF_UPDATE = "0";
  process.env.PI_PANEL_AUTO_OPEN = "0";
  process.env.PI_PANEL_NARRATOR = "0";
  process.env.PI_ENGINEERING_UPDATE_CHECK = "0";
});

after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const MERGED_COMMANDS = [
  // live self-update Host
  "engineering",
  // runtime isolation
  "pi-engineering",
  // planner/worker execution
  "engineering-mode",
  "engineering-status",
  "engineering-plan",
  "engineering-workers",
  // existing feature commands (mission also carries `/mission resume PW-…`)
  "mission",
  "engineer",
];

test("a Host reload keeps the session id, registry generation, leases and single event writer; merged commands forward once", async () => {
  const repo = await makeGitRepo(join(root, "repo"));
  const pi = await startPiSession({ extensionPaths: [hostEntry], cwd: repo });
  let runtime: EngineeringRuntime | undefined;
  try {
    const commands = pi.piCommands();
    for (const name of MERGED_COMMANDS) {
      assert.equal(commands.filter((c) => c === name).length, 1, `/${name} registered exactly once`);
    }

    // The generation opens its runtime for the repository and registers the session.
    await pi.run("/pi-engineering status");
    const session = RuntimeSession.current();
    const before = runtimeStatus({ session });
    assert.ok(session.generationId, "the session is registered");
    assert.equal(before.eventWriter, "session-local");
    assert.ok(before.worktreeId, "bound to the repository worktree");
    const sessionId = session.sessionId;
    const registryGeneration = session.generationId;

    // Durable work owned by this session: a mission and its ownership lease.
    runtime = await EngineeringRuntime.open({ cwd: repo, worker: new FakeWorkerExecutor({}) });
    const mission = runtime.missionStore!.createMission({
      title: "survives a host reload",
      goal: "keep ownership across /engineering reload",
      user_request: "keep ownership across /engineering reload",
      repository: repo,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "conversation",
    });
    const lease = await runtime.missionOwnership!.acquire(mission.mission_id);
    await runtime.missionStore!.flush();
    const sessionLeases = () => session.registry()?.leases.list({ sessionId }) ?? [];
    const leasesBefore = sessionLeases();
    assert.ok(leasesBefore.length > 0, "the session holds a registry lease");

    // A forwarded planner/worker command writes repository state before the reload.
    await pi.run("/engineering-mode single");

    await pi.run("/engineering reload");
    await pi.run("/pi-engineering status");

    const afterSession = RuntimeSession.current();
    assert.equal(afterSession.sessionId, sessionId, "session identity survives the Host reload");
    assert.equal(afterSession.generationId, registryGeneration, "no re-registration, no false stale generation");
    const live = afterSession.registry()?.list() ?? [];
    assert.deepEqual(
      live.map((record) => record.sessionId),
      [sessionId],
      "exactly one live session row for this process",
    );
    assert.equal(afterSession.heartbeat(), true, "the session keeps heartbeating after the reload");
    assert.deepEqual(
      sessionLeases().map((l) => [l.resourceId, l.generationId]),
      leasesBefore.map((l) => [l.resourceId, l.generationId]),
      "the reload neither released nor fenced the session's leases",
    );
    const renewed = await runtime.missionOwnership!.acquire(mission.mission_id);
    assert.equal(renewed.generation, lease.generation, "ownership is still this session's, not re-taken");

    // One writer: the session appends through one stream, before and after.
    runtime.missionStore!.createMission({
      title: "after reload",
      goal: "write through the same stream",
      user_request: "x",
      repository: repo,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "conversation",
    });
    await runtime.missionStore!.flush();
    const eventsDir = join(worktreeRuntimeDir(process.env.PI_ENGINEERING_STATE_DIR!, before.worktreeId!), "events");
    const streams = listStreamFiles(eventsDir).filter((name) => !name.startsWith("legacy-"));
    assert.deepEqual(streams, [`${sessionId}.jsonl`], "exactly one writer stream for the session");
    const sequences = readFileSync(join(eventsDir, streams[0]!), "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { sequence: number }).sequence);
    assert.deepEqual(
      sequences,
      sequences.map((_, index) => index + 1),
      "one writer: sequence numbers are contiguous with no duplicates",
    );

    // Forwarded commands route to the new generation, which reads the same state.
    const afterCommands = pi.piCommands();
    assert.equal(afterCommands.length, new Set(afterCommands).size, "no duplicated command registrations");
    const storedMode = () =>
      (JSON.parse(readFileSync(join(repo, ".pi-eng", "planner-worker", "mode.json"), "utf8")) as { mode?: string })
        .mode;
    assert.equal(storedMode(), "single", "state written by the old generation is intact");
    await pi.run("/engineering-mode planner-worker");
    assert.equal(storedMode(), "planner-worker", "the forwarded command reached the new generation");
    const events = readFileSync(join(root, "install", "telemetry", "runtime-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string });
    assert.equal(events.filter((e) => e.event === "runtime.reload.completed").length, 1, "the reload completed");
  } finally {
    await runtime?.close();
    await pi.close();
  }
});
