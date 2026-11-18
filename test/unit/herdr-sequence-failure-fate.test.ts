/**
 * #683 — what a refused sequence allocation costs, and what the operator can see about it.
 *
 * A lock whose holder is alive is not stale, so a writer giving up at its budget is correct behaviour. What was
 * not correct is the consequence: the rejection reached `ControlPlaneIngest.emitDraft`, which swallowed it and
 * returned false, so the envelope never reached the outbox and left no record anywhere — a starved host looked
 * exactly like an operator who had disabled ingest. These cases pin the three answers now written down:
 *
 *   1. a live holder gets one more attempt (the measured worst contended wait on a loaded host is ~0.2 s against
 *      a 5 s budget, so the starvation is a moment, not a condition); holders in these cases are released by the
 *      test after a recorded refusal, never by a timer, so the retry is proven rather than raced;
 *   2. if that fails too the envelope is dead-lettered as `sequence_unavailable` — durable, inspectable, counted;
 *   3. a persistent cause (corrupt state) still throws and writes nothing, because dead-lettering a broken store
 *      would eat an event stream one envelope at a time and look handled.
 *
 * The telemetry half is pinned too: the holder, the path and the elapsed wait ride as fields, not only as prose,
 * and a writer that keeps refusing does not go quiet after its first notice.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";
import { withFileLock } from "../../src/runtime/herdr/portableLock.ts";
import {
  SEQUENCE_LOCK_DEFAULT_MS,
  SourceSequence,
  resetSequenceBudgetNoticeForTests,
  resolveSequenceLockMs,
} from "../../src/runtime/herdr/sourceSequence.ts";
import { type TelemetryNotice, resetTelemetrySinks, setTelemetrySink } from "../../src/telemetry/sink.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-seq683-"));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const draft = (id: string) => ({
  event_id: id,
  occurred_at: "2026-11-17T10:00:00Z",
  entity_type: "session",
  entity_id: "s1",
  event_type: "session.updated",
  payload: { note: "kept" },
});
const lines = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/**
 * Take `sequence-pi.json.lock` and hold it until the case says otherwise.
 *
 * The holder used to release on a timer, which turned these cases into races: "released at 260 ms" only means
 * "after the first attempt's 200 ms budget" while the host is idle, and a timer can fire hundreds of
 * milliseconds late on a loaded CI agent -- which converts a retry that must succeed into a second refusal and a
 * red pipeline for a correct implementation. Release is driven by the case now, after a fact the module itself
 * records (a counted refusal), so nothing here depends on when the host happened to run two timers. Same lesson
 * as #681/#682/#689.
 *
 * Acquisition is asynchronous, so `acquired` resolves only once the owner record is on disk -- otherwise the
 * waiter would win the race the case is meant to create.
 */
function holdSequenceLock(dir: string): { acquired: Promise<void>; release: () => void; done: Promise<void> } {
  const lockPath = join(dir, "sequence-pi.json.lock");
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = withFileLock(lockPath, async () => void (await gate), { timeoutMs: 60_000 });
  return { acquired: waitForFile(lockPath), release, done };
}

/** Wait for a condition the module records, with a ceiling generous enough to be a wait and not a deadline. */
async function waitUntil(label: string, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 4000 && !predicate(); i++) await sleep(5);
  assert.ok(predicate(), label);
}

async function waitForFile(path: string): Promise<void> {
  await waitUntil(`lock file never appeared: ${path}`, () => existsSync(path));
}

/** Run `fn` with the operator knob set to `ms`, then put the environment back. */
async function withBudget<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PI_ENGINEERING_SEQUENCE_LOCK_MS;
  process.env.PI_ENGINEERING_SEQUENCE_LOCK_MS = String(ms);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PI_ENGINEERING_SEQUENCE_LOCK_MS;
    else process.env.PI_ENGINEERING_SEQUENCE_LOCK_MS = previous;
  }
}

/** Exactly one notice, so the cases below read as assertions about its content, not its count. */
function only(notices: TelemetryNotice[]): TelemetryNotice {
  assert.equal(notices.length, 1, `expected exactly one notice, got ${notices.length}`);
  const [first] = notices;
  assert.ok(first);
  return first;
}

/** The `index`th notice, with the total pinned in the same assertion. */
function nth(notices: TelemetryNotice[], index: number, total: number): TelemetryNotice {
  assert.equal(notices.length, total, `expected ${total} notices, got ${notices.length}`);
  const notice = notices[index];
  assert.ok(notice);
  return notice;
}

function collect(key: string): { notices: TelemetryNotice[]; off: () => void } {
  const notices: TelemetryNotice[] = [];
  const off = setTelemetrySink((n) => {
    if (n.key === key) notices.push(n);
  });
  return { notices, off };
}

