/**
 * Update lines must name the move (issue #484).
 *
 * `package.json` version is not bumped per commit, so `metadata.version` is
 * always `0.2.0` and every notice read "Pi Engineering 0.2.0 → 0.2.0" — which
 * looks like a no-op even when an update was activated. The identity that
 * distinguishes a release is the version id (version + commit prefix), the
 * same key `versions/<id>`, the journal and telemetry use.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeMove, runtimeLabel } from "../../src/update/reporting.ts";

const FROM = { version: "0.2.0", commit: "b662443f395d8b464b628a502e8b420e6886f318" };
const TO = { version: "0.2.0", commit: "d85a758986774e4dd9217dab066db2ea9659c122" };

test("a runtime is labelled by version id, not the bare package version", () => {
  assert.equal(runtimeLabel(FROM), "0.2.0-b662443f395d");
});

test("a runtime with no recorded commit falls back to its version", () => {
  assert.equal(runtimeLabel({ version: "0.2.0", commit: null }), "0.2.0");
  assert.equal(runtimeLabel({ version: "0.2.0" }), "0.2.0");
});

test("an unreadable runtime is labelled as unknown rather than an empty version", () => {
  assert.equal(runtimeLabel(null), "unknown");
});

test("a move names both sides by version id", () => {
  assert.equal(describeMove(FROM, TO), "0.2.0-b662443f395d → 0.2.0-d85a75898677");
});

test("a move from an unknown runtime says so instead of printing a bare version", () => {
  assert.equal(describeMove(null, TO), "unknown → 0.2.0-d85a75898677");
});

test("two releases of the same package version are still distinguishable", () => {
  assert.notEqual(runtimeLabel(FROM), runtimeLabel(TO));
});
