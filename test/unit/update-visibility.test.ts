/**
 * Update visibility (spec §14, §18): what an update is doing must reach the
 * operator while it runs, and a check that cannot run must be said out loud -
 * a silently disabled update check is how a runtime goes stale for months.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  EngineeringHostExtension,
  clearUpdateStatus,
  updateProgressReporter,
} from "../../src/runtime/host/extension.ts";
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
    "Pi Engineering 0.2.0 · 0.3.0 available",
    ...steps.map((s) => `Pi Engineering update · ${s}`),
  ]);
  const text = u.notices.map((n) => n.text).join("\n");
  assert.match(text, /0\.2\.0 → 0\.3\.0: updating automatically/);
  assert.match(text, /0\.3\.0 activated\./);
  assert.equal(u.statuses.at(-1), null, "the status line is taken back when the run ends");
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
