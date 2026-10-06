import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { CommandVerifier, tokenizeCommand } from "../../src/verify/Verifier.ts";

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-ver-"));
  for (const [p, content] of Object.entries(files)) {
    const abs = join(dir, p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

test("detect full includes lint + test:full stages (milestone)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({
      scripts: { test: "node --test", lint: "eslint .", "test:full": "node --test --test-reporter=spec" },
    }),
  });
  try {
    const v = new CommandVerifier();
    const normal = await v.detect(dir);
    const full = await v.detect(dir, { full: true });
    assert.ok(!normal.stages.some((s) => s.name === "lint"), "normal profile must not include lint");
    assert.ok(
      full.stages.some((s) => s.name === "lint"),
      "full profile must include lint",
    );
    assert.ok(
      full.stages.some((s) => s.name === "test:full"),
      "full profile must include test:full",
    );
    // Regression (fresh-review): the full-only lint and test:full stages must be
    // REQUIRED so /verify full cannot report PASSED while they are red.
    const lint = full.stages.find((s) => s.name === "lint");
    const testFull = full.stages.find((s) => s.name === "test:full");
    assert.equal(lint?.required, true, "lint must be required in the full profile");
    assert.equal(testFull?.required, true, "test:full must be required in the full profile");
    assert.equal(full.name, "detected-full");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detect caches per-repo and invalidates when package.json changes (milestone)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  });
  try {
    const v = new CommandVerifier();
    const p1 = await v.detect(dir);
    assert.deepEqual(
      p1.stages.map((s) => s.name),
      ["test"],
    );
    // Same content: served from cache (same object identity proves no re-read).
    assert.equal(await v.detect(dir), p1, "unchanged package.json must return the cached profile");
    // Content changed: cache invalidated, profile re-derived.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node --test", build: "node --check index.js" } }),
    );
    const p2 = await v.detect(dir);
    assert.notEqual(p2, p1, "changed package.json must produce a fresh profile");
    assert.ok(p2.stages.some((s) => s.name === "build"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detect reads test/build scripts from package.json", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: "node --test", build: "node --check index.js" } }),
  });
  try {
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    const names = profile.stages.map((s) => s.name);
    assert.ok(names.includes("test"));
    assert.ok(names.includes("build"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier records passing evidence lazily (AC-010)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
  });
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    const outcome = await v.run(dir, profile, store);
    assert.ok(outcome.passed);
    assert.equal(outcome.evidence.length, 1);
    assert.equal(outcome.evidence[0]?.trust, "deterministic");
    assert.equal(outcome.evidence[0]?.status, "passed");
    assert.match(outcome.evidence[0]?.artifacts[0] ?? "", /^artifact:\/\/verify\//);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tokenizeCommand preserves quoted and escaped args", () => {
  assert.deepEqual(tokenizeCommand('node --test "test/a.test.js" "test/**/*.test.js"'), {
    command: "node",
    args: ["--test", "test/a.test.js", "test/**/*.test.js"],
  });
  assert.deepEqual(tokenizeCommand("node -e 'process.exit(1)'"), {
    command: "node",
    args: ["-e", "process.exit(1)"],
  });
  assert.deepEqual(tokenizeCommand('npm run --prefix "a b" test'), {
    command: "npm",
    args: ["run", "--prefix", "a b", "test"],
  });
});

