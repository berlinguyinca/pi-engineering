/**
 * Runtime reload compatibility (spec §32, acceptance case 8).
 *
 * An in-process reload of Pi Engineering evaluates a FRESH module graph in the
 * same process. To reproduce that faithfully, the source tree is copied and
 * imported a second time, so every module (classes, module-level maps) exists
 * twice — exactly what a reload produces — while globalThis is shared.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { RuntimeSession } from "../../src/runtime/isolation/RuntimeSession.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeGitRepo } from "../support/childSessions.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function reloadedModules(): Promise<{
  dir: string;
  EngineeringRuntime: typeof EngineeringRuntime;
  RuntimeSession: typeof RuntimeSession;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-reload-"));
  await cp(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  await cp(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  await symlink(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const runtimeModule = (await import(pathToFileURL(join(dir, "src", "runtime", "EngineeringRuntime.ts")).href)) as {
    EngineeringRuntime: typeof EngineeringRuntime;
  };
  const sessionModule = (await import(
    pathToFileURL(join(dir, "src", "runtime", "isolation", "RuntimeSession.ts")).href
  )) as { RuntimeSession: typeof RuntimeSession };
  return { dir, EngineeringRuntime: runtimeModule.EngineeringRuntime, RuntimeSession: sessionModule.RuntimeSession };
}

describe("in-process reload of Pi Engineering", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("keeps the session, its single writer and its ownership across a reload while work is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-reload-repo-"));
    cleanup.push(root);
    const repo = await makeGitRepo(join(root, `repo-${randomUUID().slice(0, 8)}`));
    await mkdir(join(repo, ".pi-eng"), { recursive: true });

    const before = await EngineeringRuntime.open({ cwd: repo, worker: new FakeWorkerExecutor({}) });
    const sessionBefore = RuntimeSession.current();
    const generationBefore = sessionBefore.generationId;
    assert.ok(generationBefore, "registered before the reload");
    const mission = before.missionStore!.createMission({
      title: "active work",
      goal: "survive a reload",
      user_request: "survive a reload",
      repository: repo,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "conversation",
    });
    const lease = await before.missionOwnership!.acquire(mission.mission_id);
    await before.missionStore!.flush();

    // ── reload: a fresh module graph in the same process ──
    const reloaded = await reloadedModules();
    cleanup.push(reloaded.dir);
    assert.notEqual(reloaded.EngineeringRuntime, EngineeringRuntime, "the reload really is a second module instance");
    const sessionAfter = reloaded.RuntimeSession.current();
    assert.equal(sessionAfter.sessionId, sessionBefore.sessionId, "session identity survives the reload");
    assert.equal(sessionAfter.generationId, generationBefore, "no re-registration, no false stale generation");

    // The reloaded runtime opens while the old one is still active.
    const after = await reloaded.EngineeringRuntime.open({ cwd: repo, worker: new FakeWorkerExecutor({}) });
    assert.ok(after.missionStore?.getMission(mission.mission_id), "the session's mission is visible after reload");

    // The old instance finishes shutting down (as session_shutdown does on reload).
    await before.close();
    const adopted = await after.missionOwnership!.acquire(mission.mission_id);
    assert.equal(adopted.generation, lease.generation + 1, "ownership continues at once, without waiting for expiry");

    after.missionStore!.createMission({
      title: "after reload",
      goal: "write through the same stream",
      user_request: "x",
      repository: repo,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "conversation",
    });
    await after.missionStore!.flush();
    const eventsDir = after.runtimeBinding!.eventsDir!;
    const streams = readdirSync(eventsDir).filter((name) => !name.startsWith("legacy-"));
    assert.deepEqual(streams, [`${sessionAfter.sessionId}.jsonl`], "exactly one writer stream for the session");
    const sequences = readFileSync(join(eventsDir, streams[0]!), "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { sequence: number }).sequence);
    assert.deepEqual(
      sequences,
      sequences.map((_, index) => index + 1),
      "one writer: sequence numbers are contiguous with no duplicates",
    );
    assert.equal(sessionAfter.heartbeat(), true, "the session keeps heartbeating after the reload");
    assert.equal(reloaded.RuntimeSession.current().generationId, generationBefore);
    await after.close();
  });

  it("hands the session's long-lived objects to the reloaded code: registry instance and heartbeat driver", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-reload-takeover-"));
    cleanup.push(root);
    const repo = await makeGitRepo(join(root, `repo-${randomUUID().slice(0, 8)}`));
    const before = await EngineeringRuntime.open({ cwd: repo, worker: new FakeWorkerExecutor({}) });
    const generation = RuntimeSession.current().generationId;
    const state = () =>
      (globalThis as unknown as Record<symbol, { driverModule: string | null; registry: unknown }>)[
        Symbol.for("pi-engineering.runtime-session.v2")
      ]!;
    assert.equal(state().driverModule, new URL("../../src/runtime/isolation/RuntimeSession.ts", import.meta.url).href);
    await before.close();

    const reloaded = await reloadedModules();
    cleanup.push(reloaded.dir);
    const registryModule = (await import(
      pathToFileURL(join(reloaded.dir, "src", "runtime", "isolation", "RuntimeRegistry.ts")).href
    )) as { RuntimeRegistry: new (...args: never[]) => unknown };
    const after = await reloaded.EngineeringRuntime.open({ cwd: repo, worker: new FakeWorkerExecutor({}) });
    const session = reloaded.RuntimeSession.current();
    assert.equal(session.generationId, generation, "same registration: no re-register");
    assert.ok(session.registry() instanceof registryModule.RuntimeRegistry, "registry re-opened by the new code");
    assert.equal(
      state().driverModule,
      pathToFileURL(join(reloaded.dir, "src", "runtime", "isolation", "RuntimeSession.ts")).href,
      "heartbeat and exit hook now run the reloaded code",
    );
    assert.equal(session.heartbeat(), true, "the re-opened registry still recognizes the registration");
    assert.equal(session.registry()?.list().length, 1, "still exactly one live session row");
    await after.close();
  });
});
