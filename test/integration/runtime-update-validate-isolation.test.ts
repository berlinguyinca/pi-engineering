/**
 * Candidate validation never runs candidate code in the Pi process before the
 * isolated probe has passed (spec §16, §47): the migration dry-run belongs to
 * the probe child, not to the process that validates.
 */

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { writeStateSchema } from "../../src/runtime/migrations/schema.ts";
import { parseCandidateMetadata } from "../../src/update/metadata.ts";
import { validateCandidate } from "../../src/update/validate.ts";
import { type FixtureMode, writeFixtureRuntime } from "../support/runtimeFixtures.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function world(behaviour: "ok" | "throw", mode: FixtureMode = "ok") {
  const root = mkdtempSync(join(tmpdir(), "rt-validate-iso-"));
  dirs.push(root);
  const candidate = join(root, "candidate");
  writeFixtureRuntime(candidate, `__rt_validate_iso_${process.pid}`, {
    value: "C",
    version: "0.3.0",
    mode,
    stateSchema: { minReadable: 8, maxReadable: 8, writes: 8 },
    migration: { from: 7, to: 8, behaviour },
  });
  const marker = join(root, "imported-by.txt");
  // Loading the candidate's migrations module records which process did it.
  appendFileSync(
    join(candidate, "migrations.ts"),
    `import { appendFileSync as __mark } from "node:fs";\n__mark(${JSON.stringify(marker)}, process.pid + "\\n");\n`,
  );
  const state = join(root, "project", ".pi-eng");
  mkdirSync(state, { recursive: true });
  writeStateSchema(state, 7);
  writeFileSync(join(state, "missions.json"), JSON.stringify({ schema: 7, missions: ["MSN-1"] }));
  const metadata = parseCandidateMetadata(readFileSync(join(candidate, "package.json"), "utf8"), "runtime.ts");
  const importers = () =>
    existsSync(marker)
      ? readFileSync(marker, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((pid) => Number(pid))
      : [];
  return { candidate, state, metadata, importers };
}

function validate(w: ReturnType<typeof world>) {
  return validateCandidate({
    dir: w.candidate,
    metadata: w.metadata,
    runningPiVersion: "0.87.1",
    supportedRuntimeApis: [1],
    stateDir: w.state,
    mode: "quick",
  });
}

test("a failing migration dry-run is caught in the probe child; the Pi process never imports the candidate", async () => {
  const w = world("throw");
  const result = await validate(w);
  assert.equal(result.ok, false);
  const failed = result.steps.find((s) => s.status === "failed");
  assert.match(`${failed?.name}: ${failed?.detail}`, /migration dry-run failed/);
  assert.ok(w.importers().length > 0, "the dry-run did run (in a child)");
  assert.equal(w.importers().includes(process.pid), false, "candidate migrations never loaded in this process");
});

test("a candidate whose runtime fails the probe is never imported here, even when it ships migrations", async () => {
  const w = world("ok", "throw-start");
  const result = await validate(w);
  assert.equal(result.ok, false);
  assert.equal(w.importers().includes(process.pid), false);
});

test("a passing candidate validates with its migration plan once the probe passed", async () => {
  const w = world("ok");
  const result = await validate(w);
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(
    result.migration?.plan.map((m) => m.id),
    ["v7-v8"],
  );
  assert.equal(
    result.steps.find((s) => s.name === "migration dry-run")?.status,
    "passed",
    "dry-run reported from the probe",
  );
});

test("candidate code runs with a scrubbed environment and a temporary HOME, never the operator's", async () => {
  const w = world("ok");
  const marker = join(w.candidate, "..", "probe-env.json");
  appendFileSync(
    join(w.candidate, "runtime.ts"),
    `import { writeFileSync as __env } from "node:fs";\n__env(${JSON.stringify(marker)}, JSON.stringify({ home: process.env.HOME ?? null, secret: process.env.PI_ENG_TEST_SECRET ?? null, state: process.env.PI_ENGINEERING_STATE_DIR ?? null, install: process.env.PI_ENGINEERING_HOME ?? null }));\n`,
  );
  process.env.PI_ENG_TEST_SECRET = "s3cret-token";
  try {
    const result = await validate(w);
    assert.equal(result.ok, true, JSON.stringify(result.steps));
  } finally {
    delete process.env.PI_ENG_TEST_SECRET;
  }
  const seen = JSON.parse(readFileSync(marker, "utf8")) as Record<string, string | null>;
  assert.equal(seen.secret, null, "unrelated environment (tokens, credentials) is not passed on");
  assert.ok(seen.home && seen.home !== process.env.HOME && seen.home.startsWith(tmpdir()), `HOME=${seen.home}`);
  assert.ok(seen.state && seen.state !== process.env.PI_ENGINEERING_STATE_DIR, "own runtime state dir");
  assert.ok(seen.install && seen.install !== process.env.PI_ENGINEERING_HOME, "own install root");
  assert.equal(existsSync(seen.home), false, "the temporary HOME is removed afterwards");
});
