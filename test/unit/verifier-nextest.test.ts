/**
 * Issue #148: Rust repositories get a cargo-nextest stage (when nextest is
 * installed) plus an explicit doctest stage, and nextest's per-test lines feed
 * the progress watchdog (#146).
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import {
  CommandVerifier,
  countNextestEvents,
  parseNextestLine,
  runWithInactivityGuard,
  rustProfile,
} from "../../src/verify/Verifier.ts";

const CARGO_TOML = '[package]\nname = "x"\nversion = "0.1.0"\n';

async function rustDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-nextest-"));
  await writeFile(join(dir, "Cargo.toml"), CARGO_TOML);
  return dir;
}

const cmds = (stages: Array<{ command: string; args: string[] }>) =>
  stages.map((s) => [s.command, ...s.args].join(" "));

describe("rust profile detection", () => {
  it("yields nextest and doctest stages when nextest is available", async () => {
    const dir = await rustDir();
    try {
      const profile = await new CommandVerifier({ probeNextest: async () => true }).detect(dir);
      assert.deepEqual(
        profile.stages.map((s) => s.name),
        ["typecheck", "nextest", "doctest"],
      );
      assert.deepEqual(cmds(profile.stages), ["cargo check --all-targets", "cargo nextest run", "cargo test --doc"]);
      assert.ok(profile.stages.every((s) => s.required));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to cargo test and still has doctest, which nextest and cargo test --lib/--tests do not run", async () => {
    const dir = await rustDir();
    try {
      const profile = await new CommandVerifier({ probeNextest: async () => false }).detect(dir);
      assert.deepEqual(
        profile.stages.map((s) => s.name),
        ["typecheck", "test", "doctest"],
      );
      const [, test, doctest] = cmds(profile.stages);
      assert.match(test ?? "", /^cargo test --lib --bins --tests$/);
      assert.equal(doctest, "cargo test --doc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes the project directory to the probe", async () => {
    const dir = await rustDir();
    const seen: string[] = [];
    try {
      await new CommandVerifier({
        probeNextest: async (cwd) => {
          seen.push(cwd);
          return false;
        },
      }).detect(dir);
      assert.deepEqual(seen, [dir]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rustProfile is a pure function of availability and both profiles enable the watchdog", () => {
    for (const hasNextest of [true, false]) {
      const profile = rustProfile(hasNextest);
      const names = profile.stages.map((s) => s.name);
      assert.equal(names.includes("nextest"), hasNextest);
      assert.ok(names.includes("doctest"));
      for (const s of profile.stages.filter((x) => x.name !== "typecheck")) {
        assert.notEqual(s.watchdog, undefined, `${s.name} must run under the progress watchdog`);
      }
    }
  });
});

describe("parseNextestLine", () => {
  it("recognizes a PASS line as a test-finish event", () => {
    assert.deepEqual(parseNextestLine("        PASS [   0.012s] my-crate tests::adds"), {
      kind: "finish",
      status: "pass",
      test: "my-crate tests::adds",
    });
  });

  it("recognizes FAIL, SKIP, retries and START", () => {
    assert.deepEqual(parseNextestLine("        FAIL [   0.005s] my-crate tests::bad"), {
      kind: "finish",
      status: "fail",
      test: "my-crate tests::bad",
    });
    assert.equal(parseNextestLine("        SKIP [   0.000s] my-crate tests::ignored")?.status, "skip");
    assert.deepEqual(parseNextestLine("     TRY 2 PASS [   0.5s] my-crate tests::flaky"), {
      kind: "finish",
      status: "pass",
      test: "my-crate tests::flaky",
    });
    assert.deepEqual(parseNextestLine("       START my-crate tests::begin"), {
      kind: "start",
      test: "my-crate tests::begin",
    });
  });

  it("ignores colors and non-test lines", () => {
    assert.equal(parseNextestLine("\u001b[32m        PASS\u001b[0m [   0.001s] c t")?.status, "pass");
    for (const line of [
      "    Starting 12 tests across 3 binaries",
      "     Summary [   1.2s] 12 tests run: 12 passed, 0 skipped",
      "        SLOW [> 60.000s] my-crate tests::slow",
      "   Compiling x v0.1.0",
      "",
    ]) {
      assert.equal(parseNextestLine(line), null, line);
    }
  });

  it("counts events across a chunk", () => {
    const chunk = [
      "    Starting 3 tests across 1 binary",
      "        PASS [   0.001s] a t1",
      "        FAIL [   0.001s] a t2",
      "     Summary [   0.1s] 2 tests run",
    ].join("\n");
    assert.equal(countNextestEvents(chunk), 2);
  });
});

describe("nextest output feeds the watchdog", () => {
  it("counts a nextest PASS line as a test event, not mere output, when the stage then goes silent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-nextest-wd-"));
    try {
      const result = await runWithInactivityGuard("sh", ["-c", "printf '        PASS [   0.001s] a t1\\n'; sleep 20"], {
        cwd: dir,
        inactivityMs: 60_000,
        watchdog: { warnMs: 150, investigateMs: 300, stallMs: 600, sampleMs: 50 },
      });
      assert.ok(result.stalled, "the silent stage is ended by the progress watchdog");
      assert.match(result.stderr, /last progress: test_event/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("end to end through CommandVerifier with the real probe", () => {
  it("probes `cargo nextest --version`, runs nextest then the doctests, and reports pass", async () => {
    const dir = await rustDir();
    const bin = await mkdtemp(join(tmpdir(), "pi-fake-cargo-"));
    const log = join(bin, "calls.log");
    const savedPath = process.env.PATH;
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(bin, "cargo"),
        [
          "#!/bin/sh",
          `echo "$@" >> ${log}`,
          'case "$1 $2" in',
          '  "nextest --version") echo "cargo-nextest 0.9.0"; exit 0;;',
          '  "nextest run") echo "        PASS [   0.001s] x t1"; exit 0;;',
          '  "test --doc") echo "test src/lib.rs - f (line 1) ... ok"; exit 0;;',
          "esac",
          "exit 0",
          "",
        ].join("\n"),
      );
      await chmod(join(bin, "cargo"), 0o755);
      process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
      const verifier = new CommandVerifier();
      const profile = await verifier.detect(dir);
      assert.deepEqual(
        profile.stages.map((s) => s.name),
        ["typecheck", "nextest", "doctest"],
      );
      const outcome = await verifier.run(dir, profile, await ArtifactStore.create(join(dir, "artifacts")));
      assert.ok(outcome.passed, JSON.stringify(outcome.stages.map((s) => [s.stage.name, s.exitCode])));
      const { readFile } = await import("node:fs/promises");
      const calls = (await readFile(log, "utf8")).trim().split("\n");
      assert.ok(calls.includes("nextest --version"), calls.join("|"));
      assert.ok(calls.includes("nextest run"), calls.join("|"));
      assert.ok(calls.includes("test --doc"), calls.join("|"));
    } finally {
      process.env.PATH = savedPath;
      await rm(dir, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
    }
  });
});
