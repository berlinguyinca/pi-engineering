import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  citationSummary,
  extractCitations,
  fileSystemReader,
  gitObjectReader,
  resolveCitations,
} from "../../src/ledger/citations.ts";

const FILES: Record<string, string> = {
  "src/roomClient.ts":
    "export const MAX_PAGE = 20;\nexport function drain(page) {\n  while (page) { page = next(page); }\n}\n",
  "docs/notes.md": "# notes\n\nthe revoked notice lives here\n",
};

const reader = async (file: string): Promise<string | null> => FILES[file] ?? null;

test("extractCitations finds path:line and ranges, and ignores machine URIs and host:port", () => {
  const text =
    "see src/roomClient.ts:2 again src/roomClient.ts:2 and src/roomClient.ts:2-3, " +
    "plus artifact://logs/tap-run and the server on 127.0.0.1:8080 and collab.py:1299-1304";
  const found = extractCitations(text).map((c) => `${c.file}:${c.line}-${c.lineEnd}`);
  assert.deepEqual(found, ["src/roomClient.ts:2-2", "src/roomClient.ts:2-3", "collab.py:1299-1304"]);
});

test("a citation resolves when the file, the line and the token the sentence names all agree", async () => {
  const report = await resolveCitations("the `drain` loop at src/roomClient.ts:2 never checks abort", reader, {
    atRef: "abc1234",
  });
  assert.equal(report.checked, 1);
  assert.equal(report.resolved, 1);
  assert.deepEqual(report.unresolved, []);
  assert.equal(report.atRef, "abc1234");
  assert.equal(citationSummary(report), "all 1 citation(s) resolve at abc1234");
});

test("a citation to a file that is not there is reported, not trusted", async () => {
  const report = await resolveCitations("the `drain` loop at src/nope.ts:1 does X", reader);
  assert.equal(report.unresolved.length, 1);
  assert.match(report.unresolved[0]!, /no such file at worktree/);
});

test("a citation past the end of the file is reported with the real length", async () => {
  const report = await resolveCitations("the `drain` loop at src/roomClient.ts:99 does X", reader, {
    atRef: "abc1234",
  });
  assert.equal(report.unresolved.length, 1);
  assert.match(report.unresolved[0]!, /line 99 is past the file end \(4 lines\) at abc1234/);
});

test("a citation whose line does not contain what the sentence attributes to it is reported", async () => {
  // The off-by-N class: the revoked notice is in docs/notes.md:3, not roomClient.ts:2.
  const report = await resolveCitations("the `revoked` notice at src/roomClient.ts:2 tells the user to rejoin", reader);
  assert.equal(report.unresolved.length, 1);
  assert.match(report.unresolved[0]!, /`revoked`/);
  assert.match(report.unresolved[0]!, /none of them appears in it/);
  assert.match(citationSummary(report), /1 of 1 citation\(s\) do not resolve/);
});

test("a citation in prose that names no identifier is checked structurally only", async () => {
  const report = await resolveCitations("as documented in docs/notes.md:3 the notice is shown", reader);
  assert.deepEqual(report.unresolved, []);
  assert.equal(report.resolved, 1);
});

test("paths that are not repository-relative are not treated as citations", async () => {
  // An absolute or drive-qualified path names something outside the tree under
  // review; resolving it against this repository would report a false miss and
  // cost a repair cycle for nothing.
  const text = "read /home/u/repo/src/a.ts:12 and ~/other/src/b.ts:3 and C:\\repo\\d.ts:5 and http://host/x.ts:9";
  assert.deepEqual(extractCitations(text), []);
  assert.deepEqual(extractCitations("the fix at src/c.ts:4 holds"), extractCitations("src/c.ts:4"));
});

test("gitObjectReader resolves the cited content at the commit, not at whatever the work tree holds", async () => {
  const dir = await mkdtemp(join("/tmp", "pi-eng-citations-"));
  try {
    const file = join(dir, "src", "feed.ts");
    await mkdir(join(dir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    await writeFile(join(dir, "src-feed-placeholder"), "x");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "base"]);
    await writeFile(file, "export function drain(page) {\n  while (page) { page = next(page); }\n}\n", {
      encoding: "utf8",
    });
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "add drain"]);
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    // The work tree now says something else; the commit must still resolve.
    await writeFile(file, "export function drain(page) {\n  // rewritten locally\n}\n", { encoding: "utf8" });

    const atCommit = await resolveCitations("the `next` call at src/feed.ts:2 loops", gitObjectReader(dir, sha), {
      atRef: sha.slice(0, 7),
    });
    assert.deepEqual(atCommit.unresolved, [], "the commit still contains the cited token");

    const atWorktree = await resolveCitations("the `next` call at src/feed.ts:2 loops", fileSystemReader(dir), {
      atRef: "worktree",
    });
    assert.equal(atWorktree.unresolved.length, 1, "the locally rewritten file no longer says that");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
