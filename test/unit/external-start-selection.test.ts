import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { selectExternalMissionsToStart } from "../../src/orchestration/externalStartSelection.ts";
import type { ExternalStartInput } from "../../src/orchestration/externalStartSelection.ts";
import type { Mission, MissionStatus } from "../../src/orchestration/types.ts";

const NOW = new Date("2026-01-15T12:00:00.000Z");

function ext(
  mission_id: string,
  status: MissionStatus,
  extra: Partial<ExternalStartInput> = {},
  created_at?: string,
): ExternalStartInput {
  const mission: Pick<Mission, "mission_id" | "status" | "created_at"> = {
    mission_id,
    status,
    created_at: created_at ?? "",
  };
  if (created_at !== undefined) mission.created_at = created_at;
  return { mission, ...extra };
}

describe("selectExternalMissionsToStart", () => {
  test("admits a NEW mission with no lease", () => {
    const result = selectExternalMissionsToStart([ext("MSN-ext-aaa", "NEW")], "self", NOW, 5, 0);
    assert.deepEqual(result, ["MSN-ext-aaa"]);
  });

  test("skips a live lease owned by another owner", () => {
    const result = selectExternalMissionsToStart(
      [ext("MSN-ext-aaa", "NEW", { lease: { ownerId: "other", renewBy: "2026-01-15T13:00:00.000Z" } })],
      "self",
      NOW,
      5,
      0,
    );
    assert.deepEqual(result, []);
  });

  test("admits a self-owned live lease", () => {
    const result = selectExternalMissionsToStart(
      [ext("MSN-ext-aaa", "NEW", { lease: { ownerId: "self", renewBy: "2026-01-15T13:00:00.000Z" } })],
      "self",
      NOW,
      5,
      0,
    );
    assert.deepEqual(result, ["MSN-ext-aaa"]);
  });

  test("admits an expired foreign lease", () => {
    const result = selectExternalMissionsToStart(
      [ext("MSN-ext-aaa", "NEW", { lease: { ownerId: "other", renewBy: "2026-01-15T11:59:59.999Z" } })],
      "self",
      NOW,
      5,
      0,
    );
    assert.deepEqual(result, ["MSN-ext-aaa"]);
  });

  test("renewBy equal to now counts as live (skipped when foreign)", () => {
    const result = selectExternalMissionsToStart(
      [ext("MSN-ext-aaa", "NEW", { lease: { ownerId: "other", renewBy: "2026-01-15T12:00:00.000Z" } })],
      "self",
      NOW,
      5,
      0,
    );
    assert.deepEqual(result, []);
  });

  test("unparseable renewBy counts as live (skipped when foreign)", () => {
    const result = selectExternalMissionsToStart(
      [ext("MSN-ext-aaa", "NEW", { lease: { ownerId: "other", renewBy: "not-a-date" } })],
      "self",
      NOW,
      5,
      0,
    );
    assert.deepEqual(result, []);
  });

  test("skips QUEUED, EXECUTING, COMPLETE, FAILED, CANCELED", () => {
    for (const status of ["QUEUED", "EXECUTING", "COMPLETE", "FAILED", "CANCELED"] as MissionStatus[]) {
      const result = selectExternalMissionsToStart([ext("MSN-ext-aaa", status)], "self", NOW, 5, 0);
      assert.deepEqual(result, [], `status ${status}`);
    }
  });

  test("skips a non-'MSN-ext-' id", () => {
    const result = selectExternalMissionsToStart(
      [ext("MSN-abc123", "NEW"), ext("MSN-ext-aaa", "NEW")],
      "self",
      NOW,
      5,
      0,
    );
    assert.deepEqual(result, ["MSN-ext-aaa"]);
  });

  test("sorts oldest first with invalid date last and tie-break by id", () => {
    const result = selectExternalMissionsToStart(
      [
        ext("MSN-ext-c", "NEW", {}, "2026-01-15T12:00:00.000Z"),
        ext("MSN-ext-e", "NEW"), // missing created_at -> last
        ext("MSN-ext-a", "NEW", {}, "2026-01-15T10:00:00.000Z"),
        ext("MSN-ext-b", "NEW", {}, "2026-01-15T11:00:00.000Z"),
        ext("MSN-ext-d", "NEW", {}, "garbage"), // invalid created_at -> last
      ],
      "self",
      NOW,
      5,
      0,
    );
    assert.deepEqual(result, ["MSN-ext-a", "MSN-ext-b", "MSN-ext-c", "MSN-ext-d", "MSN-ext-e"]);
  });

  test("tie-breaks equal created_at by mission_id ascending", () => {
    const result = selectExternalMissionsToStart(
      [
        ext("MSN-ext-b", "NEW", {}, "2026-01-15T10:00:00.000Z"),
        ext("MSN-ext-a", "NEW", {}, "2026-01-15T10:00:00.000Z"),
      ],
      "self",
      NOW,
      5,
      0,
    );
    assert.deepEqual(result, ["MSN-ext-a", "MSN-ext-b"]);
  });

  test("running >= max returns []", () => {
    const result = selectExternalMissionsToStart([ext("MSN-ext-aaa", "NEW")], "self", NOW, 3, 3);
    assert.deepEqual(result, []);
  });

  test("max 3 and running 1 -> at most 2", () => {
    const result = selectExternalMissionsToStart(
      [
        ext("MSN-ext-a", "NEW", {}, "2026-01-15T10:00:00.000Z"),
        ext("MSN-ext-b", "NEW", {}, "2026-01-15T11:00:00.000Z"),
        ext("MSN-ext-c", "NEW", {}, "2026-01-15T12:00:00.000Z"),
      ],
      "self",
      NOW,
      3,
      1,
    );
    assert.deepEqual(result, ["MSN-ext-a", "MSN-ext-b"]);
  });

  test("maxConcurrent 0 or NaN -> []", () => {
    const result0 = selectExternalMissionsToStart([ext("MSN-ext-aaa", "NEW")], "self", NOW, 0, 0);
    assert.deepEqual(result0, []);
    const resultNaN = selectExternalMissionsToStart([ext("MSN-ext-aaa", "NEW")], "self", NOW, Number.NaN, 0);
    assert.deepEqual(resultNaN, []);
  });

  test("non-finite runningExternalCount -> []", () => {
    const result = selectExternalMissionsToStart([ext("MSN-ext-aaa", "NEW")], "self", NOW, 5, Number.POSITIVE_INFINITY);
    assert.deepEqual(result, []);
  });

  test("input immutability (deep snapshot)", () => {
    const input: ExternalStartInput[] = [
      ext(
        "MSN-ext-a",
        "NEW",
        { lease: { ownerId: "self", renewBy: "2026-01-15T13:00:00.000Z" } },
        "2026-01-15T10:00:00.000Z",
      ),
      ext("MSN-ext-b", "QUEUED"),
    ];
    const snapshot = structuredClone(input);
    selectExternalMissionsToStart(input, "self", NOW, 5, 0);
    assert.deepEqual(input, snapshot);
  });
});
