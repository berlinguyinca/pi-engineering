import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ListedWorktree,
  type OrphanClassification,
  type OrphanDecision,
  TERMINAL_MISSION_STATUSES,
  classifyWorktrees,
} from "../../src/git/worktreeOrphans.ts";
import type { MissionStatus } from "../../src/orchestration/types.ts";
import type { ResourceRecord } from "../../src/resources/ResourceRegistry.ts";
import type { LeaseRecord } from "../../src/runtime/isolation/LeaseManager.ts";

const CANDIDATE_BRANCH = "pi-eng-candidate-MSN-Z52ywV-repo-6f5f0bd085f1706c-1-0-EXC-fbX97S";
const ORCH_BRANCH = "pi-eng-orch-TSK-abc123";

const PATH_CANDIDATE = "/worktrees/candidate-a";
const PATH_ORCH = "/worktrees/orch-b";
const PATH_UNRELATED = "/worktrees/unrelated";

function worktree(path: string, branch: string | null, head: string | null = null): ListedWorktree {
  return { path, branch, head };
}

function registryRecord(overrides: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    schemaVersion: 1,
    id: "res-1",
    kind: "worktree",
    ownerMissionId: "MSN-Z52ywV",
    ownerExecutionId: "EXC-fbX97S",
    hostId: "host-1",
    locator: PATH_CANDIDATE,
    createdAt: "2024-01-01T00:00:00.000Z",
    lease: "lease-1",
    state: "active",
    ...overrides,
  };
}

function leaseRecord(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    resourceId: "mission:MSN-Z52ywV",
    sessionId: "session-1",
    pid: 1234,
    host: "host-1",
    bootId: null,
    processStartTime: null,
    generationId: "gen-1",
    acquiredAtMs: 1_000,
    heartbeatAtMs: 1_000,
    expiresAtMs: 10_000,
    ...overrides,
  };
}

const NOW_MS = 5_000;

/** Assert a single classification and return it (satisfies noUncheckedIndexedAccess). */
function single(result: OrphanClassification[]): OrphanClassification {
  assert.equal(result.length, 1);
  return result[0]!;
}

function classification(
  worktrees: readonly ListedWorktree[],
  overrides: {
    registry?: readonly ResourceRecord[];
    leases?: readonly LeaseRecord[];
    missionStatuses?: Readonly<Record<string, MissionStatus | string>>;
    durablyReferenced?: ReadonlySet<string>;
    nowMs?: number;
  } = {},
): OrphanClassification[] {
  return classifyWorktrees({
    worktrees,
    registry: overrides.registry ?? [],
    leases: overrides.leases ?? [],
    missionStatuses: overrides.missionStatuses ?? {},
    durablyReferenced: overrides.durablyReferenced,
    nowMs: overrides.nowMs ?? NOW_MS,
  });
}

test("rule 1: a durably referenced path is kept as durable_reference", () => {
  const wt = worktree(PATH_CANDIDATE, CANDIDATE_BRANCH);
  const result = single(
    classification([wt], {
      missionStatuses: { "MSN-Z52ywV": "FAILED" },
      durablyReferenced: new Set([PATH_CANDIDATE]),
    }),
  );
  assert.equal(result.decision, "keep");
  assert.equal(result.reason, "durable_reference");
  assert.equal(result.path, PATH_CANDIDATE);
  assert.equal(result.branch, CANDIDATE_BRANCH);
});

test("rule 2: a live lease on mission:<id> is kept as lease_live", () => {
  const wt = worktree(PATH_CANDIDATE, CANDIDATE_BRANCH);
  const result = single(
    classification([wt], {
      leases: [leaseRecord()],
      missionStatuses: { "MSN-Z52ywV": "FAILED" },
    }),
  );
  assert.equal(result.decision, "keep");
  assert.equal(result.reason, "lease_live");
});

test("rule 3: a known non-terminal mission is kept as mission_live", () => {
  const wt = worktree(PATH_CANDIDATE, CANDIDATE_BRANCH);
  const result = single(
    classification([wt], {
      missionStatuses: { "MSN-Z52ywV": "EXECUTING" },
    }),
  );
  assert.equal(result.decision, "keep");
  assert.equal(result.reason, "mission_live");
});

test("rule 4: an active registry record whose owner is non-terminal is kept as registry_active", () => {
  // Branch-derived mission is terminal, but the registry record's owner is a
  // different, still-live mission -> rule 3 does not match, rule 4 does.
  const wt = worktree(PATH_CANDIDATE, CANDIDATE_BRANCH);
  const result = single(
    classification([wt], {
      registry: [registryRecord({ ownerMissionId: "MSN-other", state: "active" })],
      missionStatuses: { "MSN-Z52ywV": "COMPLETE", "MSN-other": "EXECUTING" },
    }),
  );
  assert.equal(result.decision, "keep");
  assert.equal(result.reason, "registry_active");
});

test("rule 4: an active registry record whose owner is unknown counts as not terminal", () => {
  const wt = worktree(PATH_UNRELATED, "feature/x");
  const result = single(
    classification([wt], {
      registry: [
        registryRecord({
          ownerMissionId: "MSN-unknown",
          locator: PATH_UNRELATED,
          state: "active",
        }),
      ],
      missionStatuses: {},
    }),
  );
  assert.equal(result.decision, "keep");
  assert.equal(result.reason, "registry_active");
});

