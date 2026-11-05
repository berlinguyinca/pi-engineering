import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { GithubLinkStore } from "../../src/github/discovery.ts";
import type { SteeringItem } from "../../src/orchestration/steering.ts";
import {
  type ForkRuntimeSources,
  type WorkScopeFacts,
  createForkRuntime,
  missionForkSources,
  workForkSources,
} from "../../src/runtime/herdr/forkWiring.ts";
import type { WorkGraph } from "../../src/work/types.ts";

// Characterization of how createForkRuntime resolves a steering node to a fork origin. Written against the
// Mission-backed sources first and kept as the contract the neutral-source refactor must not change.

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
const tmp = (): string => mkdtempSync(join(tmpdir(), "pi-fork-origin-"));

function mkRepo(): { root: string; base: string } {
  const root = join(tmp(), "repo");
  mkdirSync(root);
  sh(root, "init", "-b", "main");
  sh(root, "config", "user.email", "t@example.invalid");
  sh(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "one\n");
  sh(root, "add", ".");
  sh(root, "commit", "-m", "base");
  return { root, base: sh(root, "rev-parse", "HEAD") };
}

const links: GithubLinkStore = {
  recordGithubLink: (r: object) => ({ ...r, epoch: 0 }) as never,
  suggestGithubLink: () => undefined,
  resolveGithubSuggestion: () => false,
  getGithubSuggestion: () => undefined,
  listGithubLinks: () => [],
} as unknown as GithubLinkStore;

const item = (nodeId: string, base: string, id = "st-1"): SteeringItem => ({
  steeringId: id,
  action: "fork",
  nodeId,
  params: { baseSha: base },
  instruction: null,
  proposedBy: "bob",
  confirmedBy: "alice",
  room: "room-a",
  validUntilEpoch: 9_999_999_999,
  fence: "f",
  expectedDigest: null,
});

type Rec = { missionId: string; taskId: string; repoRoot: string; baseBranch: string; approachId: string };

async function boot(sources: ForkRuntimeSources) {
  const agentDir = tmp();
  const stateDir = tmp();
  writeFileSync(join(agentDir, "engineering.yaml"), "forks:\n  enabled: true\n  min_free_mb: 1\n");
  const rt = await createForkRuntime({ agentDir, stateDir, sources, lineage: null });
  assert.ok(rt);
  const records = (): Rec[] =>
    Object.values(
      (JSON.parse(readFileSync(join(stateDir, "forks.json"), "utf8")) as { records: Record<string, Rec> }).records,
    );
  return { rt, records };
}