test("#683: a live holder that yields within the second attempt costs nothing", async () => {
  const dir = tmp();
  const { notices, off } = collect("herdr-sequence-failure");
  try {
    await withBudget(200, async () => {
      const store = new EnvelopeStore({ dir, source: "pi", sequenceBlock: 1 });
      const holder = holdSequenceLock(dir);
      await holder.acquired;
      const staging = store.stage(draft("e1"));
      // Release once the first attempt has demonstrably expired, so the retry starts with a full budget in
      // front of an unlocked file. Nothing here says "wait 260ms" -- the fact being waited for is the store's
      // own counter, which is what the retry is actually conditioned on.
      await waitUntil("the first allocation attempt never failed", () => store.stats().sequenceFailures >= 1);
      holder.release();
      const staged = await staging;
      await holder.done;
      assert.deepEqual(
        { status: staged.status, failures: store.stats().sequenceFailures },
        // The retry is inside stage(), so the envelope is staged and the refusal is still counted.
        { status: "staged", failures: 1 },
      );
      assert.equal((await store.outbox.peek()).length, 1, "the envelope reached the outbox");
      assert.equal(
        (() => {
          try {
            return lines(store.outbox.deadLetterFile).length;
          } catch {
            return 0;
          }
        })(),
        0,
        "a recovered allocation must not dead-letter anything",
      );
    });
  } finally {
    off();
    resetTelemetrySinks();
    rmSync(dir, { recursive: true, force: true });
  }
  // The refusal itself is still reported even though the retry recovered it: a host that is contending is
  // information, and the distinction that matters (lost vs. kept) is the dead letter, not the notice.
  assert.equal((only(notices).detail as Record<string, unknown>).cause, "live_lock_holder");
});

