import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_WATCHDOG_CONFIG,
  type WatchdogState,
  classifyStall,
  heartbeat,
  isProcessAlive,
  recordLlmSuccess,
} from "../../src/resilience/watchdog.ts";

const CFG = DEFAULT_WATCHDOG_CONFIG;

function state(mission_state: string, lastHeartbeat: number): WatchdogState {
  return {
    last_heartbeat_at_ms: lastHeartbeat,
    last_llm_success_at_ms: lastHeartbeat,
    last_tool_progress_at_ms: lastHeartbeat,
    mission_state,
  };
}

describe("watchdog", () => {
  it("a mission in WAITING_FOR_LLM with healthy heartbeats is NOT hung", () => {
    const now = 100_000;
    const s = state("WAITING_FOR_LLM", now - 20_000); // heartbeats every 10s
    assert.ok(isProcessAlive(s, now, CFG));
    assert.equal(classifyStall(s, now, CFG), "none");
  });

  it("a PAUSED_INFRASTRUCTURE mission is not stalled", () => {
    const now = 100_000;
    const s = state("PAUSED_INFRASTRUCTURE", now - 20_000);
    assert.equal(classifyStall(s, now, CFG), "none");
  });

  it("a missing heartbeat means a hung process", () => {
    const now = 100_000;
    const s = state("WAITING_FOR_LLM", now - 1_000_000); // no heartbeat for 16min
    assert.ok(!isProcessAlive(s, now, CFG));
    assert.equal(classifyStall(s, now, CFG), "heartbeat_lost");
  });

  it("a RUNNING mission with stale LLM success is inference-stalled", () => {
    const now = 100_000;
    const s = { ...state("EXECUTING", now - 5_000), last_llm_success_at_ms: now - 6 * 60_000 };
    assert.equal(classifyStall(s, now, CFG), "inference_stalled");
  });

  it("a RUNNING mission with stale tool progress is tool-stalled", () => {
    const now = 100_000;
    const s = { ...state("EXECUTING", now - 5_000), last_tool_progress_at_ms: now - 11 * 60_000 };
    assert.equal(classifyStall(s, now, CFG), "tool_stalled");
  });

  it("heartbeat and llm success update the timestamps", () => {
    let s = state("EXECUTING", 0);
    s = heartbeat(s, 5_000);
    s = recordLlmSuccess(s, 8_000);
    assert.equal(s.last_heartbeat_at_ms, 5_000);
    assert.equal(s.last_llm_success_at_ms, 8_000);
  });
});
