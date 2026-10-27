import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

for (const [goal, file, content, expected] of [
  ["Fix README typo", "README.md", "Corrected spelling\n", "promoted"],
  ["Fix README typo and run all tests", "README.md", "Corrected spelling\n", "failed"],
  ["Fix README typo; run npm test", "README.md", "Corrected spelling\n", "failed"],
  ["Fix comment typo", "src/add.js", "export function add() { throw new Error('broken'); }\n", "failed"],
  ["Fix requirements doc typo", "requirements.txt", "bad-dependency\n", "failed"],
  ["Fix README typo", "README.md", "Trailing whitespace  \n", "failed"],
] as const) {
  test(`low-risk verification ${goal} (${file}, ${expected})`, async () => {
    const fixture = await makeFixtureRepo();
    try {
      // This fixture deliberately has failing code tests. A documentation-only
      // correction should run its cheap patch check, while code changes and
      // explicit suite requests must still see those failing tests.
      const worker = new FakeWorkerExecutor({
        implementer: async (req) => {
          await writeFile(join(req.cwd, file), content);
          return { status: "completed", summary: "edited" };
        },
        reviewer: () => ({ status: "completed", summary: "reviewed", details: { findings: [] } }),
      });
      const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker });
      const report = await rt.engineer(goal);
      assert.equal(report.outcome, expected);
      const stages = report.verification?.stages.map((s) => s.stage.name);
      if (goal === "Fix README typo") assert.deepEqual(stages, ["patch-whitespace"]);
      else assert.ok(stages?.includes("test"), "normal gates must survive code changes or explicit requests");
    } finally {
      await fixture.cleanup();
    }
  });
}

test("low-risk code uses a trusted owner-declared quick profile", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await writeFile(
      join(fixture.root, "package.json"),
      JSON.stringify({
        type: "module",
        scripts: {
          test: "node --test",
          "verify:quick": "node -e \"process.stdout.write('quick-check-ran')\"",
        },
      }),
    );
    const worker = new FakeWorkerExecutor({
      implementer: async (req) => {
        await writeFile(
          join(req.cwd, "src/add.js"),
          "// corrected comment\nexport function add() { throw new Error('broken'); }\n",
        );
        return { status: "completed", summary: "edited comment" };
      },
      reviewer: () => ({ status: "completed", summary: "reviewed", details: { findings: [] } }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker });
    const report = await rt.engineer("Fix comment typo");
    assert.equal(report.outcome, "promoted");
    assert.deepEqual(
      report.verification?.stages.map((s) => s.stage.name),
      ["verify:quick"],
    );
    assert.equal(report.verification?.stages[0]?.exitCode, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("documentation checks declared by the trusted project remain required", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await writeFile(
      join(fixture.root, "package.json"),
      JSON.stringify({
        type: "module",
        scripts: {
          test: "node --test",
          "test:docs": 'node -e "process.exit(1)"',
        },
      }),
    );
    const worker = new FakeWorkerExecutor({
      implementer: async (req) => {
        await writeFile(join(req.cwd, "README.md"), "Corrected spelling\n");
        return { status: "completed", summary: "edited docs" };
      },
      reviewer: () => ({ status: "completed", summary: "reviewed", details: { findings: [] } }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker });
    const report = await rt.engineer("Fix README typo");
    assert.equal(report.outcome, "failed");
    assert.equal(report.verification?.failedStage, "test:docs");
    assert.deepEqual(
      report.verification?.stages.map((s) => s.stage.name),
      ["patch-whitespace", "test:docs"],
    );
  } finally {
    await fixture.cleanup();
  }
});

for (const request of ["run tests in full", "run the test suite in full"]) {
  test(`explicit ${request} retains the trusted full-suite gate`, async () => {
    const fixture = await makeFixtureRepo();
    try {
      await writeFile(
        join(fixture.root, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: {
            test: 'node -e "process.exit(0)"',
            lint: 'node -e "process.exit(0)"',
            "test:full": 'node -e "process.exit(1)"',
          },
        }),
      );
      const worker = new FakeWorkerExecutor({
        implementer: async (req) => {
          await writeFile(join(req.cwd, "README.md"), "Corrected spelling\n");
          return { status: "completed", summary: "edited docs" };
        },
        reviewer: () => ({ status: "completed", summary: "reviewed", details: { findings: [] } }),
      });
      const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker });
      const report = await rt.engineer(`Fix README typo and ${request}`);
      assert.equal(report.outcome, "failed", "a passing default test must not bypass a failing requested full suite");
      assert.equal(report.verification?.failedStage, "test:full");
      assert.deepEqual(
        report.verification?.stages.map((s) => s.stage.name),
        ["test", "lint", "test:full"],
      );
    } finally {
      await fixture.cleanup();
    }
  });
}
