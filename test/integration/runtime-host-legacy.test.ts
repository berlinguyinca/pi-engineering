/**
 * The REAL package through the REAL Host entry, loaded by Pi's own extension
 * loader (jiti), exactly as Pi loads it from package.json. Spec §50 and §58,
 * checked against the actual extension factory (extensions/index.ts), not a
 * fixture.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type PiTestSession, startPiSession } from "../support/piSession.ts";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const hostEntry = join(repoRoot, "src/runtime/host/extension.ts");

const ENV_KEYS = [
  "HOME",
  "PI_ENGINEERING_HOME",
  "PI_ENGINEERING_CONTROL_DIR",
  "PI_SELF_UPDATE",
  "PI_PANEL_AUTO_OPEN",
  "PI_PANEL_NARRATOR",
  "PI_ENGINEERING_UPDATE_CHECK",
] as const;
const saved: Record<string, string | undefined> = {};
let root = "";

before(() => {
  root = mkdtempSync(join(tmpdir(), "rt-host-legacy-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Nothing under the operator's real home is read or written.
  process.env.HOME = join(root, "home");
  process.env.PI_ENGINEERING_HOME = join(root, "install");
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

const WATCHED = ["Timeout", "FSEventWrap", "PipeServerWrap", "TCPServerWrap", "PipeWrap", "TCPWrap"];
function resources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of process.getActiveResourcesInfo()) if (WATCHED.includes(r)) counts[r] = (counts[r] ?? 0) + 1;
  return counts;
}

test("Pi loads the Host entry; the real extension reloads 5x with no duplicated handlers, commands or leaks", async () => {
  const pi: PiTestSession = await startPiSession({ extensionPaths: [hostEntry] });
  try {
    const commands = pi.piCommands();
    for (const name of ["engineering", "engineer", "mission", "update", "panel"]) {
      assert.ok(commands.includes(name), `/${name} registered`);
    }
    const watched = ["agent_settled", "before_agent_start", "message_update", "tool_execution_start", "model_select"];
    const handlerCounts = Object.fromEntries(watched.map((e) => [e, pi.piHandlerCount(e)]));
    assert.ok((handlerCounts.before_agent_start ?? 0) > 0);

    await pi.run("/engineering reload");
    await new Promise((r) => setTimeout(r, 50));
    const baseline = resources();
    for (let i = 0; i < 4; i++) await pi.run("/engineering reload");
    await new Promise((r) => setTimeout(r, 50));

    for (const e of watched) assert.equal(pi.piHandlerCount(e), handlerCounts[e], `Pi handlers for ${e} unchanged`);
    const after = pi.piCommands();
    assert.equal(after.length, new Set(after).size, "no duplicated command registrations");
    assert.deepEqual([...after].sort(), [...commands].sort());
    assert.deepEqual(resources(), baseline, "no leaked timers, watchers, sockets or servers across reloads");
    const events = readFileSync(join(root, "install", "telemetry", "runtime-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; new_generation?: number });
    const reloads = events.filter((e) => e.event === "runtime.reload.completed");
    assert.equal(reloads.length, 5, "five successful reloads");
    assert.equal(reloads.at(-1)?.new_generation, 6);
    assert.equal(events.filter((e) => e.event === "runtime.rollback.started").length, 0);
  } finally {
    await pi.close();
  }
});
