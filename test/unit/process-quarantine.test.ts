import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import { type ProcessOps, ProcessQuarantine } from "../../src/workers/processQuarantine.ts";
import { createQuarantinedBashOperations } from "../../src/workers/quarantinedBash.ts";

/** A fake process table: group id -> behaviour. Virtual clock, so grace periods cost no wall time. */
function fakeOps(
  groups: Record<number, { ignoreTerm?: boolean; ignoreKill?: boolean }>,
  protectedPids: number[] = [4242],
) {
  const alive = new Set(Object.keys(groups).map(Number));
  const log: string[] = [];
  let clock = 0;
  const ops: ProcessOps = {
    kill(pid, signal) {
      const group = -pid;
      if (pid >= 0) throw new Error(`test: only group signals are expected, got pid ${pid}`);
      if (!alive.has(group)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (signal === 0) return;
      log.push(`${signal}:${group}@${clock}`);
      const g = groups[group];
      if (signal === "SIGTERM" && !g?.ignoreTerm) alive.delete(group);
      if (signal === "SIGKILL" && !g?.ignoreKill) alive.delete(group);
    },
    async sleep(ms) {
      clock += ms;
    },
    protectedPids: () => protectedPids,
  };
  return { ops, log, alive, now: () => clock };
}

describe("ProcessQuarantine with a fake process table", () => {
  it("SIGTERMs a cooperative group and never escalates", async () => {
    const f = fakeOps({ 100: {} });
    const q = new ProcessQuarantine({ ops: f.ops, graceMs: 1000 });
    const scope = {};
    q.track(scope, { pid: 100 });
    const report = await q.quarantine(scope);
    assert.deepEqual(f.log, ["SIGTERM:100@0"]);
    assert.deepEqual(report, { terminated: [100], killed: [], survivors: [], alreadyExited: [] });
    assert.deepEqual(q.tracked(scope), []);
  });

  it("escalates to SIGKILL only after the grace period for a group that ignores SIGTERM", async () => {
    const f = fakeOps({ 100: { ignoreTerm: true } });
    const q = new ProcessQuarantine({ ops: f.ops, graceMs: 1000, pollMs: 100 });
    const scope = {};
    q.track(scope, { pid: 100 });
    const report = await q.quarantine(scope);
    assert.deepEqual(f.log, ["SIGTERM:100@0", "SIGKILL:100@1000"]);
    assert.deepEqual(report.killed, [100]);
    assert.equal(f.alive.has(100), false);
  });

  it("reports a group that survives SIGKILL instead of claiming success", async () => {
    const f = fakeOps({ 100: { ignoreTerm: true, ignoreKill: true } });
    const q = new ProcessQuarantine({ ops: f.ops, graceMs: 200, killWaitMs: 300, pollMs: 100 });
    const scope = {};
    q.track(scope, { pid: 100 });
    assert.deepEqual((await q.quarantine(scope)).survivors, [100]);
  });

  it("signals only registered groups: unrelated groups and other scopes are untouched", async () => {
    const f = fakeOps({ 100: {}, 200: {}, 300: {} });
    const q = new ProcessQuarantine({ ops: f.ops });
    const mine = {};
    const other = {};
    q.track(mine, { pid: 100 });
    q.track(other, { pid: 200 });
    await q.quarantine(mine);
    assert.deepEqual(f.log, ["SIGTERM:100@0"]);
    assert.ok(f.alive.has(200) && f.alive.has(300));
    assert.deepEqual(q.tracked(other), [200]);
  });

  it("keeps a group that survived SIGKILL tracked so a later quarantine retries it", async () => {
    const f = fakeOps({ 100: { ignoreTerm: true, ignoreKill: true } });
    const q = new ProcessQuarantine({ ops: f.ops, graceMs: 100, killWaitMs: 100, pollMs: 50 });
    const scope = {};
    q.track(scope, { pid: 100 });
    await q.quarantine(scope);
    assert.deepEqual(q.tracked(scope), [100]);
  });

  it("does not signal a recycled pid: a leader with a different start time is not ours", async () => {
    const f = fakeOps({ 100: {} });
    let start = "111";
    const ops = { ...f.ops, fingerprint: () => start };
    const q = new ProcessQuarantine({ ops });
    const scope = {};
    q.track(scope, { pid: 100 });
    start = "999"; // the pid now belongs to a different process
    const report = await q.quarantine(scope);
    assert.deepEqual(f.log, []);
    assert.deepEqual(report.alreadyExited, [100]);
  });

  it("refuses pids that must never be signalled", () => {
    const f = fakeOps({}, [4242, 4243]);
    const q = new ProcessQuarantine({ ops: f.ops });
    for (const pid of [0, 1, -5, 4242, 4243, 1.5, Number.NaN]) {
      assert.throws(() => q.track({}, { pid }), /refusing/, `pid ${pid}`);
    }
    assert.deepEqual(f.log, []);
  });

  it("does not signal a group that is already gone (its pid may belong to someone else now)", async () => {
    const f = fakeOps({ 100: {} });
    const q = new ProcessQuarantine({ ops: f.ops });
    const scope = {};
    q.track(scope, { pid: 100 });
    f.alive.delete(100);
    const report = await q.quarantine(scope);
    assert.deepEqual(report.alreadyExited, [100]);
    assert.deepEqual(f.log, []);
  });

  it("prunes groups that no longer exist on registration, so a stale entry is not signalled later", () => {
    const f = fakeOps({ 100: {}, 101: {} });
    const q = new ProcessQuarantine({ ops: f.ops });
    const scope = {};
    q.track(scope, { pid: 100 });
    f.alive.delete(100);
    q.track(scope, { pid: 101 });
    assert.deepEqual(q.tracked(scope), [101]);
  });

  it("a quarantined scope kills any group registered later, immediately", async () => {
    const f = fakeOps({ 100: {}, 101: {} });
    const q = new ProcessQuarantine({ ops: f.ops });
    const scope = {};
    q.track(scope, { pid: 100 });
    await q.quarantine(scope);
    assert.equal(q.isQuarantined(scope), true);
    q.track(scope, { pid: 101 });
    await new Promise((r) => setImmediate(r));
    assert.ok(f.log.includes("SIGTERM:101@0"));
    assert.equal(f.alive.has(101), false);
  });

  it("release keeps a group that still has members and drops one that is gone", () => {
    const f = fakeOps({ 100: {}, 101: {} });
    const q = new ProcessQuarantine({ ops: f.ops });
    const scope = {};
    q.track(scope, { pid: 100 });
    q.track(scope, { pid: 101 });
    f.alive.delete(101);
    q.release(scope, 100);
    q.release(scope, 101);
    assert.deepEqual(q.tracked(scope), [100]);
  });
});

describe("ProcessQuarantine with real processes", () => {
  const gone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  const waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("terminates a running tool command and a backgrounded descendant, and leaves an unrelated process alone", async () => {
    const unrelated = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    unrelated.unref();
    const q = new ProcessQuarantine({ graceMs: 1500, pollMs: 25 });
    const scope = new AbortController().signal;
    const ops = createQuarantinedBashOperations(q, scope);
    let out = "";
    // leader exits at once; the backgrounded sleep keeps running in the same group
    const bg = ops.exec("sleep 30 & echo $!", process.cwd(), {
      onData: (d) => {
        out += d.toString();
      },
    });
    const fg = ops.exec("sleep 30", process.cwd(), { onData: () => {} }).catch(() => undefined);
    try {
      await bg;
      const descendant = Number(out.trim());
      assert.ok(descendant > 1);
      await waitFor(() => q.tracked(scope).length >= 1);
      assert.equal(gone(descendant), false, "descendant is running");
      const report = await q.quarantine(scope);
      await fg;
      assert.equal(report.survivors.length, 0);
      await waitFor(() => gone(descendant));
      assert.equal(gone(unrelated.pid as number), false, "unrelated process untouched");
      await assert.rejects(ops.exec("echo hi", process.cwd(), { onData: () => {} }), /quarantined/);
    } finally {
      process.kill(unrelated.pid as number, "SIGKILL");
    }
  });

  it("an aborted command is terminated SIGTERM-first and reports 128+signal", async () => {
    const q = new ProcessQuarantine({ graceMs: 1500, pollMs: 25 });
    const ac = new AbortController();
    const ops = createQuarantinedBashOperations(q, ac.signal);
    const p = ops.exec("sleep 30", process.cwd(), { onData: () => {}, signal: ac.signal });
    await waitFor(() => q.tracked(ac.signal).length === 1);
    const [pid] = q.tracked(ac.signal) as [number];
    ac.abort();
    await assert.rejects(p, /aborted/);
    await waitFor(() => gone(pid));
  });
});

describe("pi bash tool wired through the quarantine operations", () => {
  it("runs a command through the real bash tool definition, tracking and releasing its group", async () => {
    const { createBashToolDefinition } = await import("@earendil-works/pi-coding-agent");
    const q = new ProcessQuarantine({ graceMs: 500, pollMs: 25 });
    const scope = new AbortController().signal;
    const tool = createBashToolDefinition(process.cwd(), {
      operations: createQuarantinedBashOperations(q, scope),
    }) as unknown as {
      execute(
        id: string,
        params: { command: string },
        signal: AbortSignal | undefined,
      ): Promise<{ content: Array<{ text?: string }> }>;
    };
    const res = await tool.execute("t1", { command: "echo from-tool" }, undefined);
    assert.match(res.content.map((c) => c.text ?? "").join(""), /from-tool/);
    assert.deepEqual(q.tracked(scope), [], "a finished command leaves no tracked group behind");
  });
});
