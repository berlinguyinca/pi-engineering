import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const installer = resolve("scripts/install-session-auto-resume.ts");
const fixture = resolve("test/fixtures/managed-pi-wrapper.sh");
const hookBegin = "# >>> pi-session-auto-resume (installed by pi-engineering) >>>";

/** A release laid out the way Pi's managed installer lays it out, with a CLI that says which release ran. */
function makeRelease(agent: string, version: string): void {
  const modules = join(agent, "install/releases", version, "node_modules");
  const pkg = join(modules, "@earendil-works/pi-coding-agent");
  mkdirSync(join(pkg, "dist/bundle"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
  writeFileSync(
    join(pkg, "dist/bundle/cli.js"),
    `#!/usr/bin/env node\nconsole.log("pi ${version}", process.env.PI_MANAGED_INSTALL_ROOT, process.argv.slice(2).join(" "));\n`,
    { mode: 0o755 },
  );
  mkdirSync(join(modules, "@earendil-works/pi-ai"), { recursive: true });
  writeFileSync(join(modules, "@earendil-works/pi-ai/package.json"), JSON.stringify({ name: "@earendil-works/pi-ai" }));
  mkdirSync(join(modules, ".bin"), { recursive: true });
  symlinkSync("../@earendil-works/pi-coding-agent/dist/bundle/cli.js", join(modules, ".bin/pi"));
}

function managedAgent(root: string): string {
  const agent = join(root, "agent");
  mkdirSync(join(agent, "bin"), { recursive: true });
  copyFileSync(fixture, join(agent, "bin/pi"));
  chmodSync(join(agent, "bin/pi"), 0o755);
  makeRelease(agent, "1.0.0");
  writeFileSync(join(agent, "install/current-version"), "1.0.0\n");
  return agent;
}

const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
const runPi = (agent: string) =>
  execFileSync(join(agent, "bin/pi"), ["--flag", "value"], { encoding: "utf8", env }).trim();
const install = (agent: string, dir: string) =>
  execFileSync(process.execPath, [installer, "--managed", agent, dir], { encoding: "utf8", env });
const aiLink = (dir: string) => readlinkSync(join(dir, "node_modules/@earendil-works/pi-ai"));

test(
  "the managed hook runs Pi, is idempotent, follows release switches, and falls back to plain Pi",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-resume-managed-"));
    try {
      const agent = managedAgent(root);
      const dir = join(root, "launcher");
      assert.equal(runPi(agent), `pi 1.0.0 ${join(agent, "install")} --flag value`);

      assert.match(install(agent, dir), /Hooked automatic safe session recovery/);
      const hooked = readFileSync(join(agent, "bin/pi"), "utf8");
      assert.equal(hooked.split(hookBegin).length - 1, 1);
      assert.ok(hooked.trimEnd().endsWith('exec "$pi_release_bin" "$@"'), "the plain exec stays as the fallback");
      assert.equal(
        readFileSync(`${join(agent, "bin/pi")}.before-session-auto-resume`, "utf8"),
        readFileSync(fixture, "utf8"),
      );
      assert.match(aiLink(dir), /releases\/1\.0\.0\//);
      // Same Pi, same environment, same arguments, now through the launcher. Output alone
      // cannot tell the launcher from a fallback to plain Pi, so make its link stale: only
      // the launcher repairs it at start.
      rmSync(join(dir, "node_modules/@earendil-works/pi-ai"));
      symlinkSync(join(root, "nowhere"), join(dir, "node_modules/@earendil-works/pi-ai"));
      assert.equal(runPi(agent), `pi 1.0.0 ${join(agent, "install")} --flag value`);
      assert.match(aiLink(dir), /releases\/1\.0\.0\//);

      // Running the installer again changes nothing and keeps the first backup.
      assert.match(install(agent, dir), /already hooks them/);
      assert.equal(readFileSync(join(agent, "bin/pi"), "utf8"), hooked);

      // The managed install moves to a new release: the next start runs it, and the
      // launcher's package links follow it instead of staying on the old release.
      makeRelease(agent, "2.0.0");
      writeFileSync(join(agent, "install/current-version"), "2.0.0\n");
      assert.equal(runPi(agent), `pi 2.0.0 ${join(agent, "install")} --flag value`);
      assert.match(aiLink(dir), /releases\/2\.0\.0\//);

      // A missing launcher never makes Pi unstartable.
      rmSync(dir, { recursive: true, force: true });
      assert.equal(runPi(agent), `pi 2.0.0 ${join(agent, "install")} --flag value`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("the managed installer refuses a wrapper it does not recognize and leaves it alone", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resume-managed-"));
  try {
    const agent = managedAgent(root);
    writeFileSync(join(agent, "bin/pi"), "#!/bin/sh\necho custom\n", { mode: 0o755 });
    assert.throws(() => install(agent, join(root, "launcher")), /Not a managed Pi wrapper/);
    assert.equal(readFileSync(join(agent, "bin/pi"), "utf8"), "#!/bin/sh\necho custom\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PI_SESSION_AUTO_RESUME_BYPASS skips the launcher", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resume-managed-"));
  try {
    const agent = managedAgent(root);
    const dir = join(root, "launcher");
    install(agent, dir);
    // Break the launcher: with the bypass set, Pi must still start.
    writeFileSync(join(dir, "scripts/pi-session-auto-resume.ts"), "this is not valid typescript (((");
    const out = execFileSync(join(agent, "bin/pi"), ["--flag", "value"], {
      encoding: "utf8",
      env: { ...env, PI_SESSION_AUTO_RESUME_BYPASS: "1" },
    }).trim();
    assert.equal(out, `pi 1.0.0 ${join(agent, "install")} --flag value`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a launcher that cannot load never stops Pi starting", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resume-managed-"));
  try {
    const agent = managedAgent(root);
    const dir = join(root, "launcher");
    install(agent, dir);
    writeFileSync(join(dir, "scripts/pi-session-auto-resume.ts"), "this is not valid typescript (((");
    assert.equal(runPi(agent), `pi 1.0.0 ${join(agent, "install")} --flag value`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "re-hooking with a new install path replaces the block, keeps the first backup and the file mode",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-resume-managed-"));
    try {
      const agent = managedAgent(root);
      const wrapper = join(agent, "bin/pi");
      chmodSync(wrapper, 0o750);
      install(agent, join(root, "first"));
      // A path with shell- and replace-special characters must land in the hook verbatim.
      const odd = join(root, "a$&b $' dir");
      install(agent, odd);
      const text = readFileSync(wrapper, "utf8");
      assert.equal(text.split(hookBegin).length - 1, 1);
      const quoted = `'${join(odd, "scripts/pi-session-auto-resume.ts").replaceAll("'", "'\\''")}'`;
      assert.ok(text.includes(`pi_resume_launcher=${quoted}\n`));
      assert.ok(!text.includes(join(root, "first")));
      assert.equal(readFileSync(`${wrapper}.before-session-auto-resume`, "utf8"), readFileSync(fixture, "utf8"));
      assert.equal(statSync(wrapper).mode & 0o777, 0o750);
      assert.equal(runPi(agent), `pi 1.0.0 ${join(agent, "install")} --flag value`);
      assert.equal(
        execFileSync("find", [join(agent, "bin"), "-name", "*.session-auto-resume-*"], { encoding: "utf8" }).trim(),
        "",
      );

      // A half-damaged hook is refused rather than doubled up.
      writeFileSync(wrapper, text.replace("# <<< pi-session-auto-resume <<<", ""), { mode: 0o755 });
      assert.throws(() => install(agent, odd), /markers .* are damaged/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a leftover relink entry is ignored by the package refresh", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resume-managed-"));
  try {
    const agent = managedAgent(root);
    const dir = join(root, "launcher");
    install(agent, dir);
    const leftover = join(dir, "node_modules/@earendil-works/pi-ai.relink-99999");
    symlinkSync(join(root, "nowhere"), leftover);
    runPi(agent);
    assert.equal(readlinkSync(leftover), join(root, "nowhere"));
    assert.equal(
      execFileSync("ls", [join(dir, "node_modules/@earendil-works")], { encoding: "utf8" })
        .split("\n")
        .filter((n) => n.includes("relink-99999.")).length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
