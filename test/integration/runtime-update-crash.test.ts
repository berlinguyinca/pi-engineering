/**
 * Hard process termination during an update (spec §30, §53).
 *
 * A real child Node process runs Pi with the Host and a journaled activation.
 * At the requested phase it is killed with SIGKILL (no cleanup, no finally
 * blocks). Then a fresh process "restarts Pi" and reports what crash recovery
 * did and what runs.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeStateSchema } from "../../src/runtime/migrations/schema.ts";
import { InstallLayout } from "../../src/update/installLayout.ts";
import { UpdateJournal } from "../../src/update/journal.ts";
import { installFixtureVersion } from "../support/hostHarness.ts";
import { writeFixtureRuntime } from "../support/runtimeFixtures.ts";

const child = resolve(fileURLToPath(new URL("../support/crashChild.ts", import.meta.url)));
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function run(mode: string, config: object): ChildProcess {
  return spawn(process.execPath, ["--no-warnings", child, mode, JSON.stringify(config)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_SELF_UPDATE: "0" },
  });
}

/** Resolve once `marker` is printed; reject if the process exits first. */
function waitFor(proc: ChildProcess, marker: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${marker}\n${out}\n${err}`)), timeoutMs);
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n").find((l) => l.startsWith(marker));
      if (line) {
        clearTimeout(timer);
        resolveLine(line);
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited (${code}) before ${marker}\n${out}\n${err}`));
    });
  });
}

let seq = 0;
async function world() {
  const key = `__rt_crash_${process.pid}_${++seq}`;
  const root = mkdtempSync(join(tmpdir(), "rt-crash-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const layout = new InstallLayout(join(root, "install"));
  const pkg = join(root, "package");
  writeFixtureRuntime(pkg, key, { value: "PKG" });
  const cwd = join(root, "project");
  const state = join(cwd, ".pi-eng");
  mkdirSync(state, { recursive: true });
  writeStateSchema(state, 7);
  const missions = JSON.stringify({ schema: 7, missions: ["MSN-1"] });
  writeFileSync(join(state, "missions.json"), missions);
  const a = await installFixtureVersion(layout, key, {
    version: "0.2.0",
    value: "A",
    stateSchema: { minReadable: 7, maxReadable: 7, writes: 7 },
  });
  await layout.setPointer("current", a);
  return { key, root, layout, pkg, cwd, state, missions, a };
}

interface Restarted {
  recovery: { action: string; detail: string };
  active: { root: string; label: string } | null;
  healthy: boolean;
  journalPhase: string;
  current: string | null;
  previous: string | null;
  schema: number;
  missions: string | null;
  lockHeld: boolean;
}

async function crashAndRestart(crashAt: string, behaviour: "ok" | "crash") {
  const w = await world();
  const candidate = await installFixtureVersion(w.layout, w.key, {
    version: "0.3.0",
    value: "B",
    stateSchema: { minReadable: 8, maxReadable: 8, writes: 8 },
    migration: { from: 7, to: 8, behaviour },
  });
  const config = { key: w.key, installRoot: w.layout.root, packageRoot: w.pkg, cwd: w.cwd, candidateDir: candidate };
  const proc = run("transact", { ...config, crashAt });
  await waitFor(proc, behaviour === "crash" ? "MIGRATION_HALF" : "CRASH_POINT");
  const journalAtCrash = new UpdateJournal(w.layout.journalFile).read();
  const currentAtCrash = w.layout.readPointer("current");
  const missionsAtCrash = readFileSync(join(w.state, "missions.json"), "utf8");
  proc.kill("SIGKILL");
  await new Promise((r) => proc.on("exit", r));
  const restart = run("start", config);
  const line = await waitFor(restart, "RESULT ");
  await new Promise((r) => restart.on("exit", r));
  return {
    w,
    candidate,
    journalAtCrash,
    currentAtCrash,
    missionsAtCrash,
    after: JSON.parse(line.slice("RESULT ".length)) as Restarted,
  };
}

function assertRecovered(r: Awaited<ReturnType<typeof crashAndRestart>>, interrupted: string) {
  const { w, after } = r;
  assert.equal(after.recovery.action, "rolled_back", after.recovery.detail);
  assert.match(after.recovery.detail, new RegExp(`interrupted during ${interrupted}`));
  assert.equal(after.journalPhase, "rolled_back", "journal inspected and closed");
  assert.equal(after.current, w.a, "consistent runtime selected: no corrupt current pointer");
  assert.equal(after.active?.root, w.a, "the previous runtime runs");
  assert.equal(after.healthy, true, "Pi Engineering starts successfully");
  assert.equal(after.schema, 7, "persistent state restored to schema 7");
  assert.equal(after.missions, w.missions, "mission state restored byte for byte");
  assert.equal(after.lockHeld, false, "the dead process's lock was taken over and released");
}

test("crash during migration (torn state file) → checkpoint restored, previous runtime starts", async () => {
  const r = await crashAndRestart("migrating", "crash");
  assert.equal(r.journalAtCrash !== "corrupt" && r.journalAtCrash?.phase, "migrating");
  assert.notEqual(r.missionsAtCrash, r.w.missions, "the kill really left a torn state file");
  assertRecovered(r, "migrating");
});

test("crash after atomic activation (pointer switched, candidate not loaded) → pointers restored", async () => {
  const r = await crashAndRestart("loading", "ok");
  assert.equal(r.journalAtCrash !== "corrupt" && r.journalAtCrash?.phase, "loading");
  assert.equal(r.currentAtCrash, r.candidate, "the kill happened after the pointer switch");
  assertRecovered(r, "loading");
});

test("crash during candidate load/restore → rolled back", async () => {
  assertRecovered(await crashAndRestart("restoring", "ok"), "restoring");
});

test("crash during health check → rolled back", async () => {
  assertRecovered(await crashAndRestart("health_check", "ok"), "health_check");
});

test("crash just before commit → rolled back (only committed transactions survive a crash)", async () => {
  assertRecovered(await crashAndRestart("committing", "ok"), "committing");
});
