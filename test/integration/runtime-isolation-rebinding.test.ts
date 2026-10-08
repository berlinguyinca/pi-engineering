/**
 * Parent-directory launches and runtime rebinding (spec §2, §3, §16; acceptance
 * cases 1 and 7), through the real extension with a real git workspace:
 *
 *   ~/workspace            (itself a git repo, like ~/IdeaProjects)
 *   ~/workspace/alpha      (nested repo)
 *   ~/workspace/beta       (nested repo)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import extension, { settleWorkspaceActivity } from "../../extensions/index.ts";
import { RuntimeRegistry } from "../../src/runtime/isolation/RuntimeRegistry.ts";
import { RuntimeSession, registryFileFor } from "../../src/runtime/isolation/RuntimeSession.ts";
import { resolveWorktreeIdentity } from "../../src/runtime/isolation/WorktreeIdentity.ts";
import { makeGitRepo } from "../support/childSessions.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
interface ToolLike {
  name: string;
  execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

function loadHarness() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolLike>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: () => {},
    registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    setModel: async () => false,
    events: { on: () => {}, emit: () => {} },
  };
  (extension as unknown as (api: unknown) => void)(pi);
  return { handlers, tools };
}

function ctxFor(cwd: string) {
  return {
    cwd,
    hasUI: false,
    ui: { notify: () => {}, custom: () => ({ close: () => {} }), setFooter: () => {}, onTerminalInput: () => () => {} },
    sessionManager: { getSessionId: () => undefined },
  };
}

async function touch(handlers: Map<string, Handler[]>, cwd: string, path: string): Promise<void> {
  for (const handler of handlers.get("tool_execution_start") ?? []) {
    await handler({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: { path } }, ctxFor(cwd));
  }
  await settleWorkspaceActivity();
}

describe("parent-directory launch rebinding", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("starts at the parent, binds to the worktree being worked on, and rebinds repeatedly without losing events", async () => {
    const workspace = realpathSync(await mkdtemp(join(tmpdir(), "pi-eng-rebind-")));
    cleanup.push(workspace);
    await makeGitRepo(workspace);
    const alpha = await makeGitRepo(join(workspace, "alpha"));
    const beta = await makeGitRepo(join(workspace, "beta"));
    const { handlers, tools } = loadHarness();
    const session = RuntimeSession.current();

    // A semantic tool from the parent launch opens (and binds to) the parent.
    const ledgerRead = tools.get("ledger_read")!;
    await ledgerRead.execute("1", {}, undefined, undefined, ctxFor(workspace));
    assert.equal(session.binding?.worktreePath, workspace, "unbound session binds to the first runtime");

    // Working on alpha (a path beneath the launch dir) rebinds to alpha.
    await touch(handlers, workspace, join(alpha, "README.md"));
    assert.equal(session.binding?.worktreePath, alpha);
    assert.equal(session.health.state, "rebound");
    assert.ok(existsSync(join(alpha, ".pi-eng")), "alpha's runtime was opened before the pointer moved");

    // Tools invoked from the launch dir now resolve to alpha's runtime.
    const alphaId = (await resolveWorktreeIdentity(alpha)).worktreeId;
    const result = (await ledgerRead.execute("2", {}, undefined, undefined, ctxFor(workspace))) as {
      content: Array<{ text: string }>;
    };
    assert.doesNotMatch(result.content[0]!.text, /not initialized/);

    // Touching the parent container itself never rebinds back onto it.
    await touch(handlers, workspace, join(workspace, "README.md"));
    assert.equal(session.binding?.worktreePath, alpha);

    // Switch repeatedly; registry pointer and history follow exactly.
    for (let round = 0; round < 6; round++) {
      await touch(handlers, workspace, join(round % 2 === 0 ? beta : alpha, "README.md"));
      assert.equal(session.binding?.worktreePath, round % 2 === 0 ? beta : alpha);
    }
    const registry = RuntimeRegistry.open(registryFileFor(session.stateRoot()));
    try {
      const row = registry.get(session.sessionId);
      assert.equal(row?.worktreePath, alpha);
      assert.equal(row?.worktreeId, alphaId);
      const history = registry.bindingHistory(session.sessionId);
      assert.ok(history.length >= 8, `every bind is recorded (${history.length})`);
      assert.deepEqual(
        history.slice(-2).map((entry) => entry.worktreePath),
        [beta, alpha],
      );
    } finally {
      registry.close();
    }
    const log = readFileSync(join(session.sessionDir(), "runtime.jsonl"), "utf8");
    assert.match(log, /"event":"runtime\.rebound"/);
    assert.match(log, /"event":"runtime\.bound"/);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctxFor(workspace));
  });

  it("a failed rebind leaves the current binding fully in force (transactional)", async () => {
    const session = RuntimeSession.current();
    const before = session.binding;
    assert.ok(before, "bound by the previous test");
    const registry = RuntimeRegistry.open(registryFileFor(session.stateRoot()));
    try {
      const row = registry.get(session.sessionId)!;
      const historyBefore = registry.bindingHistory(session.sessionId).length;
      // A failure inside the transaction rolls back the attachment and pointer.
      assert.throws(() =>
        registry.rebind(
          session.sessionId,
          row.generationId,
          { repoId: "r", worktreeId: "elsewhere", worktreePath: "/elsewhere", runtimePath: null },
          () => {
            throw new Error("injected failure before commit");
          },
        ),
      );
      assert.equal(registry.get(session.sessionId)?.worktreeId, row.worktreeId);
      assert.equal(registry.bindingHistory(session.sessionId).length, historyBefore);

      // A session whose generation was superseded cannot move its pointer.
      registry.markDead(row, "orphaned");
      const outcome = session.bindTo({
        repoId: "r",
        worktreeId: "elsewhere",
        worktreePath: "/elsewhere",
        runtimePath: null,
        repoName: "elsewhere",
        kind: "worktree",
      });
      assert.equal(outcome.changed, false);
      assert.equal(session.binding?.worktreeId, before.worktreeId, "in-memory binding unchanged");
      // The next heartbeat re-registers under a new generation (no resurrection).
      assert.equal(session.heartbeat(), true);
      assert.notEqual(registry.get(session.sessionId)?.generationId, row.generationId);
    } finally {
      registry.close();
    }
  });
});
