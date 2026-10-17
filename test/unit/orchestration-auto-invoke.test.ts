import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTO_INVOKE_MIN_CONFIDENCE,
  AUTO_INVOKE_MIN_WORDS,
  MISSION_UNAVAILABLE_RETRY_TURNS,
  decideAutoInvoke,
  isBareContinuation,
  missionToolReportedUnavailable,
} from "../../src/orchestration/autoInvoke.ts";

const base = { mode: "tui" as const, missionToolUnavailable: false, lastAutoInvoked: null, now: 1_000_000 };

describe("auto-invoke exported constants (spec 06)", () => {
  it("exposes the documented thresholds", () => {
    assert.equal(AUTO_INVOKE_MIN_CONFIDENCE, 0.6);
    assert.equal(AUTO_INVOKE_MIN_WORDS, 4);
    assert.equal(MISSION_UNAVAILABLE_RETRY_TURNS, 20);
  });
});

describe("isBareContinuation", () => {
  it("detects bare retry/continue nudges", () => {
    for (const p of ["retry", "Retry", "try again", "try again!", "continue", "continue.", "go on", "go ahead", "keep going", "carry on", "resume", "proceed", "next", "ok", "okay", "yes", "y", "yep", "sure", "do it", "done", "please retry"]) {
      assert.equal(isBareContinuation(p), true, p);
    }
  });

  it("does not treat a real mission request as a bare continuation", () => {
    for (const p of ["Add a health endpoint to the API server", "Fix the login bug", "review my changes", "retry the mission", "continue the migration plan"]) {
      assert.equal(isBareContinuation(p), false, p);
    }
  });
});

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

  it("injects with the decision shape and fields (workflow + confidence + reason)", () => {
    const d = decideAutoInvoke({ ...base, prompt: "Add a health endpoint to the API server" });
    assert.equal(d.invoke, true);
    assert.equal(typeof d.workflow, "string");
    assert.equal(typeof d.confidence, "number");
    assert.ok(d.confidence >= AUTO_INVOKE_MIN_CONFIDENCE);
    assert.equal(typeof d.reason, "string");
    assert.ok(d.reason.length > 0);
    // workflow is at/above engineering (auto-invoke rank), never conversation.
    const order = ["conversation", "research", "investigation", "engineering", "review", "engineering_review", "security_sensitive"];
    assert.ok(order.indexOf(d.workflow) >= order.indexOf("engineering"), d.workflow);
  });

  it("skips prompts below the default minimum word count", () => {
    const short = "Fix bug";
    assert.ok(short.split(/\s+/).filter(Boolean).length < AUTO_INVOKE_MIN_WORDS);
    const d = decideAutoInvoke({ ...base, prompt: short });
    assert.equal(d.invoke, false);
    assert.match(d.reason, /short|chat/);
  });

  it("skips slash commands, conversation, and immediate re-submits of the same prompt", () => {
    assert.equal(decideAutoInvoke({ ...base, prompt: "/mission status" }).invoke, false);
    assert.equal(decideAutoInvoke({ ...base, prompt: "Explain what the scheduler module does today" }).invoke, false);
    // conversation-classified prompt that is long enough must not invoke.
    assert.equal(decideAutoInvoke({ ...base, prompt: "Explain how the scheduler module distributes work across the worker pool" }).invoke, false);
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
