/**
 * Update visibility (spec §14, §18): what an update is doing must reach the
 * operator while it runs, and a check that cannot run must be said out loud -
 * a silently disabled update check is how a runtime goes stale for months.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  EngineeringHostExtension,
  clearUpdateStatus,
  updateProgressReporter,
} from "../../src/runtime/host/extension.ts";
import { InstallLayout } from "../../src/update/installLayout.ts";
import { UpdateJournal } from "../../src/update/journal.ts";
import { readUpdateNotice, writeUpdateNotice } from "../../src/update/notice.ts";
import { readPreferences, writePreferences } from "../../src/update/preferences.ts";
import { writeFixtureRuntime } from "../support/runtimeFixtures.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** The status line and the notifications one session would show. */
function ui() {
  const statuses: Array<string | null> = [];
  const notices: Array<{ text: string; level: string }> = [];
  return {
    statuses,
    notices,
    ctx: {
      ui: {
        setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? null),
        notify: (text: string, level = "info") => notices.push({ text, level }),
      },
    },
  };
}

function world(): EngineeringHostExtension {
  const root = mkdtempSync(join(tmpdir(), "rt-visible-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "package");
  writeFixtureRuntime(pkg, `__vis_${process.pid}_${root.length}`, { value: "A" });
  // No install(): the automatic check needs the updater, not a live host.
  return new EngineeringHostExtension({
    installRoot: join(root, "install"),
    packageRoot: pkg,
    entry: "runtime.ts",
    baseline: true,
    autoUpdateCheck: false,
  });
}

/** Script the updater: a unit test never touches the network. */
function stubUpdates(ext: EngineeringHostExtension, stub: Record<string, unknown>): void {
  Object.defineProperty(ext, "updates", { value: stub, writable: true, configurable: true });
}

const TARGET = {
  sha: "cafe1234cafe1234cafe1234cafe1234cafe1234",
  ref: "refs/pi-src/heads/main",
  metadata: { version: "0.3.0" },
};

function checkResult(over: Record<string, unknown> = {}) {
  return {
    current: { version: "0.2.0", commit: "ab".repeat(20), label: "0.2.0", root: "/nope", checkout: false },
    channel: "main",
    target: null,
    upToDate: false,
    pi: { ok: true },
    migration: "none",
    ...over,
  };
}

/**
 * An update that was interrupted mid-validation by a session exit: an intact
 * staged candidate and the open journal record that points at it (issue #483).
 */
async function parkStagedCandidate(ext: EngineeringHostExtension): Promise<string> {
  mkdirSync(ext.layout.stagingDir, { recursive: true });
  const candidate = join(ext.layout.stagingDir, "update-cafe1234cafe-60d05d");
  mkdirSync(candidate, { recursive: true });
  await ext.layout.writeMeta(candidate, {
    id: "0.3.0-cafe1234cafe",
    version: "0.3.0",
    commit: TARGET.sha,
    channel: "main",
    source: "t",
    installedAt: new Date().toISOString(),
    runtimeApi: 1,
  });
  const journal = new UpdateJournal(ext.layout.journalFile);
  const record = journal.begin({
    transaction: "update-cafe1234cafe-60d05d",
    kind: "update",
    channel: "main",
    fromVersion: "0.2.0",
    fromCommit: "ab".repeat(20),
    toVersion: "0.3.0",
    toCommit: TARGET.sha,
    previousRuntime: null,
    candidateRuntime: null,
    pointers: { current: null, previous: null },
  });
  journal.advance(journal.advance(record, "staging", { candidateRuntime: candidate }), "validating");
  return candidate;
}

function handover() {
  const result = {
    ok: true,
    kind: "update",
    phase: "committed",
    rolledBack: false,
    untouched: false,
    waitedForSafePoint: true,
    durationMs: 1,
  };
  const done = Promise.resolve({ result, record: {} });
  return {
    status: "handover",
    check: checkResult({ target: TARGET, upToDate: false }),
    steps: [],
    task: { promise: done, blocking: [], onBlocking: () => () => {} },
    done,
  };
}

test("progress reaches the status line as each step happens", () => {
  const u = ui();
  const report = updateProgressReporter(u.ctx.ui);
  report("updating 0.2.0 → 0.3.0 on main (cafe1234cafe)");
  report("✓ fetched (0.4s)");
  clearUpdateStatus(u.ctx);
  assert.deepEqual(u.statuses, [
    "Pi Engineering update · updating 0.2.0 → 0.3.0 on main (cafe1234cafe)",
    "Pi Engineering update · ✓ fetched (0.4s)",
    null,
  ]);
});

test("a status line the session cannot show never breaks the update", () => {
  const report = updateProgressReporter({
    setStatus: () => {
      throw new Error("session replaced");
    },
  });
  assert.doesNotThrow(() => report("✓ staged"));
  assert.doesNotThrow(() =>
    clearUpdateStatus({
      ui: {
        setStatus: () => {
          throw new Error("gone");
        },
      },
    }),
  );
  assert.doesNotThrow(() => updateProgressReporter(undefined)("✓ staged"));
});

test("a check that cannot run is reported to the operator", async () => {
  const ext = world();
  const u = ui();
  stubUpdates(ext, {
    check: async () =>
      checkResult({
        failure: "installed runtime history is shallow (its oldest commit is cafe1234cafe, not the repository root)",
      }),
    update: async () => {
      throw new Error("nothing may be installed when the check failed");
    },
  });

  const check = await ext.automaticCheck(u.ctx as never);
  assert.match(check?.failure ?? "", /history is shallow/);
  const text = u.notices.map((n) => n.text).join("\n");
  assert.match(text, /update check failed/);
  assert.match(text, /history is shallow/);
  assert.equal(u.notices.at(-1)?.level, "warning");
});

test("an unexpected failure in the automatic check is not swallowed", async () => {
  const ext = world();
  const u = ui();
  stubUpdates(ext, {
    check: async () => {
      throw new Error("cache directory is not a git repository");
    },
  });
  const check = await ext.automaticCheck(u.ctx as never);
  assert.equal(check, undefined);
  assert.match(u.notices.map((n) => n.text).join("\n"), /not a git repository/);
});

test("an automatic install reports every step, then its outcome", async () => {
  const ext = world();
  const prefs = readPreferences(ext.layout.preferencesFile);
  await writePreferences(ext.layout.preferencesFile, { ...prefs, autoInstall: true });
  const u = ui();
  const steps: string[] = [];
  let reported: Array<string | null> = [];
  stubUpdates(ext, {
    check: async () => checkResult({ target: TARGET }),
    update: async (_req: unknown, progress: (line: string) => void) => {
      for (const line of [
        "updating 0.2.0 → 0.3.0 on main (cafe1234cafe)",
        "✓ fetched (0.4s)",
        "✓ staged (1.2s)",
        "✓ validated (3.9s)",
        "✓ installed; waiting for a safe point to activate",
      ]) {
        steps.push(line);
        progress(line);
      }
      reported = [...u.statuses];
      return handover();
    },
  });

  await ext.automaticCheck(u.ctx as never);

  // Each step was on the status line while the run was still in flight.
  assert.deepEqual(reported, [
    "Pi Engineering 0.2.0-abababababab · 0.3.0-cafe1234cafe available",
    ...steps.map((s) => `Pi Engineering update · ${s}`),
  ]);
  const text = u.notices.map((n) => n.text).join("\n");
  assert.match(text, /0\.2\.0-abababababab → 0\.3\.0-cafe1234cafe: updating automatically/);
  assert.match(text, /0\.3\.0-cafe1234cafe activated\./);
  assert.equal(u.statuses.at(-1), null, "the status line is taken back when the run ends");
});

test("an available update is named by version id, never by the bare package version", async () => {
  const ext = world();
  const u = ui();
  // The real shape of this repository: every release reports version 0.2.0.
  stubUpdates(ext, {
    check: async () =>
      checkResult({
        target: { ...TARGET, metadata: { version: "0.2.0" } },
      }),
  });

  await ext.automaticCheck(u.ctx as never);

  assert.equal(u.statuses[0], "Pi Engineering 0.2.0-abababababab · 0.2.0-cafe1234cafe available");
});

test("an outcome no session could be shown is left for the next session", async () => {
  const ext = world();
  const prefs = readPreferences(ext.layout.preferencesFile);
  await writePreferences(ext.layout.preferencesFile, { ...prefs, autoInstall: true });
  stubUpdates(ext, {
    check: async () => checkResult({ target: TARGET }),
    update: async () => ({ status: "failed", stage: "validate", reason: "probe: candidate exported nothing" }),
  });

  // No context at all: there is nobody to tell.
  await ext.automaticCheck(undefined);

  const pending = readUpdateNotice(ext.layout.noticeFile);
  assert.equal(pending?.kind, "failed");
  assert.match(pending?.text ?? "", /validate/);
  assert.match(pending?.text ?? "", /0\.2\.0-abababababab → 0\.3\.0-cafe1234cafe/);
});

test("an outcome the operator was told about is not also queued for the next session", async () => {
  const ext = world();
  const prefs = readPreferences(ext.layout.preferencesFile);
  await writePreferences(ext.layout.preferencesFile, { ...prefs, autoInstall: true });
  const u = ui();
  stubUpdates(ext, {
    check: async () => checkResult({ target: TARGET }),
    update: async () => ({ status: "failed", stage: "validate", reason: "probe: candidate exported nothing" }),
  });

  await ext.automaticCheck(u.ctx as never);

  assert.ok(u.notices.length > 0, "the session was told");
  assert.equal(readUpdateNotice(ext.layout.noticeFile), null);
});

test("a pending notice is delivered once and then never again", async () => {
  const ext = world();
  const u = ui();
  writeUpdateNotice(ext.layout.noticeFile, {
    kind: "interrupted",
    transaction: "update-d85a75898677-60d05d",
    text: "Pi Engineering 0.2.0-abababababab → 0.3.0-cafe1234cafe was interrupted during validating; run /engineering update to retry.",
    at: new Date().toISOString(),
  });

  const delivered = ext.deliverPendingNotice(u.ctx as never);
  assert.equal(delivered?.kind, "interrupted");
  assert.equal(u.notices.length, 1);

  assert.equal(ext.deliverPendingNotice(u.ctx as never), null);
  assert.equal(u.notices.length, 1, "a delivered notice is not shown twice");
});

test("recovery reports what it did to another process's transaction, by version id", async () => {
  const ext = world();
  await parkStagedCandidate(ext);

  const outcome = await ext.recoverOnStartup();

  assert.equal(outcome.action, "resumable");
  const pending = readUpdateNotice(ext.layout.noticeFile);
  assert.equal(pending?.kind, "interrupted");
  assert.match(pending?.text ?? "", /0\.2\.0-abababababab → 0\.3\.0-cafe1234cafe/);
  assert.match(pending?.text ?? "", /validating/);
});

test("a parked candidate is continued automatically when automatic install is on", async () => {
  const ext = world();
  const prefs = readPreferences(ext.layout.preferencesFile);
  await writePreferences(ext.layout.preferencesFile, { ...prefs, autoInstall: true });
  await parkStagedCandidate(ext);
  const started: number[] = [];
  stubUpdates(ext, {
    check: async () => checkResult({ target: TARGET, upToDate: true }),
    update: async () => {
      started.push(1);
      return { status: "up_to_date", check: checkResult({ target: TARGET, upToDate: true }) };
    },
  });

  const outcome = await ext.recoverOnStartup();

  assert.equal(outcome.action, "resumable");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(started.length, 1, "the parked transaction was continued without being asked");
});

test("a parked candidate waits for /engineering update when automatic install is off", async () => {
  const ext = world();
  await parkStagedCandidate(ext);
  const started: number[] = [];
  stubUpdates(ext, {
    check: async () => checkResult({ target: TARGET, upToDate: true }),
    update: async () => {
      started.push(1);
      return { status: "up_to_date", check: checkResult({ target: TARGET, upToDate: true }) };
    },
  });

  await ext.recoverOnStartup();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(started.length, 0, "nothing may be installed without autoInstall");
});

test("a failed automatic install tells the operator the runtime was untouched", async () => {
  const ext = world();
  const prefs = readPreferences(ext.layout.preferencesFile);
  await writePreferences(ext.layout.preferencesFile, { ...prefs, autoInstall: true });
  const u = ui();
  stubUpdates(ext, {
    check: async () => checkResult({ target: TARGET }),
    update: async () => ({ status: "failed", stage: "validate", reason: "probe: candidate exported nothing" }),
  });

  await ext.automaticCheck(u.ctx as never);
  const last = u.notices.at(-1);
  assert.equal(last?.level, "warning");
  assert.match(last?.text ?? "", /validate/);
  assert.match(last?.text ?? "", /running runtime was not touched/);
  assert.equal(u.statuses.at(-1), null);
});
