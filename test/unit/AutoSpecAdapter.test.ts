import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AutoSpecOwner,
  type AutoSpecRunState,
  type AutoSpecSubmission,
  StaleFencingTokenError,
} from "../../src/adapters/Adapters.ts";
import {
  type AutoSpecMissionSnapshot,
  ConcreteAutoSpecAdapter,
  createConcreteAutoSpecAdapter,
} from "../../src/adapters/AutoSpecAdapter.ts";

const owner1: AutoSpecOwner = { ownerId: "pi-a", fencingToken: 3 };

const submission = (over: Partial<AutoSpecSubmission> = {}): AutoSpecSubmission => ({
  missionId: "MSN-1",
  taskId: "T1",
  request: "implement isEven",
  baseSha: "abc123",
  owner: owner1,
  idempotencyKey: "k1",
  ...over,
});

interface Deps {
  submit: ReturnType<typeof stubSubmit>;
  observe: ReturnType<typeof stubObserve>;
  cancel: ReturnType<typeof stubCancel>;
}

/** A stub submit that records every call and returns a fresh mission id. */
function stubSubmit() {
  const calls: AutoSpecSubmission[] = [];
  let counter = 0;
  return {
    calls,
    fn: async (sub: AutoSpecSubmission) => {
      calls.push(sub);
      return { missionId: `MSN-ext-${++counter}`, fencingToken: sub.owner.fencingToken, created: true };
    },
  };
}

/** A stub observe serving a snapshot that the test can swap with `set`. */
function stubObserve(
  initial: AutoSpecMissionSnapshot = {
    missionId: "MSN-ext-1",
    canonicalState: "RUNNING",
  },
) {
  let current: AutoSpecMissionSnapshot = initial;
  const calls: string[] = [];
  return {
    calls,
    fn: async (missionId: string) => {
      calls.push(missionId);
      return { ...current, missionId };
    },
    set(next: Partial<AutoSpecMissionSnapshot>) {
      current = { ...current, ...next };
    },
  };
}

/** A stub cancel that cancels a non-terminal run and no-ops a terminal one. */
function stubCancel() {
  const calls: Array<{ id: string; reason: string }> = [];
  const terminal = new Set<string>();
  return {
    calls,
    terminal,
    fn: async (id: string, _o: AutoSpecOwner, reason: string) => {
      calls.push({ id, reason });
      if (terminal.has(id)) return { cancelled: false };
      terminal.add(id);
      return { cancelled: true };
    },
  };
}

function make(deps: Deps, opts: { now?: () => Date } = {}) {
  return new ConcreteAutoSpecAdapter({
    submit: deps.submit.fn,
    observe: deps.observe.fn,
    cancel: deps.cancel.fn,
    now: opts.now,
  });
}

test("submit happy path returns a handle through the external-entry submit function", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = make(deps);
  const handle = await adapter.submit(submission());
  assert.equal(handle.accepted, true);
  assert.equal(handle.externalId, "MSN-ext-1");
  assert.equal(deps.submit.calls.length, 1);
  assert.equal(deps.submit.calls[0]!.missionId, "MSN-1");
  assert.deepEqual(deps.submit.calls[0]!.owner, owner1);
});

test("submit: same idempotencyKey redelivers the same externalId without a second call", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = make(deps);
  const a = await adapter.submit(submission());
  const b = await adapter.submit(submission());
  assert.equal(a.externalId, b.externalId);
  assert.equal(a.accepted, true);
  assert.equal(b.accepted, true);
  assert.equal(deps.submit.calls.length, 1);
});

test("submit: a stale owner is refused with a reason mentioning stale fencing", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = make(deps);
  const first = await adapter.submit(submission());
  assert.equal(first.accepted, true);
  // A newer owner takes the run with a higher token.
  const newer: AutoSpecOwner = { ownerId: "pi-b", fencingToken: 4 };
  await adapter.cancel(first.externalId, newer, "takeover");
  // The original owner is now behind.
  const late = await adapter.submit(submission({ idempotencyKey: "k2" }));
  assert.equal(late.accepted, false);
  assert.equal(late.externalId, "");
  assert.match(late.reason ?? "", /stale fencing/i);
});

test("observe: maps every lifecycle canonical state to the exact AutoSpecRunState", async () => {
  const cases: Array<[string, AutoSpecRunState]> = [
    ["CREATED", "queued"],
    ["PLANNED", "queued"],
    ["READY", "queued"],
    ["PAUSED", "queued"],
    ["RUNNING", "running"],
    ["VALIDATING", "running"],
    ["REVIEWING", "running"],
    ["REPAIRING", "running"],
    ["RECOVERING", "running"],
    ["MERGING", "running"],
    ["MERGED", "succeeded"],
    ["ARCHIVED", "succeeded"],
    ["FAILED", "failed"],
    ["BLOCKED", "failed"],
    ["CANCELLED", "cancelled"],
  ];
  for (const [canonical, expected] of cases) {
    const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
    const adapter = make(deps);
    const handle = await adapter.submit(submission());
    deps.observe.set({ canonicalState: canonical });
    const observation = await adapter.observe(handle.externalId, owner1);
    assert.equal(observation.state, expected, `canonical ${canonical}`);
  }
});

