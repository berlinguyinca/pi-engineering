import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, parseArgs } from "@earendil-works/pi-coding-agent";
import {
  SESSION_INTERRUPTED_PROMPT,
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
  assert.equal(recover([user, failure()])?.waitMs, 10000);
  assert.equal(recover([user, failure()])?.kind, "refused");
  assert.equal(recover([user, failure()], now + 60000)?.waitMs, 0);
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
    // Partial output keeps the replay-contract rule's silence; the broader
    // failed-turn rule recovers these, and is tested below with an old timestamp.
    failure({}, [{ type: "text", text: "partial" }]),
    failure({}, [{ type: "toolCall" }]),
    { ...failure(), timestamp: "invalid" },
  ])
    assert.equal(recover([user, entry]), undefined, JSON.stringify(entry));
  assert.equal(recover([]), undefined);
});
test("automatic recovery is bounded per operator turn, and a real user turn starts over", () => {
  const auto = { ...user, message: { role: "user", content: [{ type: "text", text: SESSION_RECOVERY_PROMPT }] } };
  assert.equal(recover([user, failure(), auto, failure()])?.kind, "refused");
  assert.equal(recover([user, failure(), auto, failure(), auto, failure()])?.kind, "refused");
  assert.equal(recover([user, failure(), auto, failure(), auto, failure(), auto, failure()]), undefined);
  assert.equal(recover([user, failure(), auto, failure(), user, failure()])?.waitMs, 10000);
});

// ─── Tails the original rule left idle ──────────────────────────────────────

const OLD = 60 * 60_000;
const at = (ms: number) => new Date(now - ms).toISOString();
const error = (errorMessage: string, content: unknown[] = [], age = OLD) => ({
  type: "message",
  id: "e1",
  timestamp: at(age),
  message: { role: "assistant", stopReason: "error", content, errorMessage },
});
const tool = (role: string, age = OLD, extra: Record<string, unknown> = {}) => ({
  type: "message",
  id: "t1",
  timestamp: at(age),
  message: { role, content: [], ...extra },
});

test("a retryable failure without the replay contract is recovered once it is old enough", () => {
  for (const text of [
    "Stream ended without finish_reason",
    "terminated",
    "Request timed out.",
    "Connection error.",
    "502 <html><title>502 Bad Gateway</title></html>",
  ]) {
    const r = recover([user, error(text)]);
    assert.equal(r?.kind, "failed-turn", text);
    assert.equal(r?.waitMs, 0);
  }
});

test("a turn cut after partial output is recovered too, with the prompt that says it may be incomplete", () => {
  const r = recover([user, error("terminated", [{ type: "text", text: "partial answer" }])]);
  assert.equal(r?.kind, "failed-turn");
  assert.match(r!.prompt, /incomplete/);
});

test("a turn that failed with a replay contract but partial output is not the 'refused' kind", () => {
  const old = { ...failure({}, [{ type: "text", text: "partial" }]), timestamp: at(OLD) };
  assert.equal(recover([user, old])?.kind, "failed-turn");
  assert.equal(recover([user, { ...old, timestamp: at(30_000) }]), undefined);
});

test("an operator abort of a running tool is not a crash", () => {
  const aborted = tool("toolResult", OLD, {
    isError: true,
    content: [{ type: "text", text: "Operation aborted" }],
  });
  assert.equal(recover([user, aborted]), undefined);
  assert.equal(
    recover([user, tool("toolResult", OLD, { isError: true, content: [{ type: "text", text: "exit 1" }] })])?.kind,
    "interrupted",
  );
});

test("a failure newer than the age gate is left alone: it may be live in another terminal", () => {
  assert.equal(recover([user, error("terminated", [], 60_000)]), undefined);
  assert.equal(recover([user, tool("toolResult", 60_000)]), undefined);
  assert.equal(
    sessionRecovery([user, error("terminated", [], 60_000)] as never, now, { minAgeMs: 30_000 })?.kind,
    "failed-turn",
  );
});

test("final refusals, quota limits and unknown errors are never recovered", () => {
  for (const text of [
    '503: {"action":"do_not_retry","action_code":"IW-ACT-DO-NOT-RETRY","code":"invalid_upstream_response","message":"bad"}',
    '404: {"action":"fix_request","action_code":"IW-ACT-FIX-REQUEST","code":"model_not_found","message":"Model x not found"}',
    "400 proxy: request exceeds available context windows\n",
    "429 Rate limit reached: monthly spend limit reached",
  ]) {
    assert.equal(recover([user, error(text)]), undefined, text.slice(0, 50));
  }
});

test("a session that ends on a tool result or tool call (process died) is recovered", () => {
  assert.equal(recover([user, tool("toolResult")])?.kind, "interrupted");
  assert.equal(recover([user, tool("assistant", OLD, { stopReason: "toolUse" })])?.kind, "interrupted");
  assert.match(recover([user, tool("toolResult")])!.prompt, /check current state before repeating any action/);
});

test("completed, aborted and operator-final tails are not an interruption", () => {
  assert.equal(recover([user, tool("assistant", OLD, { stopReason: "stop" })]), undefined);
  assert.equal(recover([user, tool("assistant", OLD, { stopReason: "aborted" })]), undefined);
  assert.equal(recover([user]), undefined);
});

