import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cleanupOwnedCanary,
  stopOwnedCanaryProcess,
  trackOwnedCanaryProcess,
} from "../../scripts/support/ownedCanaryProcess.ts";

async function ignoringTerm() {
  const tracked = trackOwnedCanaryProcess(
    spawn(
      process.execPath,
      [
        "-e",
        `
    process.on("SIGTERM", () => process.send("ignored SIGTERM"));
    process.send("ready");
    setInterval(() => {}, 1000);
  `,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    ),
  );
  assert.deepEqual(await once(tracked.child, "message"), ["ready", undefined]);
  return tracked;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "herdr-owned-cleanup-test-"));
  const sessionDirectory = join(root, "session");
  await mkdir(sessionDirectory);
  await mkdir(join(root, "profile"));
  await writeFile(join(root, "profile/auth.json"), "disposable test credential");
  await writeFile(join(sessionDirectory, "socket-placeholder"), "owned resource");
  return { root, sessionDirectory, ownsSessionDirectory: true };
}

test("owned server ignoring SIGTERM is killed and closed before resource deletion", async () => {
  const paths = await fixture();
  const server = await ignoringTerm();
  try {
    const ignored = once(server.child, "message");
    const cleanup = cleanupOwnedCanary({ ...paths, server, graceMs: 200 });
    await ignored;
    assert.equal(server.closed, false);
    assert.equal(await readFile(join(paths.sessionDirectory, "socket-placeholder"), "utf8"), "owned resource");
    await cleanup;
    assert.equal(server.closed, true);
    assert.equal(server.child.signalCode, "SIGKILL");
    await assert.rejects(access(paths.root), { code: "ENOENT" });
  } finally {
    await stopOwnedCanaryProcess(server, 200);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("shutdown failure removes credentials but preserves live server resources", async () => {
  const paths = await fixture();
  const server = await ignoringTerm();
  // An unclosed client handle models the bounded shutdown-failure branch without targeting another process.
  const client = trackOwnedCanaryProcess(new ChildProcess());
  try {
    await assert.rejects(cleanupOwnedCanary({ ...paths, client, server, graceMs: 10 }), /did not close/);
    assert.equal(server.closed, false);
    assert.equal(await readFile(join(paths.sessionDirectory, "socket-placeholder"), "utf8"), "owned resource");
    await assert.rejects(access(join(paths.root, "profile")), { code: "ENOENT" });
  } finally {
    await stopOwnedCanaryProcess(server, 200);
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("failed ENOENT and EACCES spawns close safely without an exit event", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-failed-spawn-test-"));
  try {
    const denied = join(root, "not-executable");
    await writeFile(denied, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    for (const [command, code] of [
      [join(root, "missing"), "ENOENT"],
      [denied, "EACCES"],
    ]) {
      const tracked = trackOwnedCanaryProcess(spawn(command!, [], { detached: true, stdio: "ignore" }));
      let exits = 0;
      tracked.child.once("exit", () => {
        exits++;
      });
      await tracked.closedPromise;
      assert.equal(tracked.closed, true);
      assert.equal((tracked.error as NodeJS.ErrnoException).code, code);
      assert.equal(exits, 0);
      await stopOwnedCanaryProcess(tracked, 10);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
