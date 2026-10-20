import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, parseArgs } from "@earendil-works/pi-coding-agent";
import {
  SESSION_RECOVERY_PROMPT,
  prepareSessionAutoResume,
  sessionRecovery,
} from "../../src/gateway/sessionAutoResume.ts";

const refusal = {
  type: "inferweave_backpressure",
  reason: "capacity_unavailable",
  retryable: true,
  replay_safe: true,
  request_state: "not_started",
  action: "retry_alternate",
  action_code: "IW-ACT-RETRY-ALTERNATE",
  retry_after_ms: 20000,
};
const now = Date.now();
const user = { type: "message", id: "u1", message: { role: "user", content: "finish the existing work" } };
function failure(overrides = {}, content: unknown[] = []) {
  return {
    type: "message",
    id: "a1",
    timestamp: new Date(now - 10000).toISOString(),
    message: {
      role: "assistant",
      stopReason: "error",
      content,
      errorMessage: `Retry failed after 3 attempts: 429: ${JSON.stringify({ ...refusal, ...overrides })}`,
    },
  };
}
const recover = (branch: unknown[], at = now) => sessionRecovery(branch as never, at);

test("safe capacity failure can continue and honors the remaining declared delay", () => {
  assert.deepEqual(recover([user, failure()]), { waitMs: 10000 });
  assert.deepEqual(recover([user, failure()], now + 60000), { waitMs: 0 });
});
test("completed, cancelled, ambiguous, unsafe and partial-output turns stay idle", () => {
  for (const entry of [
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [] } },
    { type: "message", message: { role: "assistant", stopReason: "aborted", content: [] } },
    {
      type: "message",
      message: { role: "assistant", stopReason: "error", content: [], errorMessage: "503 unavailable" },
    },
    failure({ replay_safe: false }),
    failure({ retryable: false }),
    failure({ request_state: "dispatched" }),
    failure({ action: "do_not_retry", action_code: "IW-ACT-DO-NOT-RETRY" }),
    failure({}, [{ type: "text", text: "partial" }]),
    failure({}, [{ type: "toolCall" }]),
    { ...failure(), timestamp: "invalid" },
  ])
    assert.equal(recover([user, entry]), undefined, JSON.stringify(entry));
  assert.equal(recover([]), undefined);
});
test("automatic recovery is not repeated after another failure, until a real user turn", () => {
  const auto = { ...user, message: { role: "user", content: [{ type: "text", text: SESSION_RECOVERY_PROMPT }] } };
  assert.equal(recover([user, failure(), auto, failure()]), undefined);
  assert.deepEqual(recover([user, failure(), auto, failure(), user, failure()]), { waitMs: 10000 });
});

test("launcher preserves explicit prompts, attachments, alternate modes and opt-out", async () => {
  for (const tail of [
    ["new instructions"],
    ["@image.png"],
    ["--print"],
    ["--mode", "rpc"],
    ["--help"],
    ["--version"],
    ["--fork", "other"],
    ["--resume"],
    ["--"],
    ["-c"],
  ]) {
    const argv = ["--session", "missing", ...tail];
    assert.deepEqual((await prepareSessionAutoResume(argv, process.cwd())).argv, argv);
  }
  const argv = ["--session", "missing"];
  assert.equal(
    (await prepareSessionAutoResume(argv, process.cwd(), { PI_SESSION_AUTO_RESUME: "0" })).recovering,
    false,
  );
});

test("launcher pins a replay-safe restored session and supplies exactly one initial prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "auto-resume-preflight-"));
  try {
    const manager = SessionManager.create(root, root);
    manager.appendMessage({ role: "user", content: "existing work", timestamp: now });
    manager.appendMessage({
      ...failure().message,
      api: "openai-completions",
      provider: "canary",
      model: "old",
      timestamp: now,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as never);
    const path = manager.getSessionFile()!;
    const prepared = await prepareSessionAutoResume(["--session", path, "--system-prompt", "--continue"], root);
    assert.equal(prepared.recovering, true);
    const args = parseArgs(prepared.argv);
    assert.equal(args.session, path);
    assert.equal(args.systemPrompt, "--continue");
    assert.deepEqual(args.messages, [SESSION_RECOVERY_PROMPT]);
    assert.equal(
      SessionManager.open(path).getBranch().length,
      manager.getBranch().length,
      "preflight never mutates the session",
    );
    const recent = await prepareSessionAutoResume(["-c", "--session-dir", root], root);
    assert.equal(recent.recovering, false);
    assert.equal(parseArgs(recent.argv).continue, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
