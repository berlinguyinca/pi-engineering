/**
 * A drop decision completes only with a clean reference sweep (issue #510).
 *
 * `ledger claim add --kind decision --claim "drop \`room join\`, it duplicates
 * \`herdr join\`"` used to be accepted with no `references` evidence, and the
 * completion gate never asked, so a mission could finish while a CLI label and
 * `docs/cli.md` still told users to run the command being removed. The gate now
 * reads the recorded sweep and blocks while its hits sit in text a user reads or
 * types.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Evidence } from "../../src/core/types.ts";
import { CompletionGate } from "../../src/orchestration/completionGate.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import {
  type SweepRecord,
  droppedIdentifier,
  referenceSweepBlockers,
  userFacingHits,
} from "../../src/orchestration/referenceSweep.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const DECISION = "drop `room join`, it duplicates `herdr join`";

function sweep(artifact: string, summary: Record<string, unknown> = {}): Evidence {
  return {
    id: "EV-1",
    candidate_id: null,
    type: "references",
    tool: "grep",
    command: "grep -rn 'room join' src docs",
    started_at: "2026-11-05T00:00:00.000Z",
    finished_at: "2026-11-05T00:00:01.000Z",
    exit_code: 0,
    status: "passed",
    summary,
    artifacts: [artifact],
    trust: "observed",
  };
}

function record(statement: string, evidence: Evidence[], files: Record<string, string[]>): SweepRecord {
  return { statement, evidence, readArtifact: (artifact) => files[artifact] ?? null };
}

const ARTIFACT = "artifacts/room-join-sweep.txt";

describe("the identifier a drop decision names", () => {
  it("is the thing being removed, not the thing that survives", () => {
    assert.equal(droppedIdentifier(DECISION), "room join");
    assert.equal(droppedIdentifier("rename `legacyFlag` to `featureFlag`"), "legacyFlag");
    assert.equal(droppedIdentifier("remove docs/legacy-install.md"), "docs/legacy-install.md");
  });

  it("is absent when the decision names nothing code-shaped", () => {
    assert.equal(droppedIdentifier("add a health endpoint"), null);
    assert.equal(droppedIdentifier('drop the "keep going until done" behavior'), null);
    assert.equal(droppedIdentifier("add a /health endpoint"), null); // no drop verb
  });
});

describe("reference sweep blockers", () => {
  it("blocks when no references evidence is attached", () => {
    assert.deepEqual(referenceSweepBlockers(record(DECISION, [], {})), [
      'decision drops "room join" with no reference sweep: attach one (type=references, a grep artifact over the repo and its hit count) before completing',
    ]);
  });

  it("blocks while a hit lies inside a string literal, naming file and line", () => {
    const blockers = referenceSweepBlockers(
      record(DECISION, [sweep(ARTIFACT)], {
        [ARTIFACT]: ["src/cli/roomCli.ts:12:register(roomJoin);", 'src/cli/roomCli.ts:56:  const label = "room join";'],
      }),
    );
    assert.equal(blockers.length, 1);
    assert.match(blockers[0]!, /user-facing text still names it/);
    assert.match(blockers[0]!, /src\/cli\/roomCli\.ts:56 \(string literal\)/);
    assert.doesNotMatch(blockers[0]!, /roomCli\.ts:12/, "the plain-code hit does not block");
  });

  it("passes a sweep whose only hits are plain code or comments", () => {
    assert.deepEqual(
      referenceSweepBlockers(
        record(DECISION, [sweep(ARTIFACT, { hits: 1 })], {
          [ARTIFACT]: [
            "src/cli/roomCli.ts:12:register(roomJoin);",
            "src/cli/roomCli.ts:30:// room join moved to herdr",
          ],
        }),
      ),
      [],
    );
  });

  it("blocks a document that still tells users the command, and a template value", () => {
    const blockers = referenceSweepBlockers(
      record(DECISION, [sweep(ARTIFACT)], {
        [ARTIFACT]: [
          "docs/cli.md:12:Run `pi-engineering room join` to enter a room.",
          "templates/help.hbs:4:room join",
        ],
      }),
    );
    assert.match(blockers[0]!, /docs\/cli\.md:12 \(document\)/);
    assert.match(blockers[0]!, /templates\/help\.hbs:4 \(document\)/);
  });

  it("blocks when the record's own hit count disagrees with its artifact", () => {
    const blockers = referenceSweepBlockers(
      record(DECISION, [sweep(ARTIFACT, { hits: 0 })], {
        [ARTIFACT]: ['src/cli/roomCli.ts:56:  const label = "room join";'],
      }),
    );
    assert.ok(
      blockers.some((b) => /lists 1 hit\(s\) for "room join", the record claims 0/.test(b)),
      blockers.join("\n"),
    );
  });

  it("blocks when the sweep artifact cannot be read", () => {
    const blockers = referenceSweepBlockers(record(DECISION, [sweep(ARTIFACT)], {}));
    assert.deepEqual(blockers, [`reference sweep artifact ${ARTIFACT} for "room join" cannot be read`]);
  });

  it("is satisfied by any one clean sweep, even when another still shows a hit", () => {
    assert.deepEqual(
      referenceSweepBlockers(
        record(DECISION, [sweep("artifacts/stale.txt", { hits: 1 }), sweep("artifacts/final.txt", { hits: 0 })], {
          "artifacts/stale.txt": ['src/cli/roomCli.ts:56:  const label = "room join";'],
          "artifacts/final.txt": ["src/cli/roomCli.ts:12:register(roomJoin);"],
        }),
      ),
      [],
    );
  });

  it("leaves a decision that drops nothing alone", () => {
    assert.deepEqual(referenceSweepBlockers(record("add a health endpoint", [], {})), []);
  });

  it("classifies a hit inside a single-quoted string and one after a comment marker", () => {
    assert.deepEqual(
      userFacingHits(["web/nav.ts:9:  link(\"home\", 'room join'); // room join is the old name"], "room join"),
      [{ path: "web/nav.ts", line: 9, kind: "string literal" }],
    );
    assert.deepEqual(userFacingHits(["web/nav.ts:9:// room join is the old name"], "room join"), []);
  });
});

function mission() {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const m = store.createMission({
    title: "drop room join",
    goal: DECISION,
    user_request: DECISION,
    repository: ".",
    base_ref: "",
    risk_profile: "medium" as never,
    workflow_class: "engineering_review" as never,
  });
  store.updateMission(m.mission_id, { required_gates: [] as never[] });
  return { store, m };
}

describe("the completion gate asks for the sweep", () => {
  it("blocks while user-facing text still names the dropped identifier", () => {
    const { store, m } = mission();
    const files = { [ARTIFACT]: ['src/cli/roomCli.ts:56:  const label = "room join";'] };
    const swept = new CompletionGate(store, undefined, undefined, () => [
      record(DECISION, [sweep(ARTIFACT, { hits: 1 })], files),
    ]);
    const verdict = swept.evaluate(store.getMission(m.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.ok(
      verdict.reasons.some((r) => /room join/.test(r) && /roomCli\.ts:56 \(string literal\)/.test(r)),
      verdict.reasons.join("\n"),
    );
  });

  it("adds nothing when no sweep provider is wired (every standalone run)", () => {
    const { store, m } = mission();
    const plain = new CompletionGate(store);
    const verdict = plain.evaluate(store.getMission(m.mission_id)!);
    assert.ok(!verdict.reasons.some((r) => /room join/.test(r)), verdict.reasons.join("\n"));
  });

  it("completes when the sweep is clean", () => {
    const { store, m } = mission();
    const files = { [ARTIFACT]: ["src/cli/roomCli.ts:12:register(roomJoin);"] };
    const swept = new CompletionGate(store, undefined, undefined, () => [
      record(DECISION, [sweep(ARTIFACT, { hits: 1 })], files),
    ]);
    const verdict = swept.evaluate(store.getMission(m.mission_id)!);
    assert.ok(!verdict.reasons.some((r) => /room join/.test(r)), verdict.reasons.join("\n"));
    assert.equal(verdict.can_complete, true);
  });

  it("treats a sweep provider that throws as a blocker, not a crash", () => {
    const { store, m } = mission();
    const broken = new CompletionGate(store, undefined, undefined, () => {
      throw new Error("ledger unreadable");
    });
    const verdict = broken.evaluate(store.getMission(m.mission_id)!);
    assert.equal(verdict.can_complete, false);
    assert.ok(
      verdict.reasons.includes("reference sweep evidence failed: ledger unreadable"),
      verdict.reasons.join("\n"),
    );
  });
});