describe("fork origin resolution (Mission-backed sources)", () => {
  type Legacy = {
    getTask: (id: string) => { task_id: string; mission_id: string; repo_id?: string } | undefined;
    getExecution: (id: string) => { task_id: string } | undefined;
    getMission: (id: string) => { mission_id: string; repository: string; base_ref: string } | undefined;
  } & Pick<ForkRuntimeSources, "boundRoot" | "openRoot">;
  const mk = (r: { root: string }, over: Partial<Legacy> = {}): ForkRuntimeSources => {
    const l: Legacy = {
      getTask: (id) => (id === "t1" ? { task_id: "t1", mission_id: "m1", repo_id: "r1" } : undefined),
      getExecution: (id) => (id === "e1" ? { task_id: "t1" } : undefined),
      getMission: (id) => (id === "m1" ? { mission_id: "m1", repository: r.root, base_ref: "main" } : undefined),
      boundRoot: () => null,
      openRoot: async (p) => p,
      ...over,
    };
    return missionForkSources(l, { boundRoot: l.boundRoot, openRoot: l.openRoot, links });
  };

  it("task:, agent: and attempt: nodes resolve to the same origin and the fork record carries mission, task, root and base", async () => {
    const r = mkRepo();
    const { rt, records } = await boot(mk(r));
    try {
      for (const [i, node] of ["task:t1", "agent:t1", "attempt:e1"].entries()) {
        assert.equal(await rt.port.knows(item(node, r.base)), true, node);
        const a = await rt.port.apply(item(node, r.base, `st-${i}`));
        assert.equal(a.outcome, "applied", a.note);
      }
      const recs = records();
      assert.equal(recs.length, 3);
      for (const rec of recs) {
        assert.equal(rec.missionId, "m1");
        assert.equal(rec.taskId, "t1");
        assert.equal(rec.baseBranch, "main");
        assert.equal(rec.repoRoot, r.root);
      }
    } finally {
      rt.stop();
    }
  });

  it("an unknown task, unknown execution or malformed node is not known; an unknown kind is not known", async () => {
    const r = mkRepo();
    const { rt } = await boot(mk(r));
    try {
      for (const node of ["task:nope", "attempt:nope", "weird", "commit:abc"])
        assert.equal(await rt.port.knows(item(node, r.base)), false, node);
      const a = await rt.port.apply(item("task:nope", r.base));
      assert.equal(a.outcome, "stale");
      assert.match(a.note, /origin is no longer known here/);
    } finally {
      rt.stop();
    }
  });

  it("a task whose mission is gone is known but unresolvable", async () => {
    const r = mkRepo();
    const { rt } = await boot(mk(r, { getMission: () => undefined }));
    try {
      assert.equal(await rt.port.knows(item("task:t1", r.base)), true);
      const a = await rt.port.apply(item("task:t1", r.base));
      assert.equal(a.outcome, "refused");
      assert.match(a.note, /mission is not known on this host/);
    } finally {
      rt.stop();
    }
  });

  it("the bound repository root wins over the mission path; a throwing binding falls back to the mission path", async () => {
    const bound = mkRepo();
    const mission = mkRepo();
    const a = await boot(mk(mission, { boundRoot: () => bound.root }));
    try {
      assert.equal((await a.rt.port.apply(item("task:t1", bound.base))).outcome, "applied");
      assert.equal(a.records()[0]?.repoRoot, bound.root);
    } finally {
      a.rt.stop();
    }
    const b = await boot(
      mk(mission, {
        boundRoot: () => {
          throw new Error("no manifest");
        },
      }),
    );
    try {
      assert.equal((await b.rt.port.apply(item("task:t1", mission.base))).outcome, "applied");
      assert.equal(b.records()[0]?.repoRoot, mission.root);
    } finally {
      b.rt.stop();
    }
  });

  it("with no binding, a relative mission repository is never opened and openRoot is not asked", async () => {
    const r = mkRepo();
    let opened = 0;
    const { rt } = await boot(
      mk(r, {
        getMission: () => ({ mission_id: "m1", repository: "relative/repo", base_ref: "main" }),
        openRoot: async (p) => {
          opened++;
          return p;
        },
      }),
    );
    try {
      const a = await rt.port.apply(item("task:t1", r.base));
      assert.equal(a.outcome, "refused");
      assert.match(a.note, /repository of that mission is not available/);
      assert.equal(opened, 0);
    } finally {
      rt.stop();
    }
  });

  it("a hostile base ref is refused before any repository is touched", async () => {
    const r = mkRepo();
    const { rt } = await boot(
      mk(r, { getMission: () => ({ mission_id: "m1", repository: r.root, base_ref: "--upload-pack=x" }) }),
    );
    try {
      const a = await rt.port.apply(item("task:t1", r.base));
      assert.equal(a.outcome, "refused");
      assert.match(a.note, /plain branch name/);
    } finally {
      rt.stop();
    }
  });

  it("an approach: node resolves through the fork registry (its recorded root), and refuses when its task is gone", async () => {
    const r = mkRepo();
    let taskKnown = true;
    const { rt, records } = await boot(
      mk(r, { getTask: (id) => (taskKnown && id === "t1" ? { task_id: "t1", mission_id: "m1" } : undefined) }),
    );
    try {
      assert.equal((await rt.port.apply(item("task:t1", r.base))).outcome, "applied");
      const first = records()[0] as Rec;
      const node = `approach:${first.approachId}`;
      assert.equal(await rt.port.knows(item(node, r.base)), true);
      assert.equal((await rt.port.apply(item(node, r.base, "st-2"))).outcome, "applied");
      assert.equal(records().length, 2);
      assert.equal(await rt.port.knows(item("approach:fk-0000000000000000", r.base)), false);
      taskKnown = false;
      const gone = await rt.port.apply(item(node, r.base, "st-3"));
      assert.equal(gone.outcome, "refused");
      assert.match(gone.note, /mission of that approach is no longer known here/);
    } finally {
      rt.stop();
    }
  });
});

