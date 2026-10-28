/**
 * Generation snapshots copy symlinks verbatim; a link that escapes the source
 * tree would make "immutable snapshot" code import from somewhere else, so the
 * snapshot is refused. Links that stay inside the source tree are fine.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
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

for (const committed of [false, true]) {
  test(`nested service dependencies are shared and importable (${committed ? "Git tree" : "checkout"})`, async () => {
    const src = source(`nested-deps-${committed}`);
    const service = join(src, "services", "probe");
    const dependencies = join(service, "node_modules");
    mkdirSync(join(dependencies, "snapshot-probe"), { recursive: true });
    writeFileSync(join(dependencies, "snapshot-probe", "package.json"), '{"type":"module","exports":"./index.js"}');
    writeFileSync(join(dependencies, "snapshot-probe", "index.js"), 'export default "nested dependency";');
    writeFileSync(join(service, "entry.mjs"), 'export { default } from "snapshot-probe";');
    mkdirSync(join(service, "fixtures"));
    writeFileSync(join(service, "fixtures", "node_modules"), "ordinary fixture file");
    let commit: string | undefined;
    if (committed) {
      const git = (...args: string[]) => execFileSync("git", ["-C", src, ...args], { encoding: "utf8" }).trim();
      git("init", "-q");
      writeFileSync(join(src, ".gitignore"), "node_modules/\n");
      git("add", ".");
      git("-c", "user.name=Snapshot Test", "-c", "user.email=snapshot@example.test", "commit", "-qm", "fixture");
      commit = git("rev-parse", "HEAD");
    }
    const snap = await snapshotRuntimeSource(src, join(root, `gens-nested-${committed}`), "g1", commit);
    const snapshotDependencies = join(snap, "services", "probe", "node_modules");
    assert.ok(lstatSync(snapshotDependencies).isSymbolicLink(), "dependency trees must not be recursively copied");
    assert.equal(realpathSync(snapshotDependencies), realpathSync(dependencies));
    assert.equal(
      readFileSync(join(snap, "services", "probe", "fixtures", "node_modules"), "utf8"),
      "ordinary fixture file",
    );
    writeFileSync(join(service, "entry.mjs"), 'throw new Error("mutable source must not run");');
    assert.equal(
      (await import(pathToFileURL(join(snap, "services", "probe", "entry.mjs")).href)).default,
      "nested dependency",
    );
  });
}

test("sharing nested dependencies does not allow escaping service code links", async () => {
  const src = source("nested-escape");
  const service = join(src, "services", "probe");
  mkdirSync(join(service, "node_modules"), { recursive: true });
  symlinkSync(tmpdir(), join(service, "code"));
  await assert.rejects(
    snapshotRuntimeSource(src, join(root, "gens-nested-escape"), "g1"),
    (error: unknown) => error instanceof RuntimeLoadError && /escapes/.test(error.message),
  );
});

test("nested dependency directory symlinks reuse their real target", async () => {
  const src = source("linked-nested-deps");
  const dependencies = join(root, "shared-service-dependencies");
  mkdirSync(dependencies);
  mkdirSync(join(src, "services", "probe"), { recursive: true });
  symlinkSync(dependencies, join(src, "services", "probe", "node_modules"), "dir");
  const snap = await snapshotRuntimeSource(src, join(root, "gens-linked-nested"), "g1");
  assert.equal(readlinkSync(join(snap, "services", "probe", "node_modules")), realpathSync(dependencies));
});