test("#683: two refusals dead-letter the envelope as sequence_unavailable instead of losing it", async () => {
  const dir = tmp();
  const { notices, off } = collect("herdr-sequence-failure");
  try {
    await withBudget(100, async () => {
      const store = new EnvelopeStore({ dir, source: "pi", sequenceBlock: 1 });
      // Nobody releases: both attempts must expire on their own budgets, and the envelope must survive that.
      const holder = holdSequenceLock(dir);
      await holder.acquired;
      const staged = await store.stage(draft("e2"));
      assert.equal(staged.status, "dead_lettered");
      assert.equal((await store.outbox.peek()).length, 0, "nothing was queued behind the refusal");
      assert.equal(await store.sequence.peek(), 1, "a refused allocation burns no sequence number");
      assert.equal(store.stats().deadLettered, 1);
      const dl = lines(store.outbox.deadLetterFile);
      assert.equal(dl.length, 1);
      const [deadLetter] = dl;
      assert.ok(deadLetter);
      assert.equal(deadLetter.reason, "sequence_unavailable");
      // `recordUndeliverable` wraps whatever it is given as `{ at, reason, envelope }`, so the draft's own
      // identity has to survive inside it -- otherwise the record names a loss without saying what was lost.
      const kept = deadLetter.envelope as Record<string, unknown>;
      assert.equal(kept.event_type, "session.updated");
      assert.equal(kept.entity_type, "session");
      assert.equal(kept.entity_id, "s1");
      assert.equal(kept.occurred_at, "2026-11-17T10:00:00Z");
      assert.equal(kept.payload_preview, '{"note":"kept"}');
      assert.equal(kept.payload_bytes, Buffer.byteLength('{"note":"kept"}'));
      assert.equal(typeof kept.allocation_error, "string");
      assert.match(String(kept.allocation_error), /timed out after 100ms waiting for lock/);
      holder.release();
      await holder.done;
      // The warning is still emitted, and it names the budget and the knob that raises it.
      assert.match(only(notices).text, /PI_ENGINEERING_SEQUENCE_LOCK_MS/);
    });
  } finally {
    off();
    resetTelemetrySinks();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#683: the refusal reports holder, path, elapsed wait and budget as fields, not only as prose", async () => {
  const dir = tmp();
  const { notices, off } = collect("herdr-sequence-failure");
  try {
    await withBudget(80, async () => {
      const seq = new SourceSequence({ dir, source: "pi", blockSize: 1 });
      const holder = holdSequenceLock(dir);
      await holder.acquired;
      await assert.rejects(() => seq.next(), /timed out after 80ms/);
      holder.release();
      await holder.done;
    });
  } finally {
    off();
    resetTelemetrySinks();
    rmSync(dir, { recursive: true, force: true });
  }
  const detail = only(notices).detail as Record<string, unknown>;
  assert.equal(detail.source, "pi");
  assert.equal(detail.cause, "live_lock_holder");
  assert.equal(detail.budget_ms, 80);
  assert.equal(detail.knob, "80");
  assert.equal(detail.failures, 1);
  assert.equal(detail.lock_path, join(dir, "sequence-pi.json.lock"));
  assert.equal(typeof detail.waited_ms, "number");
  assert.ok((detail.waited_ms as number) >= 80, "the elapsed wait is the waiter's own clock, not the budget");
  // The holder record is the one portableLock wrote for this process: pid is what an operator would act on.
  assert.equal(typeof detail.holder, "string");
  assert.match(String(detail.holder), /"pid":\s*\d+/);
});

test("#683: a writer that keeps refusing keeps reporting; onset after a success reports again", async () => {
  const dir = tmp();
  const { notices, off } = collect("herdr-sequence-failure");
  try {
    const seq = new SourceSequence({ dir, source: "pi", lockTimeoutMs: 40, blockSize: 1 });
    const holder = holdSequenceLock(dir);
    await holder.acquired;
    for (let i = 0; i < 12; i++) await assert.rejects(() => seq.next(), /timed out/);
    assert.equal(seq.failures, 12);
    // Onset (1) and then every tenth refusal (11): visible without one line per attempt.
    assert.equal((nth(notices, 1, 2).detail as Record<string, unknown>).failures, 11);
    // Released, and awaited: the lock file is gone before the next allocation starts, so this success cannot
    // lose a race against the holder's own cleanup.
    holder.release();
    await holder.done;
    assert.equal(await seq.next(), 1);
    const after = holdSequenceLock(dir);
    await after.acquired;
    await assert.rejects(() => seq.next(), /timed out/);
    after.release();
    await after.done;
    // A fresh episode after a success is a new onset, not a continuation.
    assert.equal((nth(notices, 2, 3).detail as Record<string, unknown>).failures, 13);
  } finally {
    off();
    resetTelemetrySinks();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#683: the effective budget is announced once per process, naming the knob in force", async () => {
  const dir = tmp();
  const { notices, off } = collect("herdr-sequence-budget");
  try {
    resetSequenceBudgetNoticeForTests();
    await withBudget(9_000, async () => {
      new SourceSequence({ dir, source: "pi" });
      new SourceSequence({ dir, source: "pi", blockSize: 4 });
    });
  } finally {
    off();
    resetTelemetrySinks();
    rmSync(dir, { recursive: true, force: true });
  }
  // Announced once per process, not once per allocator.
  const announcement = only(notices);
  assert.match(announcement.text, /budget: 9000ms \(PI_ENGINEERING_SEQUENCE_LOCK_MS=9000\)/);
  assert.deepEqual(announcement.detail, { budget_ms: 9_000, knob: "9000", default_ms: 5_000 });
});

test("#683: an unset knob announces the default rather than nothing", async () => {
  const dir = tmp();
  const { notices, off } = collect("herdr-sequence-budget");
  try {
    resetSequenceBudgetNoticeForTests();
    const previous = process.env.PI_ENGINEERING_SEQUENCE_LOCK_MS;
    delete process.env.PI_ENGINEERING_SEQUENCE_LOCK_MS;
    try {
      new SourceSequence({ dir, source: "pi" });
    } finally {
      if (previous !== undefined) process.env.PI_ENGINEERING_SEQUENCE_LOCK_MS = previous;
    }
  } finally {
    off();
    resetTelemetrySinks();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(resolveSequenceLockMs({}), SEQUENCE_LOCK_DEFAULT_MS);
  const announcement = only(notices);
  assert.match(
    announcement.text,
    new RegExp(`budget: ${SEQUENCE_LOCK_DEFAULT_MS}ms \\(PI_ENGINEERING_SEQUENCE_LOCK_MS=unset`),
  );
  assert.equal((announcement.detail as Record<string, unknown>).knob, null);
});

test("#683: a persistent cause still throws and writes nothing -- only lock refusals are dead-lettered", async () => {
  const dir = tmp();
  try {
    await withBudget(120, async () => {
      const store = new EnvelopeStore({ dir, source: "pi", sequenceBlock: 1 });
      await store.stage(draft("ok"));
      // A corrupt state file is not a moment of starvation: dead-lettering it would consume the whole stream.
      writeFileSync(join(dir, "sequence-pi.json"), "{bad");
      await assert.rejects(() => store.stage(draft("bad")));
      assert.equal((await store.outbox.peek()).length, 1, "only the envelope staged before the corruption");
      assert.equal(
        (() => {
          try {
            return lines(store.outbox.deadLetterFile).length;
          } catch {
            return 0;
          }
        })(),
        0,
        "a broken store must not be reported as a run of dead letters",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