describe("fork origin resolution (Mission-less work read model)", () => {
  const graph = (): Pick<WorkGraph, "tasks" | "runs" | "sessions"> => ({
    tasks: [
      {
        id: "w1",
        source: "ledger",
        title: "root",
        state: "working",
        raw_status: "working",
        verification_status: "pending",
        parent_id: null,
        created_at: null,
        updated_at: null,
        run_ids: ["e1"],
        session_ids: ["s1"],
      },
      {
        id: "w1.a",
        source: "ledger",
        title: "child",
        state: "working",
        raw_status: "working",
        verification_status: "pending",
        parent_id: "w1",
        created_at: null,
        updated_at: null,
        run_ids: [],
        session_ids: [],
      },
    ],
    runs: [
      {
        id: "e1",
        task_id: "w1.a",
        source: "ledger",
        session_id: "s1",
        health: "active",
        outcome: null,
        model: null,
        worktree: null,
        started_at: null,
        ended_at: null,
      },
    ],
    sessions: [{ id: "s1", source: "ledger", task_ids: ["w1.a", "w1"], run_ids: ["e1"] }],
  });
  const mk = (r: { root: string }, scope: WorkScopeFacts | undefined) =>
    workForkSources(graph, (id) => (id === "w1" ? scope : undefined), {
      boundRoot: () => null,
      openRoot: async (p) => p,
      links,
    });

  it("task, run and session identities fork from a session with no Mission, recording the root work id", async () => {
    const r = mkRepo();
    const { rt, records } = await boot(mk(r, { repository: r.root, base_ref: "main" }));
    try {
      for (const [i, node] of ["task:w1.a", "attempt:e1", "agent:s1", "task:w1"].entries()) {
        assert.equal(await rt.port.knows(item(node, r.base)), true, node);
        const a = await rt.port.apply(item(node, r.base, `st-${i}`));
        assert.equal(a.outcome, "applied", a.note);
      }
      const recs = records();
      assert.equal(recs.length, 4);
      for (const rec of recs) {
        assert.equal(rec.missionId, "w1");
        assert.equal(rec.baseBranch, "main");
        assert.equal(rec.repoRoot, r.root);
      }
      assert.deepEqual(recs.map((x) => x.taskId).sort(), ["w1", "w1.a", "w1.a", "w1.a"]);
      assert.equal(await rt.port.knows(item("task:nope", r.base)), false);
    } finally {
      rt.stop();
    }
  });

  it("a root work task with no known scope is known but unresolvable, and a bound repo id wins over the path", async () => {
    const r = mkRepo();
    const none = await boot(mk(r, undefined));
    try {
      const a = await none.rt.port.apply(item("task:w1", r.base));
      assert.equal(a.outcome, "refused");
      assert.match(a.note, /not known on this host/);
    } finally {
      none.rt.stop();
    }
    const bound = mkRepo();
    const src = workForkSources(graph, () => ({ repository: "relative", base_ref: "main", repo_id: "r1" }), {
      boundRoot: (id) => (id === "r1" ? bound.root : null),
      openRoot: async (p) => p,
      links,
    });
    const b = await boot(src);
    try {
      assert.equal((await b.rt.port.apply(item("task:w1.a", bound.base))).outcome, "applied");
      assert.equal(b.records()[0]?.repoRoot, bound.root);
    } finally {
      b.rt.stop();
    }
  });
});
