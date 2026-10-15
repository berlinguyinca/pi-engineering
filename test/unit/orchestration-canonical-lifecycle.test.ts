import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANONICAL_ONLY_STATES,
  type CanonicalLifecycleState,
  LIFECYCLE_SCHEMA_VERSION,
  isCanonicalTerminal,
  toCanonical,
} from "../../src/orchestration/canonicalLifecycle.ts";
import type { MissionStatus } from "../../src/orchestration/types.ts";

// A Record keyed by MissionStatus: adding a status to the union without listing
// it here is a compile error, so the exhaustive test cannot silently go stale.
const EXPECTED: Record<MissionStatus, CanonicalLifecycleState> = {
  NEW: "CREATED",
  CLASSIFYING: "CREATED",
  PLANNING: "PLANNED",
  READY: "READY",
  QUEUED: "READY",
  STARTING: "RUNNING",
  EXECUTING: "RUNNING",
  INTEGRATING: "RUNNING",
  VALIDATING: "VALIDATING",
  REVIEWING: "REVIEWING",
  REPAIRING: "REPAIRING",
  FINAL_VALIDATION: "VALIDATING",
  COMPLETE: "MERGED",
  WAITING_FOR_USER: "PAUSED",
  WAITING_FOR_LLM: "PAUSED",
  WAITING_FOR_CAPACITY: "PAUSED",
  WAITING_FOR_GATEWAY: "PAUSED",
  WAITING_FOR_MODEL: "PAUSED",
  WAITING_FOR_TOOL: "PAUSED",
  RECOVERING_CONTEXT: "RECOVERING",
  RECOVERING_PROCESS: "RECOVERING",
  PAUSED_INFRASTRUCTURE: "PAUSED",
  NEEDS_ATTENTION: "BLOCKED",
  BLOCKED: "BLOCKED",
  CANCELING: "CANCELLED",
  CANCELED: "CANCELLED",
  FAILED: "FAILED",
};

const CANONICAL: readonly CanonicalLifecycleState[] = [
  "CREATED",
  "PLANNED",
  "READY",
  "RUNNING",
  "VALIDATING",
  "REVIEWING",
  "REPAIRING",
  "MERGE_QUEUED",
  "MERGING",
  "MERGED",
  "FINALIZING",
  "ARCHIVED",
  "BLOCKED",
  "PAUSED",
  "FAILED",
  "CANCELLED",
  "RECOVERING",
  "RETAINED_FOR_DIAGNOSTICS",
];

describe("canonical lifecycle projection (spec §2a row 2, R-LIFE)", () => {
  it("returns a canonical state for every MissionStatus", () => {
    for (const [status, want] of Object.entries(EXPECTED)) {
      const got = toCanonical(status as MissionStatus);
      assert.equal(got, want, `${status} -> ${got}`);
      assert.ok(CANONICAL.includes(got), `${status} projects outside the canonical set`);
    }
  });

  it("maps the issue's named statuses", () => {
    assert.equal(toCanonical("NEW"), "CREATED");
    assert.equal(toCanonical("CANCELED"), "CANCELLED");
    assert.equal(toCanonical("CANCELING"), "CANCELLED");
    assert.equal(toCanonical("INTEGRATING"), "RUNNING");
    assert.equal(toCanonical("FINAL_VALIDATION"), "VALIDATING");
    assert.equal(toCanonical("NEEDS_ATTENTION"), "BLOCKED");
  });

  it("maps COMPLETE to MERGED, never ARCHIVED: nothing proves cleanup today", () => {
    assert.equal(toCanonical("COMPLETE"), "MERGED");
    for (const status of Object.keys(EXPECTED) as MissionStatus[]) {
      assert.notEqual(toCanonical(status), "ARCHIVED");
    }
  });

  it("pins the schema version", () => {
    assert.equal(LIFECYCLE_SCHEMA_VERSION, 1);
  });

  it("treats only ARCHIVED, FAILED and CANCELLED as canonically terminal", () => {
    const terminal = CANONICAL.filter((s) => isCanonicalTerminal(s));
    assert.deepEqual([...terminal].sort(), ["ARCHIVED", "CANCELLED", "FAILED"]);
    assert.equal(isCanonicalTerminal("MERGED"), false);
  });

  it("lists exactly the canonical states no source status reaches yet", () => {
    const reached = new Set(Object.keys(EXPECTED).map((s) => toCanonical(s as MissionStatus)));
    const unreached = CANONICAL.filter((s) => !reached.has(s));
    assert.deepEqual([...CANONICAL_ONLY_STATES].sort(), [...unreached].sort());
    // COMPLETE reaches MERGED, so MERGED is not canonical-only despite the issue's prose list.
    assert.ok(!CANONICAL_ONLY_STATES.includes("MERGED"));
  });
});
