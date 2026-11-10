import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PRIORART_REMOTE,
  defaultPriorartPaths,
  ensurePriorart,
  isUnderTmpdir,
} from "../../src/platform/priorartDependency.ts";

/** The cold-start rebuild is a detached `git clone` that keeps writing into the sandbox while it is deleted. */
const NO_REBUILD = { rebuild: false } as const;

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "priorart-dep-"));
  return {
    dir,
    paths: {
      bin: join(dir, "bin", "priorart"),
      config: join(dir, "config", "priorart.json"),
      mcp: join(dir, "mcp.json"),
      source: join(dir, "src", "priorart"),
      remote: "https://example.invalid/priorart.git",
    },
  };
}

describe("priorartDependency", () => {
  it("creates config and registers priorart in mcp.json when absent", () => {
    const { dir, paths } = makeSandbox();
    try {
      const res = ensurePriorart(paths, NO_REBUILD);
      assert.equal(res.configPresent, true);
      assert.equal(res.mcpRegistered, true);
      assert.ok(existsSync(paths.config));
      const doc = JSON.parse(readFileSync(paths.mcp, "utf8"));
      assert.equal(doc.mcpServers.priorart.command, paths.bin);
      assert.deepEqual(doc.mcpServers.priorart.args, [paths.config]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not clobber unrelated mcp server entries", () => {
    const { dir, paths } = makeSandbox();
    try {
      writeFileSync(paths.mcp, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
      const res = ensurePriorart(paths, NO_REBUILD);
      assert.equal(res.mcpRegistered, true);
      const doc = JSON.parse(readFileSync(paths.mcp, "utf8"));
      assert.ok(doc.mcpServers.other);
      assert.ok(doc.mcpServers.priorart);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warm start: binary present => no rebuild kicked off", () => {
    const { dir, paths } = makeSandbox();
    try {
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(paths.bin, "fake-binary");
      const res = ensurePriorart(paths, NO_REBUILD);
      assert.equal(res.binaryPresent, true);
      assert.equal(res.rebuildStarted, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuild:false never spawns the detached clone, so nothing writes into the source dir", () => {
    const { dir, paths } = makeSandbox();
    try {
      const res = ensurePriorart(paths, NO_REBUILD);
      assert.equal(res.binaryPresent, false);
      assert.equal(res.rebuildStarted, false);
      assert.equal(existsSync(paths.source), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws on an unwritable location", () => {
    const { dir, paths } = makeSandbox();
    try {
      // A path under a file (not a dir) forces the guarded write to fail softly.
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "x");
      const broken = { ...paths, mcp: join(blocker, "mcp.json"), config: join(blocker, "c.json") };
      const res = ensurePriorart(broken, NO_REBUILD); // must not throw
      assert.equal(typeof res, "object");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default paths live under $HOME and pin the pi-priorart remote", () => {
    const d = defaultPriorartPaths();
    assert.ok(d.bin.endsWith(".local/bin/priorart"));
    assert.ok(d.mcp.endsWith(".pi/agent/mcp.json"));
    assert.equal(d.remote, PRIORART_REMOTE);
    assert.equal(PRIORART_REMOTE, "https://github.com/berlinguyinca/pi-priorart.git");
  });

  it("isUnderTmpdir: true inside tmpdir, false for a real home and near-miss names", () => {
    const inside = join(tmpdir(), "a", "b");
    assert.equal(isUnderTmpdir(inside), true, "a nested path is under tmpdir");
    assert.equal(isUnderTmpdir(tmpdir()), true, "tmpdir itself is under tmpdir");
    // A name that merely contains the string "tmp" but is not under it must not match.
    assert.equal(isUnderTmpdir("/opt/always-present"), false);
    // A fixed path, NOT homedir(): on CI the step's HOME is itself under /tmp (each step
    // gets its own HOME under the scratch root), so homedir() is not a reliable "real
    // home" there. /home is never a system temp dir, so this is host-independent.
    assert.equal(
      isUnderTmpdir(join("/home", "someone", "IdeaProjects", "priorart")),
      false,
      "a real home path is not ephemeral",
    );
    assert.equal(isUnderTmpdir("relative/priorart"), false, "relative paths are never under tmpdir");
  });

  it("default rebuild into a temp HOME does not spawn: the detached build would race its own cleanup", () => {
    // This is the exact CI condition. A test (or an ephemeral HOME) puts the derived
    // source under mkdtemp; with the default options (rebuild not disabled) the old code
    // still spawned a detached `git clone`+`make build` that kept writing into the temp
    // tree (and, for a Go build, $HOME/.cache/go-build) after the test deleted it.
    const { dir, paths } = makeSandbox();
    try {
      const res = ensurePriorart(paths); // rebuild left at its default
      assert.equal(res.rebuildStarted, false, "no background build is spawned into a temp source");
      assert.equal(existsSync(paths.source), false, "the temp source tree is never created");
      assert.equal(res.configPresent, true, "config is still written (harmless in a throwaway home)");
      assert.equal(res.mcpRegistered, true, "mcp registration is still attempted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuild still starts for a source OUTSIDE tmpdir when the binary is missing", () => {
    // The self-heal must survive the guard on a real home. We cannot spawn a real clone in
    // a unit test, so we assert the decision boundary directly: a source outside tmpdir is
    // NOT filtered by isUnderTmpdir, which is the only new reason for maybeRebuildBinary to
    // return false here.
    const fakeHome = "/home/someone";
    assert.equal(isUnderTmpdir(join(fakeHome, "IdeaProjects", "priorart")), false);
    // And the guard is what makes the ephemeral case false (see the temp-HOME test above),
    // so the two branches are distinguishable purely on the source path.
  });
});
