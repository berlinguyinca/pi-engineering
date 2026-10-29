/**
 * Startup recovery for an interrupted update (spec §30, issue #483).
 *
 * Validation runs `npm ci` and `npm test` inside the session that started the
 * transaction, so an ordinary session exit leaves a non-terminal journal
 * behind with an intact candidate. That candidate is parked for re-adoption
 * instead of deleted; only a transaction that may have moved pointers is
 * rolled back, and only a committed transaction survives a crash.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { RuntimeTelemetry } from "../../src/runtime/host/telemetry.ts";
import { InstallLayout } from "../../src/update/installLayout.ts";
import { UpdateJournal, type UpdateJournalRecord } from "../../src/update/journal.ts";
import { parkedCandidate, recoverInterruptedTransaction } from "../../src/update/recovery.ts";
import { applyRetention } from "../../src/update/retention.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const TARGET = "d85a758986774e4dd9217dab066db2ea9659c122";
const RUNNING = "b662443f395d8b464b628a502e8b420e6886f318";

function setup(): { layout: InstallLayout; journal: UpdateJournal; telemetry: RuntimeTelemetry } {
  const root = mkdtempSync(join(tmpdir(), "rt-recovery-"));
  dirs.push(root);
  const layout = new InstallLayout(root);
  return {
    layout,
    journal: new UpdateJournal(layout.journalFile),
    telemetry: new RuntimeTelemetry(join(root, "telemetry.jsonl")),
  };
}

/** The running version the transaction started from, installed and pointed at. */
async function running(layout: InstallLayout): Promise<string> {
  const dir = layout.versionDir(`0.2.0-${RUNNING.slice(0, 12)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");
  await layout.writeMeta(dir, {
    id: `0.2.0-${RUNNING.slice(0, 12)}`,
    version: "0.2.0",
    commit: RUNNING,
    channel: "main",
    source: "t",
    installedAt: new Date(0).toISOString(),
    runtimeApi: 1,
  });
  await layout.setPointer("current", dir);
  return dir;
}

/** A candidate staged by an update that never finished, with its journal record. */
async function staged(
  layout: InstallLayout,
  journal: UpdateJournal,
  phase: "staging" | "validating" | "activating",
  opts: { commit?: string | null; keepCandidate?: boolean } = {},
): Promise<{ record: UpdateJournalRecord; candidate: string; current: string }> {
  const current = await running(layout);
  const candidate = join(layout.stagingDir, "update-d85a75898677-60d05d");
  mkdirSync(candidate, { recursive: true });
  await layout.writeMeta(candidate, {
    id: `0.2.0-${(opts.commit ?? TARGET).slice(0, 12)}`,
    version: "0.2.0",
    commit: opts.commit ?? TARGET,
    channel: "main",
    source: "t",
    installedAt: new Date(0).toISOString(),
    runtimeApi: 1,
  });
  let record = journal.begin({
    transaction: "update-d85a75898677-60d05d",
    kind: "update",
    channel: "main",
    fromVersion: "0.2.0",
    fromCommit: RUNNING,
    toVersion: "0.2.0",
    toCommit: TARGET,
    previousRuntime: current,
    candidateRuntime: null,
    pointers: { current, previous: null },
  });
  record = journal.advance(record, "staging", { candidateRuntime: candidate });
  if (phase !== "staging") record = journal.advance(record, phase);
  if (opts.keepCandidate === false) rmSync(candidate, { recursive: true, force: true });
  return { record, candidate, current };
}

test("an interrupted validation with an intact candidate parks it instead of destroying it", async () => {
  const { layout, journal, telemetry } = setup();
  const { candidate } = await staged(layout, journal, "validating");

  const outcome = await recoverInterruptedTransaction(layout, journal, telemetry, TARGET);

  assert.equal(outcome.action, "resumable");
  assert.ok(existsSync(candidate), "the staged candidate must survive");
  assert.equal(journal.incomplete()?.phase, "validating", "the record stays open so it can be re-adopted");
  assert.equal(journal.incomplete()?.candidateRuntime, candidate);
});

test("parking leaves the running runtime pointed at, untouched", async () => {
  const { layout, journal, telemetry } = setup();
  const { current } = await staged(layout, journal, "validating");

  await recoverInterruptedTransaction(layout, journal, telemetry, TARGET);

  assert.equal(layout.readPointer("current"), current);
});

test("a parked candidate is protected from retention while the journal is open", async () => {
  const { layout, journal, telemetry } = setup();
  const { candidate, current } = await staged(layout, journal, "validating");
  await recoverInterruptedTransaction(layout, journal, telemetry, TARGET);

  const removed = await applyRetention(layout, journal, { keepVersions: 2, keepCheckpoints: 1 });

  assert.ok(existsSync(candidate), `retention removed a re-adoptable candidate: ${removed.staging.join(", ")}`);
  assert.ok(existsSync(current));
});

test("a candidate whose validation was interrupted for a different target is not parked", async () => {
  const { layout, journal, telemetry } = setup();
  const { candidate } = await staged(layout, journal, "validating");

  const outcome = await recoverInterruptedTransaction(layout, journal, telemetry, RUNNING);

  assert.equal(outcome.action, "marked_failed");
  assert.equal(journal.incomplete(), null);
  assert.ok(!existsSync(candidate), "a candidate that no longer names the target is discarded");
});

test("an interrupted transaction whose candidate directory is gone is marked failed", async () => {
  const { layout, journal, telemetry } = setup();
  await staged(layout, journal, "validating", { keepCandidate: false });

  const outcome = await recoverInterruptedTransaction(layout, journal, telemetry, TARGET);

  assert.equal(outcome.action, "marked_failed");
  assert.equal(journal.incomplete(), null);
});

test("a candidate with no readable metadata is not parked", async () => {
  const { layout, journal, telemetry } = setup();
  const { candidate } = await staged(layout, journal, "staging");
  rmSync(join(candidate, ".pi-engineering-install.json"));

  const outcome = await recoverInterruptedTransaction(layout, journal, telemetry, TARGET);

  assert.equal(outcome.action, "marked_failed");
});

test("a transaction that may have mutated pointers is still rolled back to the recorded state", async () => {
  const { layout, journal, telemetry } = setup();
  const { candidate, current } = await staged(layout, journal, "activating");
  // The interrupted process installed the candidate and pointed `current` at it
  // before it died, exactly as the activation path does.
  const versionDir = await layout.install(candidate, "0.2.0-d85a75898677");
  await layout.setPointer("current", versionDir);

  const outcome = await recoverInterruptedTransaction(layout, journal, telemetry, TARGET);

  assert.equal(outcome.action, "rolled_back");
  assert.equal(layout.readPointer("current"), current, "the pointer the journal vouched for is restored");
  const after = journal.read();
  assert.notEqual(after, "corrupt");
  assert.equal((after as UpdateJournalRecord | null)?.phase, "rolled_back");
});

test("parkedCandidate names the staged tree only while it can be re-adopted", async () => {
  const { layout, journal } = setup();
  const { candidate } = await staged(layout, journal, "validating");

  assert.equal(parkedCandidate(layout, journal, TARGET), candidate);
  assert.equal(parkedCandidate(layout, journal, RUNNING), null, "a stale target is not re-adoptable");
  assert.equal(parkedCandidate(layout, journal, null), candidate, "an unpinned target accepts the staged commit");

  journal.advance(journal.incomplete() as UpdateJournalRecord, "failed");
  assert.equal(parkedCandidate(layout, journal, TARGET), null, "a terminal record is not re-adoptable");
});
