import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityFromSessionEvent, sanitizeWorkerActivity } from "../../src/workers/activity.ts";
import { BuildCommandTimer, budgetExhaustedBuildHint, buildToolOf } from "../../src/workers/buildActivity.ts";

describe("worker build activity: labelling", () => {
  it("labels build commands without copying any of the command", () => {
    assert.equal(buildToolOf("cargo test -p iw-cli"), "cargo");
    assert.equal(buildToolOf("cd crates/iw && RUST_LOG=debug cargo build --release 2>&1 | tail -50"), "cargo");
    assert.equal(buildToolOf("timeout 600 cargo +nightly clippy --all-targets"), "cargo");
    assert.equal(buildToolOf("./gradlew test"), "gradle");
    assert.equal(buildToolOf("npm run build"), "npm");
    assert.equal(buildToolOf("cargo --version"), undefined);
    assert.equal(buildToolOf("git status && ls target"), undefined);
    assert.equal(buildToolOf("grep -rn cargo src"), undefined);
    assert.equal(buildToolOf(undefined), undefined);
  });

  it("a bash start event carries only the label; other tools and unknown labels carry none", () => {
    const activity = activityFromSessionEvent({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "c1",
      args: { command: "cargo test --secret-token=abc123" },
    });
    assert.equal(activity?.buildTool, "cargo");
    assert.doesNotMatch(JSON.stringify(activity), /secret|abc123|test/);
    assert.equal(
      activityFromSessionEvent({ type: "tool_execution_start", toolName: "read", args: { command: "cargo build" } })
        ?.buildTool,
      undefined,
    );
    assert.equal(
      sanitizeWorkerActivity({
        kind: "tool",
        phase: "started",
        toolName: "bash",
        buildTool: "rm -rf /",
        summary: "",
        meaningfulProgress: false,
      })?.buildTool,
      undefined,
    );
  });

  it("times a build command from its start to its end event, by tool call", () => {
    let now = 1_000;
    const timer = new BuildCommandTimer(() => now);
    const start = {
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "c1",
      args: { command: "cargo build" },
    };
    const other = { type: "tool_execution_start", toolName: "bash", toolCallId: "c2", args: { command: "ls" } };
    assert.equal(timer.observe(start, activityFromSessionEvent(start))?.buildTool, "cargo");
    timer.observe(other, activityFromSessionEvent(other));
    now = 91_000;
    const endOther = { type: "tool_execution_end", toolName: "bash", toolCallId: "c2" };
    assert.equal(timer.observe(endOther, activityFromSessionEvent(endOther))?.buildTool, undefined);
    const end = { type: "tool_execution_end", toolName: "bash", toolCallId: "c1", isError: true };
    const ended = sanitizeWorkerActivity(timer.observe(end, activityFromSessionEvent(end)));
    assert.equal(ended?.phase, "failed");
    assert.equal(ended?.buildTool, "cargo");
    assert.equal(ended?.elapsedMs, 90_000, "the duration survives the activity trust boundary");
  });
});

describe("worker build activity: the budget-exhausted hint", () => {
  const base = {
    committedChanges: [] as string[],
    isolatedWorktree: true,
    buildsRunning: 0,
    elapsedMs: 30 * 60_000,
  };

  it("says probable cold build only when builds took most of the execution", () => {
    const hint = budgetExhaustedBuildHint({
      ...base,
      buildCommands: new Map([["cargo", 12]]),
      buildMs: 20 * 60_000,
      buildsRunning: 1,
    });
    assert.match(hint ?? "", /^probable cold build in an isolated worktree: /);
    assert.match(hint ?? "", /spent 20m 0s of the 30m 0s run in 12 build command\(s\) \(cargo x12\)/);
    assert.match(hint ?? "", /1 still running at the deadline/);
    assert.match(hint ?? "", /made no commit/);
  });

  it("says the time went elsewhere when builds were the smaller part", () => {
    const hint = budgetExhaustedBuildHint({ ...base, buildCommands: { cargo: 9 }, buildMs: 2 * 60_000 });
    assert.doesNotMatch(hint ?? "", /cold build/);
    assert.match(hint ?? "", /spent 2m 0s of the 30m 0s run in 9 build command\(s\)/);
    assert.match(hint ?? "", /most of it went to other work/);
  });

  it("claims nothing the activity does not support", () => {
    assert.equal(budgetExhaustedBuildHint({ ...base, buildCommands: undefined, buildMs: 0 }), undefined);
    assert.equal(budgetExhaustedBuildHint({ ...base, buildCommands: new Map(), buildMs: 0 }), undefined);
    assert.equal(
      budgetExhaustedBuildHint({ ...base, buildCommands: { cargo: 3 }, buildMs: 0, committedChanges: ["a.rs"] }),
      undefined,
      "the worker committed",
    );
    assert.equal(
      budgetExhaustedBuildHint({ ...base, buildCommands: { cargo: 3 }, buildMs: 0, isolatedWorktree: false }),
      undefined,
      "not an isolated worktree",
    );
    assert.equal(
      budgetExhaustedBuildHint({ ...base, buildCommands: { "rm -rf": 3 }, buildMs: 0 }),
      undefined,
      "unknown labels are ignored",
    );
  });
});
