import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../../extensions/index.ts";
import { ToolCallGuard, resolveToolCallGuardConfig } from "../../src/guard/toolCallGuard.ts";

const append = { command: "echo '- item' >> notes.md" };

test("blocks the Nth identical consecutive tool call (session review: an append ran 153 times)", () => {
  const guard = new ToolCallGuard({ enabled: true, maxIdenticalConsecutive: 5, testCommandTimeoutSec: 900 });
  for (let i = 1; i <= 5; i++) assert.equal(guard.onToolCall("bash", { ...append }), undefined, `call ${i} allowed`);
  const blocked = guard.onToolCall("bash", { ...append });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /identical.*6 times/i);
});

test("a different call in between resets the identical-call run", () => {
  const guard = new ToolCallGuard({ enabled: true, maxIdenticalConsecutive: 3, testCommandTimeoutSec: 900 });
  for (let i = 0; i < 3; i++) guard.onToolCall("bash", { ...append });
  guard.onToolCall("read", { path: "notes.md" });
  assert.equal(guard.onToolCall("bash", { ...append }), undefined);
});

test("adds a default timeout to bash test/build commands, leaving explicit timeouts and other commands alone", () => {
  const guard = new ToolCallGuard({ enabled: true, maxIdenticalConsecutive: 8, testCommandTimeoutSec: 600 });
  for (const command of ["npm test", "npm run build", "npx tsc --noEmit", "cargo test", "go test ./...", "pytest -q"]) {
    const input: Record<string, unknown> = { command };
    guard.onToolCall("bash", input);
    assert.equal(input.timeout, 600, command);
  }
  const explicit: Record<string, unknown> = { command: "npm test", timeout: 30 };
  guard.onToolCall("bash", explicit);
  assert.equal(explicit.timeout, 30);
  const plain: Record<string, unknown> = { command: "ls -la" };
  guard.onToolCall("bash", plain);
  assert.equal(plain.timeout, undefined);
});

test("refuses to immediately re-run a command that just timed out", () => {
  const guard = new ToolCallGuard({ enabled: true, maxIdenticalConsecutive: 8, testCommandTimeoutSec: 600 });
  const input = { command: "npm test" };
  guard.onToolCall("bash", { ...input });
  guard.onToolResult("bash", { ...input }, true, "...output...\n\nCommand timed out after 600 seconds");
  const blocked = guard.onToolCall("bash", { ...input });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /timed out/);
  // A longer explicit timeout is a deliberate retry and is allowed.
  assert.equal(guard.onToolCall("bash", { ...input, timeout: 1800 }), undefined);

  guard.onToolResult("bash", { command: "make check" }, true, "Command timed out after 600 seconds");
  assert.equal(guard.onToolCall("bash", { command: "make check" })?.block, true);
  assert.equal(guard.onToolCall("bash", { command: "make lint" }), undefined, "other commands run");
});

test("a user abort (Esc) is not an interruption: the plain re-run is allowed (PR #106 review)", () => {
  const guard = new ToolCallGuard(resolveToolCallGuardConfig({}));
  guard.onToolCall("bash", { command: "make check" });
  guard.onToolResult("bash", { command: "make check" }, true, "partial output\n\nCommand aborted");
  assert.equal(guard.onToolCall("bash", { command: "make check" }), undefined);
});

test("a timed-out command is re-runnable after a few unrelated calls (PR #106 review)", () => {
  const guard = new ToolCallGuard(resolveToolCallGuardConfig({}));
  guard.onToolCall("bash", { command: "npm test" });
  guard.onToolResult("bash", { command: "npm test" }, true, "Command timed out after 600 seconds");
  assert.equal(guard.onToolCall("bash", { command: "npm test" })?.block, true, "an immediate re-run is blocked");
  for (const path of ["a.ts", "b.ts", "c.ts"]) guard.onToolCall("read", { path });
  assert.equal(guard.onToolCall("bash", { command: "npm test" }), undefined, "the interruption expired");
});

test("read-only status polling is not blocked by the identical-call limit (PR #106 review)", () => {
  const guard = new ToolCallGuard(resolveToolCallGuardConfig({}));
  for (const command of ["gh pr checks 106", "sleep 30 && gh pr checks 106", "git status --short", "gh run view 42"]) {
    for (let i = 1; i <= 30; i++) assert.equal(guard.onToolCall("bash", { command }), undefined, `${command} #${i}`);
  }
  for (let i = 1; i <= 8; i++) guard.onToolCall("bash", { command: "git status && rm -f notes.md" });
  assert.equal(
    guard.onToolCall("bash", { command: "git status && rm -f notes.md" })?.block,
    true,
    "a mutating chain is not polling",
  );
});

test("build detection is anchored to command position (PR #106 review)", () => {
  const guard = new ToolCallGuard(resolveToolCallGuardConfig({}));
  for (const command of ["grep make Makefile", "echo cargo build", "cat notes/make.md", "rg 'npm test' docs"]) {
    const input: Record<string, unknown> = { command };
    guard.onToolCall("bash", input);
    assert.equal(input.timeout, undefined, command);
  }
  for (const command of [
    "make",
    "cd sub && make -j4",
    "FOO=1 cargo build --release",
    "timeout 900 npm test",
    "(cd x; go test ./...)",
  ]) {
    const input: Record<string, unknown> = { command };
    guard.onToolCall("bash", input);
    assert.equal(typeof input.timeout, "number", command);
  }
});

test("the default build timeout leaves room for long builds (PR #106 review)", () => {
  assert.ok(resolveToolCallGuardConfig({}).testCommandTimeoutSec >= 3600);
});

test("config is conservative by default and can be turned off", () => {
  const defaults = resolveToolCallGuardConfig({});
  assert.equal(defaults.enabled, true);
  assert.ok(defaults.maxIdenticalConsecutive >= 8);
  assert.equal(resolveToolCallGuardConfig({ PI_TOOL_CALL_GUARD: "0" }).enabled, false);
  assert.equal(resolveToolCallGuardConfig({ PI_REPEATED_TOOL_CALL_LIMIT: "12" }).maxIdenticalConsecutive, 12);
  assert.equal(resolveToolCallGuardConfig({ PI_BASH_TEST_TIMEOUT_SEC: "120" }).testCommandTimeoutSec, 120);
  const off = new ToolCallGuard({ ...defaults, enabled: false });
  for (let i = 0; i < 50; i++) assert.equal(off.onToolCall("bash", { ...append }), undefined);
});

test("the live extension's tool_call hook applies the guard", async () => {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  (extension as unknown as (pi: unknown) => void)({
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: () => {},
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    setModel: async () => false,
    events: { on: () => {}, emit: () => {} },
  });
  const input: Record<string, unknown> = { command: "npm test" };
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ type: "tool_call", toolName: "bash", toolCallId: "c1", input }, { mode: "tui" });
  }
  assert.ok(typeof input.timeout === "number", "default timeout applied through the live hook");
});
