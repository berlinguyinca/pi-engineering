/**
 * Phase 4 reliability (spec §17, §19, §20, §30; acceptance cases 5 and 6):
 * a writer killed mid-record, a corrupt registry database, reboot-style
 * leftovers, and network-filesystem placement — all repaired automatically.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { filesystemInfo } from "../../src/runtime/isolation/fsType.ts";
import { resolveRegistryLocation } from "../../src/runtime/isolation/stateDir.ts";
import { makeGitRepo, makeStateDir, startChild } from "../support/childSessions.ts";

describe("reliability across real processes", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("a writer SIGKILLed mid-record: valid history remains, the broken tail is quarantined, the runtime opens", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-torn-"));
    const stateDir = await makeStateDir("torn-state");
    cleanup.push(root, stateDir);
    const repo = await makeGitRepo(join(root, "repo"));
    const writer = startChild("tear", repo, stateDir);
    const torn = await writer.report;
    assert.equal(torn.ok, true, torn.error);
    writer.child.kill("SIGKILL");
    await writer.exited;
    const stream = join(torn.eventsDir!, `${torn.sessionId}.jsonl`);
    assert.ok(!readFileSync(stream, "utf8").endsWith("\n"), "precondition: the stream ends mid-record");

    const next = await startChild("open", repo, stateDir).report;
    assert.equal(next.ok, true, next.error);
    assert.ok(next.visibleMissions?.includes(torn.missionId!), "the killed writer's valid history is intact");
    const repaired = next.reconciliation?.repairedStreams.find((entry) => entry.stream === stream);
    assert.ok(repaired, "startup reconciliation repaired the dead writer's stream");
    assert.ok(readFileSync(stream, "utf8").endsWith("\n"), "stream truncated back to its last complete record");
    assert.match(
      readFileSync(repaired.quarantine, "utf8"),
      /"event_id":"oevt-torn"/,
      "the fragment is kept for diagnosis",
    );
  });

  it("a corrupt registry database is quarantined and rebuilt; the runtime stays healthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-corrupt-db-"));
    const stateDir = await makeStateDir("corrupt-db-state");
    cleanup.push(root, stateDir);
    const repo = await makeGitRepo(join(root, "repo"));
    await writeFile(
      join(stateDir, "registry.db"),
      "this is definitely not a sqlite database, just garbage bytes\n".repeat(20),
    );
    const report = await startChild("open", repo, stateDir).report;
    assert.equal(report.ok, true, report.error);
    assert.equal(report.health, "healthy");
    const quarantined = readdirSync(join(stateDir, "recovery")).filter((name) => name.includes("corrupt"));
    assert.equal(quarantined.length, 1, "the corrupt database is preserved for diagnostics");
  });

  it("network filesystems keep the SQLite registry on a machine-local filesystem", async () => {
    const stateDir = await makeStateDir("netfs-state");
    const runtimeDir = await makeStateDir("netfs-runtime");
    cleanup.push(stateDir, runtimeDir);
    const local = resolveRegistryLocation(stateDir, { PI_ENGINEERING_STATE_DIR: stateDir });
    assert.equal(local.file, join(stateDir, "registry.db"));
    assert.equal(local.relocatedBecause, null);
    assert.notEqual(filesystemInfo(stateDir).type, "unknown", "the filesystem type is identified");
    const network = resolveRegistryLocation(stateDir, {
      PI_ENGINEERING_ASSUME_NETWORK_FS: "1",
      XDG_RUNTIME_DIR: runtimeDir,
    });
    assert.ok(network.file.startsWith(join(runtimeDir, "pi-engineering")), network.file);
    assert.match(network.relocatedBecause ?? "", /network filesystem/);

    // And a real session works end to end in that configuration.
    const root = await mkdtemp(join(tmpdir(), "pi-eng-netfs-repo-"));
    cleanup.push(root);
    const repo = await makeGitRepo(join(root, "repo"));
    const report = await startChild("open", repo, stateDir, {
      env: { PI_ENGINEERING_ASSUME_NETWORK_FS: "1", XDG_RUNTIME_DIR: runtimeDir },
    }).report;
    assert.equal(report.ok, true, report.error);
    assert.equal(report.health, "healthy");
    assert.ok(readdirSync(join(runtimeDir, "pi-engineering")).some((name) => name.startsWith("registry-")));
  });
});
