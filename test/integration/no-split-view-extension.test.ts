/**
 * The split-view TUI extension is gone from the runtime package: no pi install can
 * receive it. This checks the shipped package surface (package.json `pi.extensions`,
 * the filesystem) and a REAL Pi startup that loads the package's declared extension
 * entries — which must load cleanly and register no split-view command or flag while
 * the engineering runtime entry still registers its own commands.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startPiSession } from "../support/piSession.ts";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");

/** What split-view registered: commands, sub-commands and its opt-out flag. */
const SPLIT_VIEW_COMMANDS = ["split", "split-thinking", "split-height", "split-save"];

test("package.json declares only the runtime entry for Pi", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    pi: { extensions: string[] };
  };
  assert.deepEqual(pkg.pi.extensions, ["./src/runtime/host/entry.ts"]);
});

test("the vendored split-view directory is gone", () => {
  assert.equal(existsSync(join(repoRoot, "extensions/split-view")), false);
  assert.equal(existsSync(join(repoRoot, "test/unit/split-view-vendor.test.ts")), false);
  assert.equal(existsSync(join(repoRoot, "test/unit/split-view-reliability.test.ts")), false);
});

test("no tracked file references the split-view extension", () => {
  // git grep over the tracked tree: the only surviving 'split' hits are unrelated
  // prose/strings, so assert specifically on the extension's identifiers.
  let files: string[] = [];
  try {
    files = execFileSync(
      "git",
      ["-C", repoRoot, "grep", "-l", "-i", "-E", "split-view|split-thinking|split-save|ui-panels-config", "--", "."],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    const e = error as { status?: number; stdout?: string };
    if (e.status !== 1) throw error;
    files = (e.stdout ?? "").trim().split("\n").filter(Boolean);
  }
  assert.deepEqual(files, []);
});

test("a real Pi session with the package entries loads and registers no split-view surface", async () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    pi: { extensions: string[] };
  };
  const extensionPaths = pkg.pi.extensions.map((p) => join(repoRoot, p));
  const session = await startPiSession({ extensionPaths });
  try {
    const commands = session.piCommands();
    for (const name of SPLIT_VIEW_COMMANDS) {
      assert.ok(!commands.includes(name), `pi must not register /${name}`);
    }
    // The engineering runtime entry itself still registers its commands.
    assert.ok(commands.includes("engineering"), `/engineering missing from ${commands.join(",")}`);
    // The split-view opt-out flag is gone; our own runtime flags remain.
    const runner = session.session.extensionRunner as unknown as {
      getFlags(): Map<string, unknown>;
    };
    const flags = [...runner.getFlags().keys()];
    assert.ok(!flags.includes("no-split"), `flag no-split still registered (${flags.join(",")})`);
  } finally {
    await session.close();
  }
});