test("observe: sequence is monotonic across successive calls", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = make(deps);
  const handle = await adapter.submit(submission());
  const s1 = (await adapter.observe(handle.externalId, owner1)).sequence;
  const s2 = (await adapter.observe(handle.externalId, owner1)).sequence;
  const s3 = (await adapter.observe(handle.externalId, owner1)).sequence;
  assert.ok(s1 < s2 && s2 < s3, `sequences ${s1},${s2},${s3} must increase`);
});

test("observe: lastProgressAt is surfaced when the snapshot knows it", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = make(deps);
  const handle = await adapter.submit(submission());
  deps.observe.set({ lastProgressAt: "2026-10-15T00:00:00Z" });
  const observation = await adapter.observe(handle.externalId, owner1);
  assert.equal(observation.lastProgressAt, "2026-10-15T00:00:00Z");
});

test("observe: a stale owner throws StaleFencingTokenError", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = make(deps);
  const handle = await adapter.submit(submission());
  const newer: AutoSpecOwner = { ownerId: "pi-b", fencingToken: 4 };
  await adapter.cancel(handle.externalId, newer, "takeover");
  await assert.rejects(adapter.observe(handle.externalId, owner1), StaleFencingTokenError);
});

test("cancel: happy path cancels through the external-entry cancel function", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = make(deps);
  const handle = await adapter.submit(submission());
  const result = await adapter.cancel(handle.externalId, owner1, "operator stop");
  assert.deepEqual(result, { cancelled: true, stale: false });
  assert.equal(deps.cancel.calls.length, 1);
  assert.equal(deps.cancel.calls[0]!.id, handle.externalId);
  assert.equal(deps.cancel.calls[0]!.reason, "operator stop");
});

test("cancel: a terminal run cancels to false without throwing and does not re-cancel", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = make(deps);
  const handle = await adapter.submit(submission());
  const first = await adapter.cancel(handle.externalId, owner1, "stop");
  assert.equal(first.cancelled, true);
  const second = await adapter.cancel(handle.externalId, owner1, "again");
  assert.equal(second.cancelled, false);
  assert.equal(second.stale, false);
  // The external cancel path saw the second attempt (it is idempotent), but
  // nothing threw and the caller is not stale.
  assert.equal(deps.cancel.calls.length, 2);
});

test("cancel: a stale owner reports stale:true without throwing", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = make(deps);
  const handle = await adapter.submit(submission());
  const newer: AutoSpecOwner = { ownerId: "pi-b", fencingToken: 4 };
  const takeover = await adapter.cancel(handle.externalId, newer, "takeover");
  assert.equal(takeover.cancelled, true);
  const late = await adapter.cancel(handle.externalId, owner1, "late");
  assert.deepEqual(late, { cancelled: false, stale: true });
});

test("observe: a read-only observer does not steal the fencing holder", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = make(deps);
  const a: AutoSpecOwner = { ownerId: "pi-a", fencingToken: 1 };
  const b: AutoSpecOwner = { ownerId: "pi-b", fencingToken: 2 };
  const c: AutoSpecOwner = { ownerId: "pi-c", fencingToken: 0 };
  const handle = await adapter.submit(submission({ owner: a }));
  // B only reads state; its higher token must not make it the holder.
  await adapter.observe(handle.externalId, b);
  // Write path as original holder A still succeeds (A is NOT stale).
  const cancel = await adapter.cancel(handle.externalId, a, "stop");
  assert.deepEqual(cancel, { cancelled: true, stale: false });
  // A stale reader (token below the holder) is still fenced out.
  await assert.rejects(adapter.observe(handle.externalId, c), StaleFencingTokenError);
});

test("observe: a stale owner (token below the holder) still throws StaleFencingTokenError", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = make(deps);
  const handle = await adapter.submit(submission()); // holder is pi-a@3
  const stale: AutoSpecOwner = { ownerId: "pi-z", fencingToken: 2 };
  await assert.rejects(adapter.observe(handle.externalId, stale), StaleFencingTokenError);
});

test("createConcreteAutoSpecAdapter: factory returns an adapter usable by submit (smoke)", async () => {
  const deps = { submit: stubSubmit(), observe: stubObserve(), cancel: stubCancel() };
  const adapter = createConcreteAutoSpecAdapter({
    submit: deps.submit.fn,
    observe: deps.observe.fn,
    cancel: deps.cancel.fn,
  });
  assert.equal(adapter.name, "autospec");
  const handle = await adapter.submit(submission());
  assert.equal(handle.accepted, true);
  assert.equal(handle.externalId, "MSN-ext-1");
  assert.equal(deps.submit.calls.length, 1);
});