test("rule 5: a known mission with no recorded status is kept as owner_unknown", () => {
  const wt = worktree(PATH_CANDIDATE, CANDIDATE_BRANCH);
  const result = single(
    classification([wt], {
      missionStatuses: {},
    }),
  );
  assert.equal(result.decision, "keep");
  assert.equal(result.reason, "owner_unknown");
});

test("rule 6: a known terminal mission with no live lease is adopted as owner_terminal", () => {
  const wt = worktree(PATH_CANDIDATE, CANDIDATE_BRANCH);
  const result = single(
    classification([wt], {
      missionStatuses: { "MSN-Z52ywV": "COMPLETE" },
    }),
  );
  assert.equal(result.decision, "adopt");
  assert.equal(result.reason, "owner_terminal");
});

test("rule 7: no mission and no registry record is quarantined as unowned", () => {
  const wt = worktree(PATH_UNRELATED, "feature/unrelated");
  const result = single(classification([wt]));
  assert.equal(result.decision, "quarantine");
  assert.equal(result.reason, "unowned");
  assert.equal(result.missionId, null);
});

test("output order equals input order", () => {
  const wts = [
    worktree(PATH_UNRELATED, "feature/unrelated"),
    worktree(PATH_CANDIDATE, CANDIDATE_BRANCH),
    worktree(PATH_ORCH, ORCH_BRANCH),
  ];
  const result = classification(wts, {
    missionStatuses: { "MSN-Z52ywV": "COMPLETE" },
  });
  assert.deepEqual(
    result.map((c) => c.path),
    [PATH_UNRELATED, PATH_CANDIDATE, PATH_ORCH],
  );
});

test("empty input returns an empty array and never throws", () => {
  assert.deepEqual(classification([]), []);
});

test("an expired lease (nowMs > expiresAtMs) falls through to rule 6", () => {
  const wt = worktree(PATH_CANDIDATE, CANDIDATE_BRANCH);
  const result = single(
    classification([wt], {
      leases: [leaseRecord({ expiresAtMs: 1_000 })], // expires before NOW_MS = 5_000
      missionStatuses: { "MSN-Z52ywV": "CANCELED" },
    }),
  );
  assert.equal(result.decision, "adopt");
  assert.equal(result.reason, "owner_terminal");
});

test("inputs are not mutated", () => {
  const wt = worktree(PATH_CANDIDATE, CANDIDATE_BRANCH);
  const wts = [wt];
  const registry = [registryRecord()];
  const leases = [leaseRecord()];
  const missionStatuses: Record<string, MissionStatus> = { "MSN-Z52ywV": "EXECUTING" };
  const durable = new Set([PATH_CANDIDATE]);
  const snapshot = {
    wts: JSON.stringify(wts),
    registry: JSON.stringify(registry),
    leases: JSON.stringify(leases),
    missionStatuses: JSON.stringify(missionStatuses),
    durable: [...durable],
  };
  const result = classification(wts, {
    registry,
    leases,
    missionStatuses,
    durablyReferenced: durable,
  });
  assert.ok(result.length >= 1);
  assert.equal(JSON.stringify(wts), snapshot.wts);
  assert.equal(JSON.stringify(registry), snapshot.registry);
  assert.equal(JSON.stringify(leases), snapshot.leases);
  assert.equal(JSON.stringify(missionStatuses), snapshot.missionStatuses);
  assert.deepEqual([...durable], snapshot.durable);
});

test("missionId is resolved from a registry record when the branch has none", () => {
  const wt = worktree(PATH_UNRELATED, "feature/unrelated");
  const result = single(
    classification([wt], {
      registry: [registryRecord({ ownerMissionId: "MSN-reg", locator: PATH_UNRELATED })],
      missionStatuses: { "MSN-reg": "EXECUTING" },
    }),
  );
  assert.equal(result.missionId, "MSN-reg");
  assert.equal(result.decision, "keep");
  assert.equal(result.reason, "mission_live");
});

test("a COMPLETE mission holding a live ns#mission:MSN-1 lease is kept as lease_live", () => {
  const wt = worktree("/worktrees/ns-lease", "pi-eng-candidate-MSN-1-repo-x-0-EXC-x");
  const result = single(
    classification([wt], {
      leases: [leaseRecord({ resourceId: "ns#mission:MSN-1" })],
      missionStatuses: { "MSN-1": "COMPLETE" },
    }),
  );
  assert.equal(result.decision, "keep");
  assert.equal(result.reason, "lease_live");
  assert.equal(result.missionId, "MSN-1");
});

test("a detached worktree (branch null) with no registry record is quarantined as unowned", () => {
  const wt = worktree(PATH_UNRELATED, null, "abc123def");
  const result = single(classification([wt]));
  assert.equal(result.decision, "quarantine");
  assert.equal(result.reason, "unowned");
  assert.equal(result.missionId, null);
  assert.equal(result.branch, null);
});

test("ListedWorktree literals including head compile", () => {
  const literals: ListedWorktree[] = [
    { path: "/worktrees/a", branch: "main", head: "abc123" },
    { path: "/worktrees/b", branch: null, head: null },
  ];
  const result = classification(literals, {});
  assert.equal(result.length, 2);
  assert.equal(result[0]!.path, "/worktrees/a");
  assert.equal(result[1]!.path, "/worktrees/b");
  assert.equal(result[0]!.branch, "main");
  assert.equal(result[1]!.branch, null);
});

test("TERMINAL_MISSION_STATUSES is the documented set", () => {
  assert.deepEqual([...TERMINAL_MISSION_STATUSES].sort(), ["CANCELED", "COMPLETE", "FAILED"]);
});
