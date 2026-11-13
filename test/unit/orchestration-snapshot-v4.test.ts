import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalId, parseGithubRef } from "../../src/github/refs.ts";
import { type GithubLinkRecord, type LinkProvenance, linkIdFor } from "../../src/github/types.ts";
import {
  MISSION_SNAPSHOT_CONTRACT_VERSION,
  MISSION_SNAPSHOT_MAX_LINKS,
  type MissionSnapshotFile,
  buildMissionSnapshotFile,
  mergeSnapshotFiles,
} from "../../src/orchestration/missionSnapshot.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const LEGACY = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mission-snapshot-v3-legacy.json");

function newMission(title = "Add health endpoint", goal = "Add /health") {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    title,
    goal,
    user_request: goal,
    repository: ".",
    base_ref: "abc",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  return { store, mission };
}

function link(
  missionId: string,
  ref: string,
  kind: "issue" | "pr",
  status: GithubLinkRecord["status"] = "active",
  subjectId = missionId,
): GithubLinkRecord {
  const parsed = parseGithubRef(ref);
  assert.ok(parsed.ok);
  const target = canonicalId({ ...parsed.ref, kind }) as string;
  const subject = { kind: "mission" as const, id: subjectId };
  return {
    linkId: linkIdFor(missionId, subject, target),
    missionId,
    subject,
    target,
    targetKind: kind,
    provenance: "operator",
    source: "operator",
    observed: {},
    status,
    recordedAt: "2026-11-01T00:00:00.000Z",
  };
}

function build(
  m: ReturnType<typeof newMission>["mission"],
  githubLinks?: GithubLinkRecord[],
): MissionSnapshotFile["missions"][number] {
  return buildMissionSnapshotFile([{ mission: m, tasks: [], findings: [], githubLinks }]).missions[0]!;
}

describe("mission snapshot contract v4 (additive)", () => {
  it("is contract version 4", () => {
    assert.equal(MISSION_SNAPSHOT_CONTRACT_VERSION, 4);
  });

  it("carries created_at and completed_at from the Mission record", () => {
    const { mission } = newMission();
    const done = { ...mission, completed_at: "2026-11-02T10:00:00.000Z" };
    const snap = build(done);
    assert.equal(snap.created_at, mission.created_at);
    assert.equal(snap.completed_at, "2026-11-02T10:00:00.000Z");
  });

  it("omits completed_at (no key) while the mission has none, and never infers one", () => {
    const { mission } = newMission();
    assert.equal(mission.completed_at, null);
    const snap = build(mission);
    assert.equal("completed_at" in snap, false);
    assert.equal("links" in snap, false);
  });

  it("omits created_at when the record has none", () => {
    const { mission } = newMission();
    const snap = build({ ...mission, created_at: undefined as unknown as string });
    assert.equal("created_at" in snap, false);
  });

  it("emits links only from stored active GithubLinkRecords, with exact field names", () => {
    const { mission } = newMission();
    const snap = build(mission, [
      link(mission.mission_id, "Org/Repo#7", "pr"),
      link(mission.mission_id, "org/repo#3", "issue"),
    ]);
    assert.deepEqual(snap.links, [
      { kind: "issue", repository: "org/repo", number: 3 },
      { kind: "pull_request", repository: "org/repo", number: 7 },
    ]);
  });

  it("skips removed and not_found links and links of other missions", () => {
    const { mission } = newMission();
    const snap = build(mission, [
      link(mission.mission_id, "org/repo#1", "issue", "removed"),
      link(mission.mission_id, "org/repo#2", "issue", "not_found"),
      link("MSN-other", "org/repo#3", "issue"),
    ]);
    assert.equal("links" in snap, false);
  });

  it("dedupes links that differ only by subject, and sorts by repository, kind, number", () => {
    const { mission } = newMission();
    const snap = build(mission, [
      link(mission.mission_id, "b/z#9", "issue"),
      link(mission.mission_id, "a/z#10", "issue"),
      link(mission.mission_id, "a/z#2", "issue"),
      link(mission.mission_id, "a/z#2", "issue", "active", "TASK-1"),
      link(mission.mission_id, "a/z#2", "pr"),
    ]);
    assert.deepEqual(
      snap.links?.map((l) => `${l.repository}|${l.kind}|${l.number}`),
      ["a/z|issue|2", "a/z|issue|10", "a/z|pull_request|2", "b/z|issue|9"],
    );
  });

  it("bounds links to the maximum", () => {
    const { mission } = newMission();
    const many = Array.from({ length: MISSION_SNAPSHOT_MAX_LINKS + 40 }, (_, i) =>
      link(mission.mission_id, `org/repo#${i + 1}`, "issue"),
    );
    assert.equal(MISSION_SNAPSHOT_MAX_LINKS, 100);
    assert.equal(build(mission, many).links?.length, 100);
  });

  it("does not project explicit_ref records (regex-extracted from goal/task/branch/PR-body text)", () => {
    const { mission } = newMission("Fix it", "Mentions org/repo#12 in passing");
    const rec = {
      ...link(mission.mission_id, "org/repo#12", "issue"),
      provenance: "explicit_ref" as const,
      source: "goal",
    };
    assert.equal("links" in build(mission, [rec]), false);
  });

  for (const provenance of [
    "operator",
    "autospec",
    "pr_create_output",
    "confirmed_suggestion",
  ] as const satisfies readonly LinkProvenance[]) {
    it(`projects an active ${provenance} record`, () => {
      const { mission } = newMission();
      const rec = { ...link(mission.mission_id, "org/repo#5", "issue"), provenance };
      assert.deepEqual(build(mission, [rec]).links, [{ kind: "issue", repository: "org/repo", number: 5 }]);
    });
  }

  it("drops a record whose provenance is not an explicit operator/system action (unknown/unconfirmed value)", () => {
    const { mission } = newMission();
    const rec = {
      ...link(mission.mission_id, "org/repo#6", "issue"),
      provenance: "suggested" as unknown as LinkProvenance,
    };
    assert.equal("links" in build(mission, [rec]), false);
  });

  it("never invents a link from title, goal or branch text", () => {
    const { mission } = newMission(
      "Fix org/repo#42",
      "Resolves https://github.com/org/repo/issues/42 on branch fix/42-thing",
    );
    const snap = build(mission, []);
    assert.equal("links" in snap, false);
    assert.equal("links" in build(mission), false);
  });

  it("drops a stored link whose target cannot be parsed or is not on github.com instead of guessing", () => {
    const { mission } = newMission();
    const bad = { ...link(mission.mission_id, "org/repo#1", "issue"), target: "issue:garbage" };
    const ghes = { ...link(mission.mission_id, "org/repo#2", "issue"), target: "issue:ghe.example.com/org/repo#2" };
    assert.equal("links" in build(mission, [bad, ghes]), false);
  });

  it("a v3 snapshot file written before this change still parses and merges unchanged", () => {
    const legacy = JSON.parse(readFileSync(LEGACY, "utf8")) as MissionSnapshotFile;
    assert.equal(legacy.contractVersion, 3);
    for (const m of legacy.missions) {
      assert.equal("created_at" in m, false);
      assert.equal("links" in m, false);
      assert.ok(m.id && m.title && m.canonicalState);
    }
    const merged = mergeSnapshotFiles(legacy, legacy, { ownerPid: 1, publishedAtMs: 1 });
    assert.equal(merged.missions.length, legacy.missions.length);
  });
});
