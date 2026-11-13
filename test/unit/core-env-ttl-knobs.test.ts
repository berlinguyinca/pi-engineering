/**
 * Operator duration knobs.
 *
 * These knobs exist so a latency problem is fixed with an environment variable rather than an edit to an
 * installed release, which is immutable: an in-place patch there fails release attestation (so the fleet can
 * no longer say what is installed) and the next rollout deletes the work. That trade is only safe if a bad
 * value can never be worse than the compiled default, which is what most of this file is about — a knob that
 * accepts `50` for a health TTL turns a cache into a stampede, and a knob that reads `Pi_ENG_...` as 0 does
 * the same to every probe cadence at once.
 *
 * The constants are read at module load, so the per-knob cases run in a subprocess; asserting the helper
 * alone would not prove a knob is wired to the constant someone actually consumes.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { envTtlMs } from "../../src/core/envKnob.ts";

/** Read an exported constant the way a session would: fresh process, the knob in its environment. */
function loadedValue(modulePath: string, exportName: string, knob: string, env: Record<string, string>): number {
  // Absolute, because the child resolves a bare relative specifier against its own cwd, not against this file.
  const target = new URL(modulePath, import.meta.url).pathname;
  const script = `import(${JSON.stringify(target)}).then((m) => console.log(m[${JSON.stringify(exportName)}]));`;
  const childEnv: Record<string, string | undefined> = { ...process.env };
  // "Unset" has to mean unset in the child too, not whatever the harness happened to export -- strip first,
  // then apply the case's value, or the value being tested is the thing that gets stripped.
  delete childEnv[knob];
  Object.assign(childEnv, env);
  return Number(
    execFileSync(process.execPath, ["-e", script], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: childEnv as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 120_000,
    }).trim(),
  );
}

test("helper: unset, empty, and unparseable all keep the default", () => {
  for (const value of [undefined, "", "abc", "30s", "NaN", "Infinity", "-1"]) {
    if (value === undefined) delete process.env.PI_ENG_TEST_TTL_MS;
    else process.env.PI_ENG_TEST_TTL_MS = value;
    assert.equal(envTtlMs("PI_ENG_TEST_TTL_MS", 30_000), 30_000, `value ${String(value)} must not apply`);
  }
  delete process.env.PI_ENG_TEST_TTL_MS;
});

test("helper: a value at or above the floor applies, fractions floor down", () => {
  process.env.PI_ENG_TEST_TTL_MS = "1000";
  assert.equal(envTtlMs("PI_ENG_TEST_TTL_MS", 30_000), 1_000, "the floor itself is allowed");
  process.env.PI_ENG_TEST_TTL_MS = "2500.9";
  assert.equal(envTtlMs("PI_ENG_TEST_TTL_MS", 30_000), 2_500, "no fractional milliseconds");
  delete process.env.PI_ENG_TEST_TTL_MS;
});

test("helper: the floor is per knob, so a snapshot cadence can go below one second", () => {
  process.env.PI_ENG_TEST_TTL_MS = "500";
  assert.equal(envTtlMs("PI_ENG_TEST_TTL_MS", 30_000), 30_000, "500 ms is under the default one-second floor");
  assert.equal(envTtlMs("PI_ENG_TEST_TTL_MS", 750, 50), 500, "a 50 ms floor admits it");
  process.env.PI_ENG_TEST_TTL_MS = "49";
  assert.equal(envTtlMs("PI_ENG_TEST_TTL_MS", 750, 50), 750, "still fail-closed under the explicit floor");
  delete process.env.PI_ENG_TEST_TTL_MS;
});

const KNOBS: ReadonlyArray<readonly [string, string, string, number]> = [
  ["PI_ENG_HEALTH_TTL_MS", "../../src/models/health.ts", "DEFAULT_HEALTH_TTL_MS", 30_000],
  ["PI_ENG_WORKSPACE_TTL_MS", "../../src/panel/feeders/WorkspaceFeeder.ts", "DEFAULT_WORKSPACE_TTL_MS", 30_000],
  ["PI_ENG_STORAGE_PROBE_MS", "../../src/resilience/storagePressure.ts", "DEFAULT_PROBE_INTERVAL_MS", 30_000],
];

for (const [name, modulePath, exportName, fallback] of KNOBS) {
  test(`${name} retunes ${exportName} and never changes the default when unset or invalid`, () => {
    assert.equal(loadedValue(modulePath, exportName, name, {}), fallback, "default must hold when the knob is unset");
    assert.equal(loadedValue(modulePath, exportName, name, { [name]: "40000" }), 40_000, "knob must apply");
    assert.equal(
      loadedValue(modulePath, exportName, name, { [name]: "5" }),
      fallback,
      "a sub-second value must be refused, not believed",
    );
    assert.equal(
      loadedValue(modulePath, exportName, name, { [name]: "nonsense" }),
      fallback,
      "a typo must fall back, not become zero",
    );
  });
}
