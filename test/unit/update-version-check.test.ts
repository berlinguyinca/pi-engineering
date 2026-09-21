/**
 * Deciding whether to self-update.
 *
 * Written after a real incident: an operator hit the exact failure this package
 * had just fixed, and the giveaway was a notice in their session that the fix
 * had DELETED. Their pi was loading a checkout from before the merge, and
 * nothing in the session said so. A fix that is installed but not loaded is
 * worse than an unfixed bug, because the evidence the operator reports comes
 * from code that no longer exists.
 *
 * The other half of these tests is the opposite risk: this pulls code into a
 * directory someone may be working in, and no amount of being up to date is
 * worth uncommitted work.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type RepoObservation, decideUpdate, describeUpdate, parseStatus } from "../../src/update/versionCheck.ts";

function obs(over: Partial<RepoObservation> = {}): RepoObservation {
  return { branch: "main", upstream: "origin/main", dirty: false, ahead: 0, behind: 0, ...over };
}

test("update: a clean checkout behind its upstream is fast-forwarded", () => {
  const d = decideUpdate(obs({ behind: 3 }));
  assert.equal(d.action, "update");
  assert.match(d.reason, /fast-forward 3 commit/);
});

test("update: an up-to-date checkout does nothing", () => {
  assert.equal(decideUpdate(obs()).action, "current");
});

test("update: uncommitted work is never pulled over", () => {
  // The failure that actually costs something. A pull onto a dirty tree can
  // refuse, stash or conflict, and none of those belong in a background task.
  const d = decideUpdate(obs({ behind: 5, dirty: true }));
  assert.equal(d.action, "report");
  assert.match(d.reason, /uncommitted changes/);
});

test("update: a diverged branch is reported, never merged", () => {
  // Merging is a decision about someone's work, not a maintenance task.
  const d = decideUpdate(obs({ behind: 2, ahead: 1 }));
  assert.equal(d.action, "report");
  assert.match(d.reason, /diverged/);
});

test("update: unpushed local commits are not a problem to solve", () => {
  const d = decideUpdate(obs({ ahead: 2 }));
  assert.equal(d.action, "current");
  assert.match(d.reason, /nothing to pull/);
});

test("update: a detached HEAD is left alone entirely", () => {
  assert.equal(decideUpdate(obs({ branch: null })).action, "skip");
});

test("update: a branch with no upstream is left alone", () => {
  // A working branch that was never pushed. Guessing an upstream would pull
  // someone else's code into it.
  const d = decideUpdate(obs({ branch: "feat/mine", upstream: null, behind: 9 }));
  assert.equal(d.action, "skip");
  assert.match(d.reason, /tracks no upstream/);
});

test("update: a dirty tree that is NOT behind is still current", () => {
  // Uncommitted work is only relevant when there is something to pull.
  assert.equal(decideUpdate(obs({ dirty: true })).action, "current");
});

// ─── Parsing ────────────────────────────────────────────────────────────────

const CLEAN_BEHIND = [
  "# branch.oid abc123",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +0 -4",
].join("\n");

test("update: porcelain v2 headers are read", () => {
  const o = parseStatus(CLEAN_BEHIND);
  assert.equal(o.branch, "main");
  assert.equal(o.upstream, "origin/main");
  assert.equal(o.behind, 4);
  assert.equal(o.ahead, 0);
  assert.equal(o.dirty, false);
  assert.equal(o.head, "abc123");
});

test("update: any change line marks the tree dirty", () => {
  for (const change of [
    "1 .M N... 100644 100644 100644 abc def src/x.ts",
    "? untracked.txt",
    "u UU N... 100644 100644 100644 100644 a b c d merge.ts",
  ]) {
    assert.equal(parseStatus(`${CLEAN_BEHIND}\n${change}`).dirty, true, `${change} should count as dirty`);
  }
});

test("update: a detached HEAD parses as no branch", () => {
  const o = parseStatus("# branch.oid abc123\n# branch.head (detached)");
  assert.equal(o.branch, null);
});

test("update: a fresh repo with no commits does not report a bogus head", () => {
  const o = parseStatus("# branch.oid (initial)\n# branch.head main");
  assert.equal(o.head, undefined);
});

test("update: both directions are read from branch.ab", () => {
  const o = parseStatus(`${CLEAN_BEHIND.replace("+0 -4", "+2 -7")}`);
  assert.equal(o.ahead, 2);
  assert.equal(o.behind, 7);
});

// ─── Reporting ──────────────────────────────────────────────────────────────

test("update: an applied update tells the operator it is not loaded yet", () => {
  // The incident this whole module exists for: code updated on disk, old code
  // still running in the process, and nothing saying so.
  const text = describeUpdate(decideUpdate(obs({ behind: 2 })), { applied: true });
  assert.match(text, /Restart Pi|\/reload/);
});

test("update: an unapplied update names the command that applies it", () => {
  const text = describeUpdate(decideUpdate(obs({ behind: 2 })), { applied: false });
  assert.match(text, /2 commit\(s\) behind/);
  assert.match(text, /\/update/);
});
