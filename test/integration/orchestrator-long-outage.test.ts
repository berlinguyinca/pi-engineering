/**
 * A mission whose gateway stays down past the retry horizon PAUSES (never
 * fails) and, once the recovery probe reports healthy again, resumes on its own
 * and completes — all inside one orchestrate() call, on a fake clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrokerBackends } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { DEFAULT_GATEWAY_RESILIENCE } from "../../src/resilience/config.ts";

const HOUR = 3_600_000;

function run(outageMs: number) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  let now = 0;
  const statuses: string[] = [];
  const down = () => now < outageMs;
  const ok = { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
  const backends: BrokerBackends = {
    agent: {
      runAgent: async () =>
        down()
          ? {
              executionId: "e",
              exitStatus: "failed",
              summary: "capacity_unavailable",
              artifactRefs: [],
              usage: {},
              error: "transient:server_unavailable",
            }
          : ok,
    },
    validation: { runValidation: async () => ok },
    review: { runReview: async () => ({ ...ok, findings: [] }) },
  };
  const orchestrator = new Orchestrator({
    store,
    backends,
    planner: async () => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "implement",
        mutates_repo: true,
        write_domains: ["src/**"],
        isolation: "worktree" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: {},
        max_attempts: 3,
        failure_policy: "retry" as const,
      },
    ],
    resilience: DEFAULT_GATEWAY_RESILIENCE,
    probe: {
      probe: async () => {
        statuses.push(store.listMissions()[0]?.status ?? "");
        return { healthy: !down() };
      },
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    rand: () => 0,
  });
  return { orchestrator, store, clock: () => now, statuses };
}

describe("orchestrator: an outage longer than the retry horizon", () => {
  it("pauses past the 12h horizon and auto-resumes to completion when the probe recovers (13h outage)", async () => {
    const h = run(13 * HOUR);
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(result.completed, true, JSON.stringify(result.verdict.reasons));
    assert.equal(result.paused, undefined);
    assert.equal(h.store.getMission(result.mission.mission_id)!.status, "COMPLETE");
    assert.ok(h.clock() >= 13 * HOUR);
    // It really paused on the way, and the probe is what brought it back.
    assert.ok(h.statuses.includes("PAUSED_INFRASTRUCTURE"), "probed while paused");
  });

  it("stays paused (never failed) when the gateway is still down after the auto-resume horizon", async () => {
    const h = run(100 * HOUR);
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(result.paused, true);
    assert.equal(h.store.getMission(result.mission.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
  });
});

describe("orchestrator: cancelling an auto-resume wait", () => {
  it("an aborted orchestration returns the mission PAUSED instead of watching the probe for hours", async () => {
    const h = run(100 * HOUR);
    const controller = new AbortController();
    const pending = h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
      signal: controller.signal,
    });
    // Abort as soon as the mission pauses (fake clock: past the 12h window).
    const timer = setInterval(() => {
      if (h.clock() >= 12 * HOUR) controller.abort();
    }, 0);
    const result = await pending;
    clearInterval(timer);
    assert.equal(result.paused, true);
    assert.ok(h.clock() < 36 * HOUR, `stopped at ${h.clock()}ms`);
  });
});
