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
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
      assert.equal(realpathSync(`${bin}.before-session-auto-resume`), realpathSync(original));
      renameSync(`${bin}.before-session-auto-resume`, bin);
      assert.equal(realpathSync(bin), realpathSync(original));
      assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /\d+\.\d+\.\d+/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
