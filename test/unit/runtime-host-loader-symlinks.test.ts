/**
 * Generation snapshots copy symlinks verbatim; a link that escapes the source
 * tree would make "immutable snapshot" code import from somewhere else, so the
 * snapshot is refused. Links that stay inside the source tree are fine.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { RuntimeLoadError, snapshotRuntimeSource } from "../../src/runtime/host/loader.ts";

const root = mkdtempSync(join(tmpdir(), "rt-loader-links-"));
after(() => rmSync(root, { recursive: true, force: true }));

function source(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  writeFileSync(join(dir, "src", "lib", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "package.json"), "{}");
  return dir;
}

test("links that stay inside the source tree are copied as links", async () => {
  const src = source("inside");
  symlinkSync("lib/a.ts", join(src, "src", "alias.ts"));
  symlinkSync(join(src, "src", "lib"), join(src, "src", "libdir"));
  const snap = await snapshotRuntimeSource(src, join(root, "gens-inside"), "g1");
  assert.equal(readlinkSync(join(snap, "src", "alias.ts")), "lib/a.ts");
});

test("a relative link escaping the source tree is refused", async () => {
  const src = source("escape-relative");
  writeFileSync(join(root, "outside.ts"), "export const evil = 1;\n");
  symlinkSync("../../outside.ts", join(src, "src", "evil.ts"));
  await assert.rejects(
    snapshotRuntimeSource(src, join(root, "gens-rel"), "g1"),
    (error: unknown) => error instanceof RuntimeLoadError && /escapes/.test(error.message),
  );
});

test("an absolute link to outside the source tree is refused", async () => {
  const src = source("escape-absolute");
  symlinkSync(tmpdir(), join(src, "src", "tmp"));
  await assert.rejects(
    snapshotRuntimeSource(src, join(root, "gens-abs"), "g1"),
    (error: unknown) => error instanceof RuntimeLoadError && /escapes/.test(error.message),
  );
});