test("verifier runs quoted test args instead of silently passing (regression)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: 'node --test "fail.test.js"' } }),
    "fail.test.js": 'import { test } from "node:test";\ntest("boom", () => { throw new Error("x"); });\n',
  });
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    const outcome = await v.run(dir, profile, store);
    // A naive whitespace split would run 0 tests and exit 0 (false pass).
    assert.ok(!outcome.passed, "quoted failing test must fail verification");
    assert.equal(outcome.failedStage, "test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scriptless repo without a JS entry is reported as noTargets, not a doomed stage (FINDING-2CcenM)", async () => {
  // Repo with no typecheck/test/build scripts AND no index.js. Previously
  // detect emitted a doomed 'node --check index.js' stage that always failed,
  // hard-failing every scriptless repo. Now it emits no stage and reports an
  // honest noTargets outcome: NOT a pass (nothing was verified) and NOT a
  // hard-fail.
  const dir = await makeProject({
    "package.json": JSON.stringify({}),
  });
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    assert.equal(profile.stages.length, 0, "no doomed node --check stage for a scriptless repo");
    const outcome = await v.run(dir, profile, store);
    assert.equal(outcome.noTargets, true, "no verification targets reported honestly");
    assert.ok(!outcome.passed, "a run with zero passing stages must not pass");
    assert.equal(outcome.evidence.filter((e) => e.status === "passed").length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scriptless repo with a real index.js runs the node-syntax stage (FINDING-2CcenM)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({}),
    "index.js": "export const x = 1;\n",
  });
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    assert.equal(profile.stages.length, 1, "syntax stage emitted when a real entry exists");
    assert.equal(profile.stages[0]?.name, "node-syntax");
    const outcome = await v.run(dir, profile, store);
    assert.equal(outcome.noTargets, false);
    assert.ok(outcome.passed, "a valid JS entry should pass a node --check stage");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scriptless repo resolves entry from package.json main (FINDING-2CcenM)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({ main: "lib/main.js" }),
    "lib/main.js": "export const y = 2;\n",
  });
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    assert.equal(profile.stages.length, 1);
    assert.ok(profile.stages[0]!.args.includes("lib/main.js"), "syntax-checks the declared main entry");
    const outcome = await v.run(dir, profile, store);
    assert.ok(outcome.passed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier resolves bare local binaries from node_modules/.bin (regression: ENOENT gates)", async () => {
  // Reproduces the orchestrator bug where execFile('tsc', ...) failed with
  // ENOENT because node_modules/.bin was not on the ambient PATH when the
  // runtime is launched directly with `node` rather than via `npm`. Every
  // integration/validation gate then spuriously FAILED on empty output even
  // when the underlying tool worked. The verifier must prepend the repo's
  // local node_modules/.bin so bare binary names resolve.
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: "bar-hello" } }),
  });
  const binDir = join(dir, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, "bar-hello");
  await writeFile(binPath, "#!/bin/sh\necho hello-from-local-bin\n");
  await chmod(binPath, 0o755);
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    const stage = profile.stages.find((s) => s.name === "test");
    assert.equal(stage?.command, "bar-hello", "bare binary name must be parsed from the script");
    const outcome = await v.run(dir, profile, store);
    assert.ok(outcome.passed, "bare local binary must resolve via node_modules/.bin");
    assert.equal(outcome.failedStage, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier fails a candidate whose required test fails (AC-005)", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({ scripts: { test: "node -e process.exit(1)" } }),
  });
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    const outcome = await v.run(dir, profile, store);
    assert.ok(!outcome.passed);
    assert.equal(outcome.failedStage, "test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier aborts an active command promptly", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({}),
  });
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const verifier = new CommandVerifier();
    const controller = new AbortController();
    const profile = {
      name: "abortable",
      stages: [
        {
          name: "long-running",
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 10_000)"],
          required: true,
          timeoutMs: 30_000,
        },
      ],
    };

    const startedAt = Date.now();
    const pending = verifier.run(dir, profile, store, { signal: controller.signal });
    setTimeout(() => controller.abort(), 25);

    await assert.rejects(pending, (error: unknown) => {
      assert.equal((error as { name?: string }).name, "AbortError");
      return true;
    });
    assert.ok(Date.now() - startedAt < 2_000, "abort should not wait for the command timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier runs && chained npm scripts through a shell (session review: typecheck always failed)", async () => {
  // pi-engineering's own `typecheck` is `npm run a && npm run b`. Exec'ing the
  // split words without a shell passed `&&` as a literal argument, so every
  // chained script failed ("Could not resolve the path &&").
  const dir = await makeProject({
    "package.json": JSON.stringify({
      scripts: {
        typecheck: "node -e \"process.exit(0)\" && node -e \"require('fs').writeFileSync('ran.txt', 'ok')\"",
      },
    }),
  });
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const v = new CommandVerifier();
    const profile = await v.detect(dir);
    const outcome = await v.run(dir, profile, store);
    assert.ok(outcome.passed, "a chained script whose parts pass must pass");
    assert.equal(await readFile(join(dir, "ran.txt"), "utf-8"), "ok", "the second command of the chain ran");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifier fails a chained script when a later command fails", async () => {
  const dir = await makeProject({
    "package.json": JSON.stringify({
      scripts: { test: 'node -e "process.exit(0)" && node -e "process.exit(3)"' },
    }),
  });
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const v = new CommandVerifier();
    const outcome = await v.run(dir, await v.detect(dir), store);
    assert.ok(!outcome.passed);
    assert.equal(outcome.failedStage, "test");
    assert.equal(outcome.stages[0]?.exitCode, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detect finds checks for non-Node repositories (Cargo, Go, pytest, Makefile)", async () => {
  const cases: Array<{ files: Record<string, string>; expect: RegExp }> = [
    { files: { "Cargo.toml": '[package]\nname = "x"\nversion = "0.1.0"\n' }, expect: /^cargo test/ },
    { files: { "go.mod": "module example.com/x\n\ngo 1.21\n" }, expect: /^go test \.\/\.\.\./ },
    { files: { "pyproject.toml": "[tool.pytest.ini_options]\n" }, expect: /pytest/ },
    { files: { "pytest.ini": "[pytest]\n" }, expect: /pytest/ },
    { files: { Makefile: "test:\n\t@echo ok\n" }, expect: /^make test/ },
  ];
  for (const c of cases) {
    const dir = await makeProject(c.files);
    try {
      const profile = await new CommandVerifier().detect(dir);
      const commands = profile.stages.map((s) => [s.command, ...s.args].join(" "));
      assert.ok(
        commands.some((cmd) => c.expect.test(cmd)),
        `${Object.keys(c.files).join(",")}: expected a stage matching ${c.expect}, got ${JSON.stringify(commands)}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("verifier runs a Makefile test target and a real pytest suite", async () => {
  const makeDir = await makeProject({ Makefile: "test:\n\t@echo make-ok\n" });
  const pyDir = await makeProject({
    "pytest.ini": "[pytest]\n",
    "test_sample.py": "def test_ok():\n    assert 1 + 1 == 2\n",
  });
  try {
    const v = new CommandVerifier();
    const makeOutcome = await v.run(
      makeDir,
      await v.detect(makeDir),
      await ArtifactStore.create(join(makeDir, "artifacts")),
    );
    assert.ok(makeOutcome.passed, "make test must pass");
    assert.equal(makeOutcome.noTargets, false);
    const pyOutcome = await v.run(pyDir, await v.detect(pyDir), await ArtifactStore.create(join(pyDir, "artifacts")));
    assert.ok(pyOutcome.passed, `pytest must pass: ${JSON.stringify(pyOutcome.stages.map((s) => s.summary))}`);
  } finally {
    await rm(makeDir, { recursive: true, force: true });
    await rm(pyDir, { recursive: true, force: true });
  }
});

describe("verification commands have an inactivity hang guard, not a duration limit", () => {
  const chatty =
    'const t=setInterval(()=>console.log("test ok"),40);setTimeout(()=>{clearInterval(t);process.exit(0)},1500)';
  const silent = "setTimeout(()=>process.exit(0),30000)";

  it("lets a test command that keeps printing run past its hang guard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-eng-ver-"));
    try {
      const store = await ArtifactStore.create(join(dir, "artifacts"));
      const outcome = await new CommandVerifier().run(
        dir,
        {
          name: "long-suite",
          stages: [{ name: "test", command: process.execPath, args: ["-e", chatty], required: true, timeoutMs: 400 }],
        },
        store,
      );
      assert.equal(outcome.passed, true, "a suite that keeps producing output is never killed for running long");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kills a test command that goes silent for the hang-guard window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-eng-ver-"));
    try {
      const store = await ArtifactStore.create(join(dir, "artifacts"));
      const started = Date.now();
      const outcome = await new CommandVerifier().run(
        dir,
        {
          name: "hung-suite",
          stages: [{ name: "test", command: process.execPath, args: ["-e", silent], required: true, timeoutMs: 400 }],
        },
        store,
      );
      assert.equal(outcome.passed, false);
      assert.equal(outcome.failedStage, "test");
      assert.ok(Date.now() - started < 10_000, "the hung command is killed by inactivity, not left running");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kills the whole process tree of a hung command, so a grandchild cannot keep it open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-eng-ver-"));
    const tree =
      "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});setTimeout(()=>{},30000)";
    try {
      const store = await ArtifactStore.create(join(dir, "artifacts"));
      const outcome = await Promise.race([
        new CommandVerifier().run(
          dir,
          {
            name: "hung-tree",
            stages: [{ name: "test", command: process.execPath, args: ["-e", tree], required: true, timeoutMs: 400 }],
          },
          store,
        ),
        new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 10_000).unref()),
      ]);
      assert.notEqual(outcome, "stuck", "the hang guard itself must not hang");
      if (outcome !== "stuck") assert.equal(outcome.passed, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mixed repositories and orphaned verification processes (PR #106 review)", () => {
  it("detects Cargo/Go checks when package.json has no typecheck/test/build script", async () => {
    for (const [manifest, content, expect] of [
      ["Cargo.toml", '[package]\nname = "x"\nversion = "0.1.0"\n', /^cargo test/],
      ["go.mod", "module example.com/x\n\ngo 1.21\n", /^go test/],
    ] as const) {
      const dir = await makeProject({
        "package.json": JSON.stringify({ scripts: { lint: "biome check .", format: "biome format ." } }),
        [manifest]: content,
      });
      try {
        for (const full of [false, true]) {
          const commands = (await new CommandVerifier().detect(dir, { full })).stages.map((s) =>
            [s.command, ...s.args].join(" "),
          );
          assert.ok(
            commands.some((cmd) => expect.test(cmd)),
            `${manifest} full=${full}: ${JSON.stringify(commands)}`,
          );
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("treats npm's placeholder test script as no test script", async () => {
    const dir = await makeProject({
      "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "Cargo.toml": '[package]\nname = "x"\nversion = "0.1.0"\n',
    });
    try {
      const commands = (await new CommandVerifier().detect(dir)).stages.map((s) => [s.command, ...s.args].join(" "));
      assert.ok(
        commands.some((cmd) => /^cargo test/.test(cmd)),
        JSON.stringify(commands),
      );
      assert.ok(!commands.some((cmd) => /no test specified/.test(cmd)), JSON.stringify(commands));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps npm scripts authoritative when they declare a relevant script", async () => {
    const dir = await makeProject({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "Cargo.toml": '[package]\nname = "x"\nversion = "0.1.0"\n',
    });
    try {
      const commands = (await new CommandVerifier().detect(dir)).stages.map((s) => [s.command, ...s.args].join(" "));
      assert.ok(!commands.some((cmd) => cmd.startsWith("cargo")), JSON.stringify(commands));
      assert.ok(
        commands.some((cmd) => cmd.startsWith("node --test")),
        JSON.stringify(commands),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kills a verification process group when the parent process crashes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-eng-ver-orphan-"));
    const pidFile = join(dir, "grandchild.pid");
    const verifierUrl = new URL("../../src/verify/Verifier.ts", import.meta.url).href;
    const parentScript = join(dir, "parent.ts");
    await writeFile(
      parentScript,
      [
        `import { existsSync } from "node:fs";`,
        `import { runWithInactivityGuard } from ${JSON.stringify(verifierUrl)};`,
        `void runWithInactivityGuard(process.execPath, ["-e", ${JSON.stringify(
          `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
        )}], { cwd: ${JSON.stringify(dir)}, inactivityMs: 600000 });`,
        `const wait = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(wait); throw new Error("simulated Pi crash"); } }, 20);`,
      ].join("\n"),
    );
    try {
      const { spawnSync } = await import("node:child_process");
      const parent = spawnSync(process.execPath, [parentScript], { encoding: "utf8", timeout: 60_000 });
      assert.match(parent.stderr, /simulated Pi crash/, parent.stderr);
      const pid = Number(await readFile(pidFile, "utf-8"));
      const alive = (): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
      const survived = alive();
      if (survived) process.kill(pid, "SIGKILL");
      assert.equal(survived, false, "the verification process must not outlive the crashed parent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("leftover background processes after verification (PR #106 re-review)", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  for (const [label, background] of [
    ["with its output redirected", "sleep 300 >/dev/null 2>&1 &"],
    ["holding the output pipes", "sleep 300 &"],
  ] as const) {
    it(`kills a background child the stage left behind (${label}) and warns`, async () => {
      const dir = await makeProject({
        "package.json": JSON.stringify({ scripts: { test: `${background} echo $! > bg.pid; echo started` } }),
      });
      let pid = 0;
      try {
        const store = await ArtifactStore.create(join(dir, "artifacts"));
        const v = new CommandVerifier();
        const started = Date.now();
        const outcome = await v.run(dir, await v.detect(dir), store);
        pid = Number(await readFile(join(dir, "bg.pid"), "utf-8"));
        assert.ok(Date.now() - started < 60_000, "verification did not wait for the background child");
        assert.equal(outcome.passed, true, "leftover processes are a warning, not a failure");
        for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
        assert.equal(alive(pid), false, "the background child is gone after verification");
        assert.equal(outcome.stages[0]?.summary.leftoverProcesses, 1);
        assert.match(String(outcome.stages[0]?.summary.warning ?? ""), /left 1 background process/);
      } finally {
        if (pid && alive(pid)) process.kill(pid, "SIGKILL");
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
