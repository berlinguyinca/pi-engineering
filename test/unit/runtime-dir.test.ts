import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { usableRuntimeDir } from "../../src/platform/runtimeDir.ts";

// The first Linux CI run turned "validate the value of XDG_RUNTIME_DIR, then trust it" into
// three separate failures: the session-control socket, the live-handoff test file (which had
// copied the same rule), and the relocated SQLite registry. These tests are the reason the
// rule lives in one function now.

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function freshDir(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `pi-eng-runtime-dir-${name}-`));
  dirs.push(path);
  return path;
}

// The capped caller needs a directory short enough to still qualify, and the canonical temp
// dir on macOS is already 58 bytes — so this one hangs off /tmp, which is what the product
// itself falls back to for exactly that reason.
async function shortDir(name: string): Promise<string> {
  const path = await mkdtemp(join("/tmp", `pe-rd-${name}-`));
  dirs.push(path);
  assert.ok(Buffer.byteLength(path) <= 30, `fixture too long for the cap: ${path}`);
  return path;
}

test("no XDG_RUNTIME_DIR means no usable runtime dir, not a crash", () => {
  assert.equal(usableRuntimeDir({}), null);
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: "   " }), null);
});

test("a value that is merely shaped like a path is refused", async () => {
  const good = await shortDir("shaped");
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: "run/user/1000" }), null, "relative");
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: "/tmp\0/x" }), null, "NUL byte");
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: good }, 30), good, "the same value passes when it is real");
});

test("the length cap is a caller's constraint, not a property of runtime dirs", async () => {
  const long = await mkdtemp(join(tmpdir(), "pi-eng-runtime-dir-a-deliberately-long-name-to-cross-thirty-bytes-"));
  dirs.push(long);
  assert.ok(Buffer.byteLength(long) > 30, "the fixture must be long enough to exercise the cap");
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: long }, 30), null, "a Unix socket caller cannot use it");
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: long }), long, "a registry caller can");
});

test("set but not there is the scheduler case, and it must not be trusted", async () => {
  // Exactly what a Slurm exec host exports: absolute, plausible, short — and absent, because
  // pam_systemd set the variable while systemd-logind never made the directory.
  const missing = `/run/user/${process.getuid?.() ?? 1000}-never-created`;
  await assert.rejects((await import("node:fs/promises")).stat(missing));
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: missing }), null);

  const file = join(await freshDir("file"), "runtime");
  await writeFile(file, "not a directory");
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: file }), null, "a regular file is not a runtime dir");

  const nested = join(await freshDir("nested"), "deep", "path");
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: nested }), null, "an uncreated child is not a runtime dir");
});

test("a real, writable directory is used as given", async () => {
  const good = await shortDir("usable");
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: good }, 30), good);
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: good }), good);
  // The uncapped caller accepts a directory anywhere, however long the temp root is.
  const deep = await freshDir("deep");
  assert.ok(Buffer.byteLength(deep) > 30, "the fixture must be long to prove the point");
  assert.equal(usableRuntimeDir({ XDG_RUNTIME_DIR: deep }), deep);
});