test("the recovery budget also bounds the new tails", () => {
  const auto = { ...user, message: { role: "user", content: [{ type: "text", text: SESSION_INTERRUPTED_PROMPT }] } };
  assert.equal(
    recover([user, tool("toolResult"), auto, tool("toolResult"), auto, tool("toolResult")])?.kind,
    "interrupted",
  );
  assert.equal(
    recover([user, auto, tool("toolResult"), auto, tool("toolResult"), auto, tool("toolResult")]),
    undefined,
  );
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
    // `--continue` is resolved to the most recent session and pinned, so the file
    // that was inspected is the one Pi opens.
    const recent = await prepareSessionAutoResume(["-c", "--session-dir", root], root);
    assert.equal(recent.recovering, true);
    const pinned = parseArgs(recent.argv);
    assert.equal(pinned.session, path);
    assert.deepEqual(pinned.messages, [SESSION_RECOVERY_PROMPT]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Live sessions are never recovered ─────────────────────────────────────

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { otherPiProcessesIn } from "../../src/gateway/sessionLiveness.ts";

const hasProc = existsSync("/proc/self/cmdline");

function fakeProc(root: string, pid: number, args: string[], cwd: string) {
  mkdirSync(join(root, String(pid)), { recursive: true });
  writeFileSync(join(root, String(pid), "cmdline"), `${args.join("\0")}\0`);
  symlinkSync(cwd, join(root, String(pid), "cwd"));
}

test("otherPiProcessesIn finds a Pi CLI or the wrapper in the directory, and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "proc-"));
  try {
    const dir = join(root, "project");
    mkdirSync(dir);
    fakeProc(root, 10, ["node", "/x/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"], dir);
    fakeProc(root, 11, ["node", "/x/scripts/pi-session-auto-resume.ts", "/x/cli.js"], dir);
    fakeProc(root, 15, ["node", "/x/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"], dir); // installed layout
    fakeProc(root, 12, ["node", "/x/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"], root); // other cwd
    fakeProc(root, 13, ["vim", "pi-coding-agent/dist/cli.js.bak"], dir); // not a Pi CLI
    fakeProc(root, 14, ["node", "/x/pi-coding-agent/dist/cli.js"], dir); // self
    assert.deepEqual(otherPiProcessesIn(dir, 14, root), [10, 11, 15]);
    assert.deepEqual(otherPiProcessesIn(dir, 14, join(root, "missing")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function oldSession(root: string) {
  const manager = SessionManager.create(root, root);
  manager.appendMessage({ role: "user", content: "existing work", timestamp: now });
  manager.appendMessage({
    role: "assistant",
    stopReason: "error",
    content: [],
    errorMessage: "terminated",
    api: "openai-completions",
    provider: "canary",
    model: "old",
    timestamp: now - OLD,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as never);
  const file = manager.getSessionFile()!;
  // The manager stamps entries with the current time; backdate them so the age gate sees an old session.
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  writeFileSync(
    file,
    `${lines.map((line, i) => (i === 0 ? line : JSON.stringify({ ...JSON.parse(line), timestamp: at(OLD) }))).join("\n")}\n`,
  );
  return file;
}

test(
  "a session another Pi is working in is not recovered; the override and a free directory are",
  { skip: !hasProc },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "auto-resume-live-"));
    const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "/x/pi-coding-agent/dist/cli.js"], {
      cwd: root,
      stdio: "ignore",
    });
    try {
      const path = oldSession(root);
      // The entry's own timestamp decides age; make sure the file reads as old.
      const stale = JSON.parse(JSON.stringify(SessionManager.open(path).getBranch()));
      assert.ok(stale.length > 0);
      await new Promise((r) => setTimeout(r, 200));
      const blocked = await prepareSessionAutoResume(["--session", path], root);
      assert.equal(blocked.recovering, false);
      assert.match(blocked.skipped ?? "", /another Pi is running/);
      const forced = await prepareSessionAutoResume(["--session", path], root, {
        PI_SESSION_AUTO_RESUME_IGNORE_LIVE: "1",
      });
      assert.equal(forced.recovering, true);
      decoy.kill();
      await new Promise((r) => decoy.once("exit", r));
      const free = await prepareSessionAutoResume(["--session", path], root);
      assert.equal(free.recovering, true);
      assert.equal(free.kind, "failed-turn");
    } finally {
      decoy.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("--continue pins the file Pi would open (newest by mtime) and leaves flag values alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "auto-resume-mtime-"));
  try {
    const stale = oldSession(root);
    const newer = oldSession(root);
    assert.notEqual(stale, newer);
    // The older-named file is rewritten later: Pi's `-c` would open it.
    utimesSync(newer, new Date(now - 5000_000), new Date(now - 5000_000));
    utimesSync(stale, new Date(), new Date());
    const out = await prepareSessionAutoResume(["-c", "--session-dir", root, "--system-prompt", "-c"], root, {
      PI_SESSION_AUTO_RESUME_IGNORE_LIVE: "1",
    });
    assert.equal(out.recovering, true);
    const args = parseArgs(out.argv);
    assert.equal(args.session, stale);
    assert.equal(args.systemPrompt, "-c");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
