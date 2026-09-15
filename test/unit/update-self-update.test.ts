/**
 * Running the update.
 *
 * The rules are tested in `update-version-check.test.ts`; what matters here is
 * that a session is never delayed, never failed, and never has a merge invented
 * on its behalf by a background task.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CHECK_INTERVAL_MS, checkForUpdate, shouldCheck } from "../../src/update/selfUpdate.ts";

const BEHIND = ["# branch.oid old", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +0 -3"].join(
  "\n",
);
const CURRENT = ["# branch.oid new", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +0 -0"].join(
  "\n",
);

/** A git that answers from a script and records what it was asked. */
function fakeGit(script: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
    const key = args[0] === "rev-parse" && args[1] === "--is-inside-work-tree" ? "inside" : (args[0] as string);
    const hit = script[key] ?? script[args.join(" ")];
    return { code: hit?.code ?? 0, stdout: hit?.stdout ?? "", stderr: hit?.stderr ?? "" };
  };
  return { git, calls, ran: (cmd: string) => calls.some((c) => c[0] === cmd) };
}

test("self-update: a clean checkout behind upstream is fast-forwarded when asked", async () => {
  const g = fakeGit({
    inside: { stdout: "true" },
    status: { stdout: BEHIND },
    merge: { code: 0 },
    "rev-parse HEAD": { stdout: "newsha" },
  });
  const result = await checkForUpdate({ cwd: "/repo", git: g.git, apply: true });

  assert.equal(result.decision.action, "update");
  assert.equal(result.applied, true);
  const merge = g.calls.find((c) => c[0] === "merge");
  assert.ok(merge?.includes("--ff-only"), "a background task must never invent a merge commit");
});

test("self-update: reporting mode never mutates the checkout", async () => {
  const g = fakeGit({ inside: { stdout: "true" }, status: { stdout: BEHIND } });
  const result = await checkForUpdate({ cwd: "/repo", git: g.git, apply: false });

  assert.equal(result.decision.action, "update");
  assert.equal(result.applied, false);
  assert.equal(g.ran("merge"), false);
});

test("self-update: a refused fast-forward is reported, not forced", async () => {
  const g = fakeGit({
    inside: { stdout: "true" },
    status: { stdout: BEHIND },
    merge: { code: 128, stderr: "fatal: Not possible to fast-forward, aborting.\nmore detail" },
  });
  const result = await checkForUpdate({ cwd: "/repo", git: g.git, apply: true });

  assert.equal(result.applied, false);
  assert.equal(result.decision.action, "report");
  assert.match(result.decision.reason, /Not possible to fast-forward/);
  assert.doesNotMatch(result.decision.reason, /more detail/, "one line, not a wall of git output");
});

test("self-update: a fetch failure degrades to judging local refs", async () => {
  // Offline, no credentials, no remote — normal conditions, not errors.
  const g = fakeGit({
    inside: { stdout: "true" },
    fetch: { code: 128, stderr: "could not resolve host" },
    status: { stdout: BEHIND },
  });
  const result = await checkForUpdate({ cwd: "/repo", git: g.git, apply: false });

  assert.equal(result.unavailable, undefined, "a failed fetch is not an unavailable check");
  assert.equal(result.decision.action, "update");
});

test("self-update: offline mode does not touch the network at all", async () => {
  const g = fakeGit({ inside: { stdout: "true" }, status: { stdout: CURRENT } });
  await checkForUpdate({ cwd: "/repo", git: g.git, offline: true });
  assert.equal(g.ran("fetch"), false);
});

test("self-update: a directory that is not a repo is silence, not an error", async () => {
  const g = fakeGit({ inside: { code: 128, stderr: "not a git repository" } });
  const result = await checkForUpdate({ cwd: "/tmp", git: g.git, apply: true });

  assert.equal(result.decision.action, "skip");
  assert.match(result.unavailable ?? "", /not a git checkout/);
  assert.equal(g.ran("fetch"), false, "and it stops before reaching the network");
});

test("self-update: a throwing git never escapes into the session", async () => {
  const result = await checkForUpdate({
    cwd: "/repo",
    git: async () => {
      throw new Error("spawn ENOENT");
    },
    apply: true,
  });

  assert.equal(result.applied, false);
  assert.match(result.unavailable ?? "", /ENOENT/);
});

test("self-update: uncommitted work is never pulled over, even with apply", async () => {
  const g = fakeGit({
    inside: { stdout: "true" },
    status: { stdout: `${BEHIND}\n1 .M N... 100644 100644 100644 a b src/x.ts` },
  });
  const result = await checkForUpdate({ cwd: "/repo", git: g.git, apply: true });

  assert.equal(result.applied, false);
  assert.equal(result.decision.action, "report");
  assert.equal(g.ran("merge"), false, "the guarantee that matters most");
});

// ─── Throttling ─────────────────────────────────────────────────────────────

test("self-update: a first run always checks", () => {
  assert.equal(shouldCheck(undefined, 1_000), true);
});

test("self-update: checks are throttled so session start is not a network call", () => {
  const now = 10 * 60 * 60 * 1000;
  assert.equal(shouldCheck(now - 1_000, now), false);
  assert.equal(shouldCheck(now - DEFAULT_CHECK_INTERVAL_MS, now), true);
});

test("self-update: a backwards clock does not lock out checking", () => {
  // Suspend/resume and NTP corrections move clocks backwards. Waiting for the
  // clock to catch up could mean never checking again.
  assert.equal(shouldCheck(5_000, 1_000), true);
});
