import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

test(
  "launcher installation is idempotent, runs Pi, and restores its original target",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-resume-install-"));
    try {
      mkdirSync(join(root, "bin"));
      const bin = join(root, "bin/pi");
      const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
      const original = existsSync(join(dist, "bundle/cli.js")) ? join(dist, "bundle/cli.js") : join(dist, "cli.js");
      symlinkSync(original, bin);
      const installer = resolve("scripts/install-session-auto-resume.ts");
      const install = join(root, "install");
      for (let i = 0; i < 2; i++) {
        execFileSync(process.execPath, [installer, bin, install]);
        const manifest = JSON.parse(readFileSync(join(install, "install.json"), "utf8"));
        assert.equal(manifest.originalCli, realpathSync(original));
        assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /\d+\.\d+\.\d+/);
      }
      // `--version` is not a TTY run, so the wrapper never reaches the recovery rules.
      // Load the installed copy directly: it must carry everything it imports.
      const loadable = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const m = await import(process.argv[1]); console.log(typeof m.prepareSessionAutoResume, typeof m.sessionRecovery)",
          pathToFileURL(join(install, "src/gateway/sessionAutoResume.ts")).href,
        ],
        { encoding: "utf8" },
      );
      assert.equal(loadable.trim(), "function function");
      assert.ok(existsSync(join(install, "src/gateway/settleRecovery.ts")));
      assert.ok(existsSync(join(install, "src/gateway/sessionLiveness.ts")));
      assert.ok(existsSync(join(install, "node_modules/@earendil-works/pi-ai/package.json")));
      assert.equal(realpathSync(`${bin}.before-session-auto-resume`), realpathSync(original));
      renameSync(`${bin}.before-session-auto-resume`, bin);
      assert.equal(realpathSync(bin), realpathSync(original));
      assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /\d+\.\d+\.\d+/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Pi still starts when the installed recovery rules cannot load", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resume-degrade-"));
  try {
    mkdirSync(join(root, "bin"));
    const bin = join(root, "bin/pi");
    const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    const original = existsSync(join(dist, "bundle/cli.js")) ? join(dist, "bundle/cli.js") : join(dist, "cli.js");
    symlinkSync(original, bin);
    const install = join(root, "install");
    execFileSync(process.execPath, [resolve("scripts/install-session-auto-resume.ts"), bin, install]);
    // Break the rules the way a stale or partial install would.
    rmSync(join(install, "src/gateway/settleRecovery.ts"));
    assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /\d+\.\d+\.\d+/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "reinstalling keeps an operator's own lines in the launcher and still refreshes the installed files",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-resume-keep-"));
    try {
      mkdirSync(join(root, "bin"));
      const bin = join(root, "bin/pi");
      const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
      const original = existsSync(join(dist, "bundle/cli.js")) ? join(dist, "bundle/cli.js") : join(dist, "cli.js");
      symlinkSync(original, bin);
      const install = join(root, "install");
      const installer = resolve("scripts/install-session-auto-resume.ts");
      execFileSync(process.execPath, [installer, bin, install]);
      const custom = `${readFileSync(bin, "utf8").replace("\n", "\nexport HERDR_BUILD_GATE_SLOTS=2\n")}`;
      writeFileSync(bin, custom, { mode: 0o755 });
      rmSync(join(install, "src/gateway/settleRecovery.ts"));
      execFileSync(process.execPath, [installer, bin, install]);
      assert.equal(readFileSync(bin, "utf8"), custom, "the operator's lines survive");
      assert.ok(existsSync(join(install, "src/gateway/settleRecovery.ts")), "the installed files are refreshed");
      assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /\d+\.\d+\.\d+/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a launcher that cannot be kept is backed up before it is rewritten, and no temp files are left",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-resume-backup-"));
    try {
      mkdirSync(join(root, "bin"));
      const bin = join(root, "bin/pi");
      const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
      const original = existsSync(join(dist, "bundle/cli.js")) ? join(dist, "bundle/cli.js") : join(dist, "cli.js");
      symlinkSync(original, bin);
      const install = join(root, "install");
      const installer = resolve("scripts/install-session-auto-resume.ts");
      execFileSync(process.execPath, [installer, bin, install]);
      // Same marker, but the exec line names a node that is gone and a commented-out copy of the real one.
      const stale = readFileSync(bin, "utf8").replace(/^exec '[^']*'/m, "# $&\nexec '/nonexistent/node'");
      writeFileSync(bin, `${stale}# operator note\n`, { mode: 0o755 });
      execFileSync(process.execPath, [installer, bin, install]);
      assert.match(readFileSync(`${bin}.pre-rewrite`, "utf8"), /operator note/);
      assert.doesNotMatch(readFileSync(bin, "utf8"), /nonexistent/);
      assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /\d+\.\d+\.\d+/);
      const leftovers = execFileSync("find", [install, "-name", "*.installing-*"], { encoding: "utf8" }).trim();
      assert.equal(leftovers, "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
