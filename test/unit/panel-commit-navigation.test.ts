/**
 * Opening a commit from the panel.
 *
 * The rows were listed but not selectable and carried `{kind: "empty"}`, so the
 * history section was a caption: the operator could see five commits and reach
 * none of them. These tests pin the whole path — the row is selectable, it
 * carries the sha rather than the drawn label, and the view it resolves to is a
 * pure diff with the subject in its title.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelState } from "../../src/panel/PanelState.ts";
import { readCommitContent } from "../../src/panel/content.ts";
import { looksLikeDiff } from "../../src/panel/highlight.ts";
import { buildRows } from "../../src/panel/tree.ts";

function withCommits(): PanelState {
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    workspace: {
      branch: "feat/ambient-footer",
      files: [],
      recentCommits: [
        { sha: "2efa2d3", subject: "tint the panel", relative: "14 minutes ago" },
        { sha: "01cd4e1", subject: "borders, line numbers", relative: "30 minutes ago" },
      ],
    },
  });
  return state;
}

test("commits: history rows are selectable and carry the sha", () => {
  const rows = buildRows(withCommits().snapshot, new Set(["workspace", "history"]), "files");
  const commits = rows.filter((row) => row.payload.kind === "commit");
  assert.equal(commits.length, 2, "both commits should be reachable");
  for (const row of commits) {
    assert.equal(row.selectable, true, "a row you cannot rest on is a caption");
  }
  const first = commits[0]?.payload;
  assert.deepEqual(first, { kind: "commit", sha: "2efa2d3", subject: "tint the panel" });
  // The label is the drawing; the payload is the value. Opening must not have
  // to re-parse a sha back out of a string containing a subject and a date.
  assert.match(commits[0]?.label ?? "", /^2efa2d3 tint the panel · 14 minutes ago$/);
});

test("commits: a collapsed history section offers no commit rows", () => {
  const rows = buildRows(withCommits().snapshot, new Set(["workspace"]), "files");
  assert.equal(
    rows.filter((row) => row.payload.kind === "commit").length,
    0,
    "collapsed means collapsed: no hidden selectable rows",
  );
});

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-const a = 1;",
  "+const a = 2;",
  "",
].join("\n");

test("commits: the view titles with the subject and keeps the body a pure diff", async () => {
  const view = await readCommitContent({ commitDiff: async () => PATCH }, "2efa2d3", "tint the panel");
  assert.equal(view.title, "2efa2d3 tint the panel");
  assert.equal(view.error, undefined);
  // The renderer decides between file numbering and diff numbering by looking
  // at the body. A `commit …`/`Author: …` preamble makes a patch read as a
  // source file whose first line is a sha, losing the +/- colouring entirely.
  assert.equal(looksLikeDiff(view.lines), true);
  assert.equal(view.lines[0], "diff --git a/src/a.ts b/src/a.ts");
  assert.ok(!view.lines.some((line) => line.startsWith("commit ")), "no header in the body");
});

test("commits: no subject means the sha is the whole title", async () => {
  const view = await readCommitContent({ commitDiff: async () => PATCH }, "2efa2d3");
  assert.equal(view.title, "2efa2d3");
});

test("commits: a commit with no patch says so rather than showing an empty pane", async () => {
  const view = await readCommitContent({ commitDiff: async () => "   \n" }, "deadbee", "empty commit");
  assert.equal(view.error, undefined, "nothing failed, so nothing should read as a failure");
  assert.deepEqual(view.lines, ["  (no textual changes)"]);
});

test("commits: a git failure becomes an error view, never a throw", async () => {
  const view = await readCommitContent(
    {
      commitDiff: async () => {
        throw new Error("bad object");
      },
    },
    "nope",
  );
  assert.equal(view.error, "bad object");
  assert.deepEqual(view.lines, []);
});

test("commits: an oversized patch is capped and says it was", async () => {
  const huge = `${PATCH}\n${"+x\n".repeat(400_000)}`;
  const view = await readCommitContent({ commitDiff: async () => huge }, "2efa2d3", "big");
  assert.equal(view.truncated, true);
  assert.ok(view.lines.length <= 2000, "line cap applies to commits like every other view");
});
