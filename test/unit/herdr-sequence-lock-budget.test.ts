/**
 * The sequence-lock budget is an operator knob (#683).
 *
 * A lock whose holder is alive is not stale, so a writer whose budget runs out refuses to
 * write and the envelope never reaches the outbox. That is correct behaviour which reads, from
 * the outside, exactly like a storage outage — so the budget has to be raisable per host, and
 * the failure has to name what it waited for and how to raise it.
 *
 * Real lock files, a real holder process, a real child allocator.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  SEQUENCE_LOCK_DEFAULT_MS,
  SourceSequence,
  resolveSequenceLockMs,
} from "../../src/runtime/herdr/sourceSequence.ts";

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "seq-lock-683-"));
  roots.push(dir);
  return dir;
}
after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

function tryRead(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
function tryReadlink(path: string): string {
  try {
    return readlinkSync(path);
  } catch {
    return "";
  }
}

/** An allocator script in its own file, so the child's `import` resolves inside the repo. */
function allocScript(options: string): string {
  const file = join(tmp(), `alloc-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(
    file,
    `import { SourceSequence } from ${JSON.stringify(join(process.cwd(), "src/runtime/herdr/sourceSequence.ts"))};
const s = new SourceSequence({ dir: process.argv[2], source: "pi"${options ? `, ${options}` : ""} });
console.log(JSON.stringify([await s.next()]));`,
  );
  return file;
}

interface ChildRun {
  code: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

function runAlloc(script: string, dir: string, env: Record<string, string> = {}): Promise<ChildRun> {
  return new Promise<ChildRun>((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, dir], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - started }));
  });
}

/**
 * Hold the lock the way a real peer does — a record a waiter can compare against itself
 * (same host, same boot, same pid namespace) with a pid that is alive — so the only thing
 * that can end the wait is the budget. Returns the lock path and the holder process.
 */
async function liveHolder(dir: string): Promise<{ lockPath: string; release: () => void }> {
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const lockPath = join(dir, "sequence-pi.json.lock");
  writeFileSync(
    lockPath,
    JSON.stringify({
      host: hostname(),
      boot: tryRead("/proc/sys/kernel/random/boot_id"),
      pidns: tryReadlink("/proc/self/ns/pid"),
      pid: holder.pid,
      token: "live-holder-683",
      at: new Date().toISOString(),
    }),
  );
  return {
    lockPath,
    release: () => {
      rmSync(lockPath, { force: true });
      holder.kill("SIGKILL");
    },
  };
}

describe("sequence lock budget (#683)", () => {
  it("resolves PI_ENGINEERING_SEQUENCE_LOCK_MS and ignores anything unusable", () => {
    assert.equal(resolveSequenceLockMs({}), SEQUENCE_LOCK_DEFAULT_MS);
    assert.equal(resolveSequenceLockMs({ PI_ENGINEERING_SEQUENCE_LOCK_MS: "" }), SEQUENCE_LOCK_DEFAULT_MS);
    assert.equal(SEQUENCE_LOCK_DEFAULT_MS, 5000, "the production default is unchanged by this knob");
    assert.equal(resolveSequenceLockMs({ PI_ENGINEERING_SEQUENCE_LOCK_MS: "15000" }), 15000);
    assert.equal(resolveSequenceLockMs({ PI_ENGINEERING_SEQUENCE_LOCK_MS: " 8000 " }), 8000);
    // A malformed value must never make every writer give up instantly.
    for (const bad of ["0", "-1", "1500.5", "abc", "1e3x", "Infinity"]) {
      assert.equal(resolveSequenceLockMs({ PI_ENGINEERING_SEQUENCE_LOCK_MS: bad }), SEQUENCE_LOCK_DEFAULT_MS, bad);
    }
  });

  it("the env knob sets how long a real writer waits before it refuses to write", async () => {
    const dir = tmp();
    const script = allocScript(""); // no explicit option: the env is the only input
    const { release } = await liveHolder(dir);
    try {
      const run = await runAlloc(script, dir, { PI_ENGINEERING_SEQUENCE_LOCK_MS: "250" });
      assert.equal(run.code, 1, "a live holder is not stale, so the writer gives up");
      assert.match(run.stderr, /timed out after 250ms waiting for lock/, "the env budget was the one used");
      assert.match(run.stderr, /waited 250ms for the "pi" sequence lock/);
      assert.match(run.stderr, /PI_ENGINEERING_SEQUENCE_LOCK_MS=<ms>, currently 250/);
      assert.ok(run.elapsedMs < 5000, `gave up on the configured budget, not the default (${run.elapsedMs}ms)`);
    } finally {
      release();
    }
    // It was the lock, not the knob: with the lock gone the same child allocates.
    const released = await runAlloc(script, dir, { PI_ENGINEERING_SEQUENCE_LOCK_MS: "250" });
    assert.equal(released.code, 0, released.stderr);
    assert.deepEqual(JSON.parse(released.stdout), [1]);
  });

  it("an explicit option still beats the environment, so tests and callers can pin it", async () => {
    const dir = tmp();
    // The environment asks for 2 s; the caller says 20 ms. The caller wins, quickly.
    const script = allocScript("lockTimeoutMs: 20");
    const { release } = await liveHolder(dir);
    try {
      const run = await runAlloc(script, dir, { PI_ENGINEERING_SEQUENCE_LOCK_MS: "2000" });
      assert.equal(run.code, 1);
      assert.match(run.stderr, /timed out after 20ms waiting for lock/);
      assert.ok(run.elapsedMs < 1000, `the explicit budget won (${run.elapsedMs}ms)`);
    } finally {
      release();
    }
  });

  it("counts and rejects a starved allocation instead of handing out a duplicate number", async () => {
    const dir = tmp();
    const seq = new SourceSequence({ dir, source: "pi", lockTimeoutMs: 25 });
    const { release } = await liveHolder(dir);
    try {
      await assert.rejects(() => seq.next(), /timed out after 25ms waiting for lock/);
      assert.ok(seq.failures >= 1, "the failed allocation is counted for the operator");
    } finally {
      release();
    }
    // Nothing was handed out, so the next allocation is still the first number.
    assert.equal(await seq.next(), 1);
  });
});
