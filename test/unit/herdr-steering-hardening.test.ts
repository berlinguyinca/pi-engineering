/**
 * T16 M8: steering is judged on Herdr's clock, a named digest is verified (fail closed), the fence is compared where Pi
 * can, and the at-most-once ledger is fsynced.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import {
  CLOCK_SKEW_ALLOWANCE_S,
  FileSteeringLedger,
  MAX_VALIDITY_S,
  MemorySteeringLedger,
  type ResolvedTarget,
  type SteeringPorts,
  applySteering,
  parseSteeringItem,
} from "../../src/orchestration/steering.ts";
import { resolveSteeringTarget } from "../../src/orchestration/steeringResolve.ts";
import { SteeringReceiver, serverClockFrom } from "../../src/runtime/herdr/SteeringReceiver.ts";

const wire = (over: Record<string, unknown> = {}, target: Record<string, unknown> = {}) => ({
  steering_id: "st-1",
  action: "redirect",
  target: { node_id: "task:t1", ...target },
  instruction: "prefer the smaller change",
  proposed_by: { id: "alice" },
  confirmed_by: { id: "bob" },
  room: { id: "room-a" },
  trust: "untrusted",
  valid_until_epoch: 1_000,
  ...over,
});
const item = (over: Record<string, unknown> = {}, target: Record<string, unknown> = {}) => {
  const parsed = parseSteeringItem(wire(over, target));
  assert.ok(parsed);
  return parsed;
};
const task = (over: Partial<Extract<ResolvedTarget, { kind: "task" }>> = {}): ResolvedTarget => ({
  kind: "task",
  taskId: "t1",
  missionId: "m1",
  running: true,
  terminal: false,
  ...over,
});
function ports(target: ResolvedTarget, nowS: number, steered: string[] = []): SteeringPorts {
  return {
    now: () => nowS,
    resolve: () => target,
    steerRunning: (id) => {
      steered.push(id);
      return "delivered";
    },
    resumeMission: async () => ({ changed: true }),
  };
}

test("expiry is decided on Herdr's clock: a Pi that is 100 s behind does not apply an expired request", async () => {
  const steered: string[] = [];
  // valid_until 1000 on Herdr's clock; Herdr says it is now 1000; Pi's wall clock says 900
  const ack = await applySteering(item(), ports(task(), 900, steered), new MemorySteeringLedger(), {
    now: () => 1_000,
  });
  assert.equal(ack?.outcome, "stale");
  assert.deepEqual(steered, []);
});

test("a Pi whose clock is AHEAD still applies a request Herdr considers valid", async () => {
  const steered: string[] = [];
  const ack = await applySteering(
    item({ valid_until_epoch: 1_200 }),
    ports(task(), 1_300, steered),
    new MemorySteeringLedger(),
    {
      now: () => 1_100,
    },
  );
  assert.equal(ack?.outcome, "applied");
  assert.deepEqual(steered, ["t1"]);
});

test("without Herdr's time the Pi clock is used with a stricter margin", async () => {
  const near = await applySteering(
    item({ valid_until_epoch: 1_000 + CLOCK_SKEW_ALLOWANCE_S - 1 }),
    ports(task(), 1_000),
    new MemorySteeringLedger(),
  );
  assert.equal(near?.outcome, "stale");
  const far = await applySteering(
    item({ valid_until_epoch: 1_000 + CLOCK_SKEW_ALLOWANCE_S + 10 }),
    ports(task(), 1_000),
    new MemorySteeringLedger(),
  );
  assert.equal(far?.outcome, "applied");
});

test("a validity longer than the ledger retention is refused, so a pruned row can never re-apply", async () => {
  const ack = await applySteering(
    item({ valid_until_epoch: 1_000 + MAX_VALIDITY_S + 60 }),
    ports(task(), 1_000),
    new MemorySteeringLedger(),
    { now: () => 1_000 },
  );
  assert.equal(ack?.outcome, "stale");
  assert.match(ack?.note ?? "", /ledger/);
});

test("every item of a batch is judged when it is applied, not when the batch arrived", async () => {
  let t = 1_000;
  const clock = { now: () => t };
  const ledger = new MemorySteeringLedger();
  const steered: string[] = [];
  const p = ports(task(), 1_000, steered);
  const a = await applySteering(item({ steering_id: "a", valid_until_epoch: 1_010 }), p, ledger, clock);
  t = 1_020; // the first item was slow
  const b = await applySteering(item({ steering_id: "b", valid_until_epoch: 1_010 }), p, ledger, clock);
  assert.equal(a?.outcome, "applied");
  assert.equal(b?.outcome, "stale");
});

test("a named digest is verified; one Pi cannot verify is refused (fail closed)", async () => {
  const named = item({}, { expected_digest: "D1" });
  const ok = await applySteering(named, ports(task({ digest: "D1" }), 900), new MemorySteeringLedger());
  assert.equal(ok?.outcome, "applied");
  const moved = await applySteering(named, ports(task({ digest: "D2" }), 900), new MemorySteeringLedger());
  assert.equal(moved?.outcome, "stale");
  const unknown = await applySteering(
    item({ steering_id: "st-2" }, { expected_digest: "D1" }),
    ports(task(), 900),
    new MemorySteeringLedger(),
  );
  assert.equal(unknown?.outcome, "stale");
  assert.match(unknown?.note ?? "", /cannot verify/);
  const none = await applySteering(item({ steering_id: "st-3" }), ports(task(), 900), new MemorySteeringLedger());
  assert.equal(none?.outcome, "applied", "a request that names no digest is unaffected");
});

test("a fence Pi can compare is compared", async () => {
  const fenced = item({}, { fence: "F1" });
  assert.equal(
    (await applySteering(fenced, ports(task({ fence: "F1" }), 900), new MemorySteeringLedger()))?.outcome,
    "applied",
  );
  const moved = await applySteering(
    item({ steering_id: "st-2" }, { fence: "F1" }),
    ports(task({ fence: "F2" }), 900),
    new MemorySteeringLedger(),
  );
  assert.equal(moved?.outcome, "stale");
  assert.match(moved?.note ?? "", /fence/);
});

test("the runtime resolver supplies the mission's current plan digest", () => {
  const store = {
    getTask: (id: string) =>
      id === "t1" ? { task_id: "t1", mission_id: "m1", status: "RUNNING" as const } : undefined,
    getMission: (id: string) =>
      id === "m1" ? { mission_id: "m1", status: "RUNNING", operator_paused_at: null } : undefined,
    listPlanRevisions: (id: string) => (id === "m1" ? [{ planDigest: "old" }, { planDigest: "current" }] : []),
  };
  const t = resolveSteeringTarget(store as never, "task:t1");
  assert.equal(t?.kind === "task" && t.digest, "current");
  const m = resolveSteeringTarget(store as never, "mission:m1");
  assert.equal(m?.kind === "mission" && m.digest, "current");
  const noPlan = resolveSteeringTarget({ ...store, listPlanRevisions: () => [] } as never, "task:t1");
  assert.equal(noPlan?.kind === "task" && noPlan.digest, null);
});

test("an interrupted request redelivered with a different fence is reported as such and never applied", async () => {
  const ledger = new MemorySteeringLedger();
  ledger.begin("st-1", "F1");
  const steered: string[] = [];
  const ack = await applySteering(item({}, { fence: "F2" }), ports(task(), 900, steered), ledger);
  assert.equal(ack?.outcome, "stale");
  assert.match(ack?.note ?? "", /different fence/);
  assert.deepEqual(steered, []);
});

test("the ledger is fsynced on every row and on rewrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-steer-fsync-"));
  const calls: number[] = [];
  const real = fs.fsyncSync;
  mock.method(fs, "fsyncSync", (fd: number) => {
    calls.push(fd);
    return real(fd);
  });
  syncBuiltinESMExports();
  try {
    const ledger = new FileSteeringLedger(join(dir, "ledger.jsonl"));
    ledger.begin("a", "F");
    const afterBegin = calls.length;
    assert.ok(afterBegin >= 1, "begin fsyncs");
    ledger.finish("a", { outcome: "applied", note: "x" });
    assert.ok(calls.length > afterBegin, "finish fsyncs");
    const reopened = new FileSteeringLedger(join(dir, "ledger.jsonl"));
    assert.equal(reopened.get("a")?.state, "done");
    assert.equal(reopened.get("a")?.fence, "F", "the fence survives a restart");
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("serverClockFrom: Date header (later bound) advanced by monotonic time; absent header = unknown", () => {
  let mono = 10_000;
  const res = new Response("{}", { headers: { date: new Date(5_000_000).toUTCString() } });
  const clock = serverClockFrom(res, {}, () => mono);
  assert.equal(clock.now(), 5_001);
  mono += 3_000;
  assert.equal(clock.now(), 5_004);
  assert.equal(serverClockFrom(new Response("{}"), {}, () => 0).now(), undefined);
  assert.equal(serverClockFrom(new Response("{}"), { server_epoch: 77 }, () => 0).now(), 77);
});

test("the receiver judges a delivery on the Date header, whatever the Pi clock says", async () => {
  const steered: string[] = [];
  const sent: Array<{ id: string; outcome: string }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/ack")) {
      sent.push({ id: u.split("/steering/")[1]?.split("/")[0] ?? "", outcome: JSON.parse(String(init?.body)).outcome });
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ steering: [wire({ valid_until_epoch: 1_000 })] }), {
      status: 200,
      headers: { "content-type": "application/json", date: new Date(1_000_000).toUTCString() },
    });
  }) as typeof globalThis.fetch;
  const receiver = new SteeringReceiver({
    baseUrl: "http://127.0.0.1:9",
    ports: ports(task(), 900, steered), // Pi believes it is 900: ten minutes... 100 s earlier than Herdr
    ledger: new MemorySteeringLedger(),
    fetch,
  });
  await receiver.pollOnce();
  assert.deepEqual(sent, [{ id: "st-1", outcome: "stale" }]);
  assert.deepEqual(steered, []);
});

// ─── review round: digest on every action Pi can apply, and the fence in the ledger on every path ───────────────

const SHA = "a".repeat(40);
const forkItem = (over: Record<string, unknown> = {}, target: Record<string, unknown> = {}) =>
  item({ action: "fork", params: { base_sha: SHA }, ...over }, target);
const promoteItem = (over: Record<string, unknown> = {}, target: Record<string, unknown> = {}) =>
  item({ action: "promote", params: { expected_head: SHA }, ...over }, target);

function forkPorts(opts: { digest?: string | null | "absent" }): { p: SteeringPorts; applied: string[] } {
  const applied: string[] = [];
  const port: NonNullable<SteeringPorts["forks"]> = {
    knows: () => true,
    apply: async (it) => {
      applied.push(it.steeringId);
      return { outcome: "applied", note: "ok" };
    },
    ...(opts.digest === "absent" ? {} : { digest: () => opts.digest ?? null }),
  };
  return { p: { ...ports(task(), 900), forks: port }, applied };
}

test("fork and promote verify a named digest too: unverifiable, mismatched and matching", async () => {
  for (const make of [forkItem, promoteItem]) {
    const named = make({}, { expected_digest: "D1" });
    const none = forkPorts({ digest: "absent" });
    const a = await applySteering(named, none.p, new MemorySteeringLedger());
    assert.equal(a?.outcome, "stale", `${named.action}: a port that cannot compute a digest cannot satisfy one`);
    assert.match(a?.note ?? "", /cannot verify/);
    assert.deepEqual(none.applied, [], "nothing was applied");

    const wrong = forkPorts({ digest: "D2" });
    const b = await applySteering(
      make({ steering_id: "st-b" }, { expected_digest: "D1" }),
      wrong.p,
      new MemorySteeringLedger(),
    );
    assert.equal(b?.outcome, "stale");
    assert.match(b?.note ?? "", /digest mismatch/);
    assert.deepEqual(wrong.applied, []);

    const right = forkPorts({ digest: "D1" });
    const c = await applySteering(
      make({ steering_id: "st-c" }, { expected_digest: "D1" }),
      right.p,
      new MemorySteeringLedger(),
    );
    assert.equal(c?.outcome, "applied");
    assert.deepEqual(right.applied, ["st-c"]);

    const unnamed = forkPorts({ digest: "absent" });
    const d = await applySteering(make({ steering_id: "st-d" }), unnamed.p, new MemorySteeringLedger());
    assert.equal(d?.outcome, "applied", "a request that names no digest is unaffected");
  }
});

test("resume verifies a named digest like redirect does", async () => {
  const mission = (over: Record<string, unknown> = {}) =>
    ({
      kind: "mission",
      missionId: "m1",
      paused: true,
      operatorPaused: false,
      terminal: false,
      ...over,
    }) as ResolvedTarget;
  const named = item({ action: "resume", target: { node_id: "mission:m1", expected_digest: "D1" } });
  assert.equal(
    (await applySteering(named, ports(mission({ digest: "D2" }), 900), new MemorySteeringLedger()))?.outcome,
    "stale",
  );
  assert.equal(
    (await applySteering(named, ports(mission(), 900), new MemorySteeringLedger()))?.outcome,
    "stale",
    "no digest available: fail closed",
  );
  assert.equal(
    (await applySteering(named, ports(mission({ digest: "D1" }), 900), new MemorySteeringLedger()))?.outcome,
    "applied",
  );
});

test("approve and reject are answered `unsupported` before any digest is looked at (what Herdr sends a digest for)", async () => {
  // Herdr sends expected_digest only for gate decisions. Pi does not take gate decisions from steering, so those
  // requests are never applied, whatever the digest says. This test pins that so nobody mistakes the digest check
  // for something that protects an applied approve/reject.
  for (const action of ["approve", "reject"]) {
    const ack = await applySteering(
      item({ action }, { expected_digest: "D1" }),
      ports(task({ digest: "D1" }), 900),
      new MemorySteeringLedger(),
    );
    assert.equal(ack?.outcome, "unsupported", action);
  }
});

test("the fence is recorded in the ledger on the redirect, resume and fork paths", async () => {
  const begun: Array<[string, string | null | undefined]> = [];
  class Spy extends MemorySteeringLedger {
    override begin(id: string, fence?: string | null): void {
      begun.push([id, fence]);
      super.begin(id, fence);
    }
  }
  const ledger = new Spy();
  await applySteering(item({ steering_id: "r1" }, { fence: "FR" }), ports(task(), 900), ledger);
  await applySteering(
    item({ steering_id: "m1", action: "resume", target: { node_id: "mission:m1", fence: "FM" } }),
    ports({ kind: "mission", missionId: "m1", paused: true, operatorPaused: false, terminal: false }, 900),
    ledger,
  );
  await applySteering(forkItem({ steering_id: "f1" }, { fence: "FF" }), forkPorts({ digest: "absent" }).p, ledger);
  assert.deepEqual(begun, [
    ["r1", "FR"],
    ["m1", "FM"],
    ["f1", "FF"],
  ]);
  assert.equal(ledger.get("r1")?.fence, "FR");
  assert.equal(ledger.get("f1")?.fence, "FF");
});
