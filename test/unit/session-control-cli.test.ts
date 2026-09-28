import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startSessionControl } from "../../src/sessionControl/SessionControl.ts";
import { runSessionsCommand } from "../../src/sessionControl/cli.ts";

test("CLI lists, pings and queries exact instances, then sends one bounded note", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-control-cli-"));
  const control = join(root, "control");
  const notes: string[] = [];
  const first = await startSessionControl({
    rootDir: control,
    cwd: root,
    sessionId: "shared",
    onNote: (text) => {
      notes.push(text);
    },
  });
  const second = await startSessionControl({ rootDir: control, cwd: root, sessionId: "shared" });
  const lines: string[] = [];
  const errors: string[] = [];
  const options = { rootDir: control, write: (s: string) => lines.push(s), error: (s: string) => errors.push(s) };
  try {
    assert.equal(await runSessionsCommand(["list", "--json"], options), 0);
    const listed = JSON.parse(lines.pop()!);
    assert.equal(listed.length, 2);
    assert.ok(listed.every((row: { reachable: boolean }) => row.reachable));
    assert.equal(await runSessionsCommand(["ping", first.instanceId, "--json"], options), 0);
    assert.equal(JSON.parse(lines.pop()!).instanceId, first.instanceId);
    assert.equal(await runSessionsCommand(["status", first.instanceId, "--json"], options), 0);
    assert.equal(JSON.parse(lines.pop()!).sessionId, "shared");
    assert.equal(await runSessionsCommand(["note", first.instanceId, "Please report progress"], options), 0);
    assert.deepEqual(notes, ["Please report progress"]);
    assert.equal(await runSessionsCommand(["ping", "shared"], options), 2);
    assert.match(errors.pop()!, /exact instance/i);
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI watch reports state changes without printing every fresh ping timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-control-watch-"));
  const server = await startSessionControl({ rootDir: join(root, "control"), cwd: root, sessionId: "watch" });
  const controller = new AbortController();
  const lines: string[] = [];
  async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("watch did not publish expected state");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    const run = runSessionsCommand(["watch", "--json", "--interval-ms=20"], {
      rootDir: join(root, "control"),
      write: (s) => lines.push(s),
      error: () => {},
      signal: controller.signal,
    });
    await until(() => lines.length >= 1);
    server.toolStarted("mission");
    await until(() => lines.length >= 2);
    controller.abort();
    assert.equal(await run, 0);
    const events = lines.map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events[0][0].descriptor.sessionId, "watch");
    assert.equal(events[1][0].reply.data.currentTool, "mission");
  } finally {
    controller.abort();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
