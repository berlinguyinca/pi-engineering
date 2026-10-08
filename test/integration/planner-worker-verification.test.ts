/**
 * Contract verification commands run as real child processes under an
 * INACTIVITY guard in their own process group: a command that never exits
 * (a dev server, a watch mode, a stuck test) is killed — with every process
 * it spawned — once it has been silent for the window, and a mission abort
 * ends it at once. There is no total-duration limit.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runVerification } from "../../src/plannerWorker/executor.ts";

/** A process that opens a TCP listener and never exits; prints its pid once. */
const LISTENER = `node -e "const s=require('net').createServer().listen(0,()=>console.log('pid='+process.pid))"`;

function pidOf(output: string): number {
  const m = /pid=(\d+)/.exec(output);
  assert.ok(m, `no pid in output: ${output}`);
  return Number(m[1]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("a verification command that opens a listener and never exits is killed after its silence window", async () => {
  const started = Date.now();
  const run = await runVerification(LISTENER, process.cwd(), { inactivityMs: 600 });
  const took = Date.now() - started;
  assert.equal(run.passed, false);
  assert.match(run.output_tail, /no output for 600ms/);
  assert.ok(took >= 550, `killed only after the silence window (${took}ms)`);
  assert.ok(took < 15_000, `settled promptly (${took}ms)`);
  assert.ok(await waitDead(pidOf(run.output_tail)), "the listener process is gone");
});

test("a backgrounded child holding stdout open after the shell exits is killed with its process group", async () => {
  const run = await runVerification(`${LISTENER} & echo started`, process.cwd(), { inactivityMs: 600 });
  assert.equal(run.passed, false, "the command never settled on its own");
  assert.match(run.output_tail, /started/);
  assert.ok(await waitDead(pidOf(run.output_tail)), "the grandchild listener is gone");
});

test("a mission abort terminates a running verification command promptly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-verify-abort-"));
  const pidFile = join(dir, "pid");
  const ac = new AbortController();
  const started = Date.now();
  // Default window (15 min): only the abort can end this command.
  const pending = runVerification(
    `node -e "require('net').createServer().listen(0,()=>require('fs').writeFileSync(process.argv[1],'pid='+process.pid))" ${pidFile}`,
    process.cwd(),
    { signal: ac.signal },
  );
  let pid = 0;
  for (let i = 0; i < 100 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pid = await readFile(pidFile, "utf8").then(pidOf, () => 0);
  }
  assert.ok(pid > 0 && alive(pid), "the listener is running");
  ac.abort();
  const run = await pending;
  const took = Date.now() - started;
  assert.equal(run.passed, false);
  assert.match(run.output_tail, /aborted/);
  assert.ok(took < 15_000, `abort settled promptly (${took}ms)`);
  assert.ok(await waitDead(pid), "the aborted listener is gone");
  await rm(dir, { recursive: true, force: true });
});

test("a command aborted before it starts never runs", async () => {
  const ac = new AbortController();
  ac.abort();
  const run = await runVerification("echo ran", process.cwd(), { signal: ac.signal });
  assert.equal(run.passed, false);
  assert.doesNotMatch(run.output_tail, /ran/);
});

test("a long command that keeps printing is never cut off", async () => {
  const run = await runVerification(
    `node -e "let n=0;const t=setInterval(()=>{console.log(n++);if(n>20){clearInterval(t)}},60)"`,
    process.cwd(),
    { inactivityMs: 500 },
  );
  assert.equal(run.passed, true, run.output_tail);
  assert.ok(run.duration_ms >= 1_000, "ran for more than twice its silence window");
});
