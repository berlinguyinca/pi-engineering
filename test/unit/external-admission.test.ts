import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { listAdmissibleExternalMissions } from "../../src/orchestration/externalAdmission.ts";
import type { ExternalAdmissionInput } from "../../src/orchestration/externalAdmission.ts";

const NOW = new Date("2026-01-15T12:00:00.000Z");

function ext(mission_id: string, status: string, extra: Partial<ExternalAdmissionInput> = {}): ExternalAdmissionInput {
  return { mission_id, status, ...extra };
}

describe("listAdmissibleExternalMissions", () => {
  test("admits a NEW mission with no lease", () => {
    const result = listAdmissibleExternalMissions([ext("MSN-ext-aaa", "NEW")], NOW);
    assert.deepEqual(result, [{ mission_id: "MSN-ext-aaa", reason: "admit" }]);
  });

  test("admits a NEW mission whose lease has an expired renewBy", () => {
    const result = listAdmissibleExternalMissions(
      [ext("MSN-ext-aaa", "NEW", { lease: { renewBy: "2026-01-15T11:59:59.999Z" } })],
      NOW,
    );
    assert.deepEqual(result, [{ mission_id: "MSN-ext-aaa", reason: "admit" }]);
  });

  test("skips a mission whose lease is still live (renewBy >= now), incl. at the boundary instant", () => {
    // renewBy === now is still live: a supervisor must not take it over.
    const result = listAdmissibleExternalMissions(
      [ext("MSN-ext-aaa", "NEW", { lease: { renewBy: "2026-01-15T12:00:00.000Z" } })],
      NOW,
    );
    assert.deepEqual(result, [{ mission_id: "MSN-ext-aaa", reason: "skip_leased" }]);
  });

  test("skips running missions", () => {
    for (const status of ["RUNNING", "EXECUTING", "PLANNING", "INTEGRATING", "REVIEWING"]) {
      const result = listAdmissibleExternalMissions([ext("MSN-ext-aaa", status)], NOW);
      assert.deepEqual(result, [{ mission_id: "MSN-ext-aaa", reason: "skip_running" }], `status ${status}`);
    }
  });

  test("skips terminal missions", () => {
    for (const status of ["COMPLETE", "FAILED", "CANCELED", "BLOCKED"]) {
      const result = listAdmissibleExternalMissions([ext("MSN-ext-aaa", status)], NOW);
      assert.deepEqual(result, [{ mission_id: "MSN-ext-aaa", reason: "skip_terminal" }], `status ${status}`);
    }
  });

  test("skips unknown and lowercase statuses as skip_unknown_status", () => {
    for (const status of ["DRAFT", "new", "PAUSED", "NEW ", "RUNNIG"]) {
      const result = listAdmissibleExternalMissions([ext("MSN-ext-aaa", status)], NOW);
      assert.deepEqual(
        result,
        [{ mission_id: "MSN-ext-aaa", reason: "skip_unknown_status" }],
        `status ${JSON.stringify(status)}`,
      );
    }
  });

  test("treats an unparseable lease renewBy as live (fail closed)", () => {
    const result = listAdmissibleExternalMissions(
      [ext("MSN-ext-aaa", "NEW", { lease: { renewBy: "not-a-date" } })],
      NOW,
    );
    assert.deepEqual(result, [{ mission_id: "MSN-ext-aaa", reason: "skip_leased" }]);
  });

  test("a live lease on a RUNNING mission takes precedence over status", () => {
    const result = listAdmissibleExternalMissions(
      [ext("MSN-ext-aaa", "RUNNING", { lease: { renewBy: "2026-01-15T12:00:00.000Z" } })],
      NOW,
    );
    assert.deepEqual(result, [{ mission_id: "MSN-ext-aaa", reason: "skip_leased" }]);
  });

  test("ignores non-external missions", () => {
    const result = listAdmissibleExternalMissions(
      [ext("MSN-abc123", "NEW"), ext("MSN-ext-aaa", "NEW"), ext("MSN-other", "NEW")],
      NOW,
    );
    assert.deepEqual(result, [{ mission_id: "MSN-ext-aaa", reason: "admit" }]);
  });

  test("ignores MSN-extra and msn-ext-x (lowercase prefix)", () => {
    const result = listAdmissibleExternalMissions(
      [ext("MSN-extra", "NEW"), ext("msn-ext-x", "NEW"), ext("MSN-ext-aaa", "NEW")],
      NOW,
    );
    assert.deepEqual(result, [{ mission_id: "MSN-ext-aaa", reason: "admit" }]);
  });

  test("orders results oldest created_at first", () => {
    const result = listAdmissibleExternalMissions(
      [
        ext("MSN-ext-c", "NEW", { created_at: "2026-01-15T12:00:00.000Z" }),
        ext("MSN-ext-a", "RUNNING", { created_at: "2026-01-15T10:00:00.000Z" }),
        ext("MSN-ext-b", "NEW", { created_at: "2026-01-15T11:00:00.000Z" }),
      ],
      NOW,
    );
    assert.deepEqual(result, [
      { mission_id: "MSN-ext-a", reason: "skip_running" },
      { mission_id: "MSN-ext-b", reason: "admit" },
      { mission_id: "MSN-ext-c", reason: "admit" },
    ]);
  });

  test("stable across missions with the same created_at", () => {
    const result = listAdmissibleExternalMissions(
      [
        ext("MSN-ext-b", "NEW", { created_at: "2026-01-15T10:00:00.000Z" }),
        ext("MSN-ext-a", "NEW", { created_at: "2026-01-15T10:00:00.000Z" }),
      ],
      NOW,
    );
    assert.deepEqual(result, [
      { mission_id: "MSN-ext-b", reason: "admit" },
      { mission_id: "MSN-ext-a", reason: "admit" },
    ]);
  });

  test("missions with missing or invalid created_at sort last, after valid ones oldest-first", () => {
    const result = listAdmissibleExternalMissions(
      [
        ext("MSN-ext-b", "NEW", { created_at: "2026-01-15T11:00:00.000Z" }),
        ext("MSN-ext-d", "NEW"), // missing created_at
        ext("MSN-ext-a", "NEW", { created_at: "2026-01-15T10:00:00.000Z" }),
        ext("MSN-ext-e", "NEW", { created_at: "garbage" }), // invalid created_at
      ],
      NOW,
    );
    assert.deepEqual(result, [
      { mission_id: "MSN-ext-a", reason: "admit" },
      { mission_id: "MSN-ext-b", reason: "admit" },
      { mission_id: "MSN-ext-d", reason: "admit" },
      { mission_id: "MSN-ext-e", reason: "admit" },
    ]);
  });

  test("duplicate mission ids are both kept in their original order (no Map collision)", () => {
    const result = listAdmissibleExternalMissions(
      [
        ext("MSN-ext-dup", "NEW", { created_at: "2026-01-15T10:00:00.000Z" }),
        ext("MSN-ext-dup", "RUNNING", { created_at: "2026-01-15T10:00:00.000Z" }),
        ext("MSN-ext-dup", "DRAFT", { created_at: "2026-01-15T10:00:00.000Z" }),
      ],
      NOW,
    );
    assert.deepEqual(result, [
      { mission_id: "MSN-ext-dup", reason: "admit" },
      { mission_id: "MSN-ext-dup", reason: "skip_running" },
      { mission_id: "MSN-ext-dup", reason: "skip_unknown_status" },
    ]);
  });
});
