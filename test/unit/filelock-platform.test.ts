import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ExclusiveFileLock,
  type FileLockOwner,
  readBootId,
  readProcessStartTime,
} from "../../src/platform/eventstore/fileLock.ts";

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The durable single-writer lock must be establishable on every supported
 * host platform. Linux reads /proc; other platforms (darwin) must derive an
 * equivalent process incarnation without /proc. These tests are the platform
 * contract: on a non-linux host they fail with "cannot establish a
 * trustworthy process incarnation" when the fallback is missing.
 */
test("process incarnation is established on the current platform", () => {
  const bootId = readBootId();
  assert.equal(typeof bootId, "string", "boot id must be readable on this platform");
  assert.match(bootId as string, BOOT_ID, "boot id must keep the durable owner-record UUID shape");
  const own = readProcessStartTime(process.pid);
  assert.equal(own.state, "present", "own process start time must be readable on this platform");
  if (own.state === "present") assert.match(own.value, /^\d+$/, "start time must stay a positive digit string");
});

test("own process incarnation is stable across reads", () => {
  const first = readProcessStartTime(process.pid);
  const second = readProcessStartTime(process.pid);
  assert.equal(first.state, "present");
  assert.equal(second.state, "present");
  if (first.state === "present" && second.state === "present") assert.equal(first.value, second.value);
  assert.equal(readBootId(), readBootId(), "boot id must be constant within one boot");
});

test("a dead process pid reports missing, not unknown", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  assert.ok(child.pid, "child pid must be assigned");
  const live = readProcessStartTime(child.pid);
  assert.equal(live.state, "present", "live child start time must be present");
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const dead = readProcessStartTime(child.pid);
  assert.equal(dead.state, "missing", `expected missing for dead pid ${child.pid}, got ${JSON.stringify(dead)}`);
});

test("writer lock round trip works on the current platform", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pie-lock-platform-"));
  try {
    await mkdir(join(dir, "nested"), { recursive: true });
    const file = join(dir, "nested", "events.jsonl");
    const lock = await ExclusiveFileLock.acquire(file);
    assert.equal(lock.owner.host, hostname());
    assert.match(lock.owner.bootId, BOOT_ID);
    lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock left by a dead process on the same boot is reclaimed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pie-lock-dead-owner-"));
  try {
    const file = join(dir, "events.jsonl");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    assert.ok(child.pid, "child pid must be assigned");
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    const bootId = readBootId();
    assert.ok(bootId, "boot id must be readable");
    const deadStart = readProcessStartTime(child.pid);
    // A dead pid reads as missing; the durable record must still carry a
    // positive digit start time, as the live owner had at acquisition.
    const startValue = deadStart.state === "present" ? deadStart.value : "1";
    const owner: FileLockOwner = {
      pid: child.pid,
      host: hostname(),
      openedAt: new Date().toISOString(),
      ownerToken: crypto.randomUUID(),
      bootId: bootId as string,
      processStartTime: startValue,
    };
    await writeFile(`${file}.lock`, `${JSON.stringify(owner)}\n`, "utf8");
    const lock = await ExclusiveFileLock.acquire(file, {});
    try {
      assert.notEqual(lock.owner.ownerToken, owner.ownerToken, "acquire must publish a fresh owner");
    } finally {
      lock.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
