import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTO_INVOKE_MIN_CONFIDENCE,
  decideAutoInvoke,
  missionToolReportedUnavailable,
} from "../../src/orchestration/autoInvoke.ts";

const base = { mode: "tui" as const, missionToolUnavailable: false, lastAutoInvoked: null, now: 1_000_000 };

describe("mission auto-invoke decision (session review)", () => {
  it("injects the directive for a genuine engineering request", () => {
    const d = decideAutoInvoke({ ...base, prompt: "Add a health endpoint to the API server" });
    assert.equal(d.invoke, true, d.reason);
    assert.ok(d.confidence >= AUTO_INVOKE_MIN_CONFIDENCE);
  });

  for (const prompt of ["retry", "Continue", "continue.", "try again", "go on", "keep going", "ok", "yes", "proceed"]) {
    it(`skips a bare retry/continue prompt: ${JSON.stringify(prompt)}`, () => {
      assert.equal(decideAutoInvoke({ ...base, prompt }).invoke, false);
    });
  }

  it("skips prompts that end in a question mark", () => {
    const d = decideAutoInvoke({ ...base, prompt: "Should we add a retry budget to the fix for the gateway error?" });
    assert.equal(d.invoke, false);
    assert.match(d.reason, /question/);
  });

  it("skips short chat-like prompts", () => {
    for (const prompt of ["fix it", "thanks, add that", "hi there"]) {
      assert.equal(decideAutoInvoke({ ...base, prompt }).invoke, false, prompt);
    }
  });

  it("skips in --print mode", () => {
    const d = decideAutoInvoke({ ...base, mode: "print", prompt: "Add a health endpoint to the API server" });
    assert.equal(d.invoke, false);
    assert.match(d.reason, /print/);
  });

  it("skips once the mission tool reported unavailable/not initialized in this session", () => {
    const d = decideAutoInvoke({
      ...base,
      missionToolUnavailable: true,
      prompt: "Add a health endpoint to the API server",
    });
    assert.equal(d.invoke, false);
    assert.match(d.reason, /unavailable/);
  });

  it("skips below the confidence threshold", () => {
    const d = decideAutoInvoke({
      ...base,
      prompt: "Add a health endpoint to the API server",
      minConfidence: 0.95,
    });
    assert.equal(d.invoke, false);
    assert.match(d.reason, /confidence/);
  });

  it("skips slash commands, conversation, and immediate re-submits of the same prompt", () => {
    assert.equal(decideAutoInvoke({ ...base, prompt: "/mission status" }).invoke, false);
    assert.equal(decideAutoInvoke({ ...base, prompt: "Explain what the scheduler module does today" }).invoke, false);
    const prompt = "Add a health endpoint to the API server";
    assert.equal(
      decideAutoInvoke({ ...base, prompt, lastAutoInvoked: { prompt, at: base.now - 5_000 } }).invoke,
      false,
    );
  });
});

describe("mission auto-invoke keeps review requests", () => {
  it("still injects for an explicit code review request", () => {
    assert.equal(decideAutoInvoke({ ...base, prompt: "Review the changes on this branch for bugs" }).invoke, true);
  });
});

describe("missionToolReportedUnavailable (PR #106 review)", () => {
  it("matches only the mission tool's own not-initialized message", () => {
    assert.equal(missionToolReportedUnavailable("Orchestrator not initialized for this directory."), true);
    assert.equal(
      missionToolReportedUnavailable("Orchestrator not initialized for this directory: ledger locked by pid 42"),
      true,
    );
    assert.equal(missionToolReportedUnavailable("Engineering runtime not initialized for this directory."), true);
  });

  for (const report of [
    "Mission MSN-1 BLOCKED: current validation evidence is unavailable",
    "Stop reason: the reviewer model is unavailable; retry later",
    "Mission MSN-2 completed. Note: the cache was not initialized before the first run.",
  ]) {
    it(`does not treat an ordinary mission report as unavailability: ${JSON.stringify(report)}`, () => {
      assert.equal(missionToolReportedUnavailable(report), false);
    });
  }
});
