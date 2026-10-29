/**
 * One-shot update outcome notices (issue #484).
 *
 * A transaction can finish, fail, be refused, be rolled back, or be recovered
 * by a process that is not the session the operator is looking at. The outcome
 * is persisted in the install root and consumed exactly once, so the next
 * session reports it instead of leaving it in telemetry only.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { InstallLayout } from "../../src/update/installLayout.ts";
import { type UpdateNotice, readUpdateNotice, takeUpdateNotice, writeUpdateNotice } from "../../src/update/notice.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function noticeFile(): string {
  const root = mkdtempSync(join(tmpdir(), "rt-notice-"));
  dirs.push(root);
  return new InstallLayout(root).noticeFile;
}

const FAILED: UpdateNotice = {
  kind: "failed",
  transaction: "update-d85a75898677-60d05d",
  text: "Pi Engineering 0.2.0-b662443f395d → 0.2.0-d85a75898677 was interrupted during validating and marked failed.",
  at: "2026-10-29T20:48:15.761Z",
};

test("a notice written by one process is delivered to the next one exactly once", () => {
  const file = noticeFile();
  writeUpdateNotice(file, FAILED);

  const first = new InstallLayout(join(dirs[0] as string)); // a different reader, same root
  const delivered = takeUpdateNotice(first.noticeFile);

  assert.equal(delivered?.kind, "failed");
  assert.equal(delivered?.transaction, "update-d85a75898677-60d05d");
  assert.match(delivered?.text as string, /0\.2\.0-b662443f395d → 0\.2\.0-d85a75898677/);
  assert.equal(takeUpdateNotice(first.noticeFile), null, "a notice is consumed once");
  assert.ok(!existsSync(first.noticeFile), "a delivered notice leaves no state behind");
});

test("the newest notice wins when several processes report", () => {
  const file = noticeFile();
  writeUpdateNotice(file, { ...FAILED, text: "older" });
  writeUpdateNotice(file, { ...FAILED, text: "newer", at: "2026-10-29T20:49:15.761Z" });

  assert.equal(readUpdateNotice(file)?.text, "newer");
});

test("a missing notice is reported as nothing to show", () => {
  const file = noticeFile();
  assert.equal(readUpdateNotice(file), null);
  assert.equal(takeUpdateNotice(file), null);
});

test("a notice that cannot be read is discarded instead of thrown at the operator", () => {
  const file = noticeFile();
  writeFileSync(file, "{ not json");

  assert.equal(takeUpdateNotice(file), null);
  assert.ok(!existsSync(file), "unreadable notices do not linger");
});

test("a notice naming no known kind is discarded", () => {
  const file = noticeFile();
  writeUpdateNotice(file, FAILED);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...raw, kind: "sideways" }));

  assert.equal(takeUpdateNotice(file), null);
});
