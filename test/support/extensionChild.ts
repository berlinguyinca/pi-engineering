/**
 * A real Pi session launched from a PARENT directory, driven through the real
 * extension entry point: it uses a semantic tool from the launch directory,
 * then works on files in one or more nested repositories (in order), and
 * reports where its engineering runtime ended up bound.
 *
 *   node test/support/extensionChild.ts <launchCwd> <startAtEpochMs> <repoPath> [<repoPath> ...]
 */
import { join } from "node:path";
import extension, { settleWorkspaceActivity } from "../../extensions/index.ts";
import { RuntimeSession } from "../../src/runtime/isolation/RuntimeSession.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
interface ToolLike {
  name: string;
  execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

const [launchCwd, startAt, ...targets] = process.argv.slice(2);

async function main(): Promise<void> {
  if (!process.env.PI_ENGINEERING_STATE_DIR) throw new Error("extensionChild requires PI_ENGINEERING_STATE_DIR");
  if (!launchCwd || targets.length === 0) throw new Error("usage: extensionChild <launchCwd> <startAt> <repo>...");
  const delay = Number(startAt) - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
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
  const ctx = {
    cwd: launchCwd,
    hasUI: false,
    ui: { notify: () => {}, custom: () => ({ close: () => {} }), setFooter: () => {}, onTerminalInput: () => () => {} },
    sessionManager: { getSessionId: () => undefined },
  };
  const first = (await tools.get("ledger_read")!.execute("1", {}, undefined, undefined, ctx)) as {
    content: Array<{ text: string }>;
  };
  const bindings: Array<string | null> = [RuntimeSession.current().binding?.worktreePath ?? null];
  for (const target of targets) {
    for (const handler of handlers.get("tool_execution_start") ?? []) {
      await handler(
        { type: "tool_execution_start", toolCallId: "t", toolName: "read", args: { path: join(target, "README.md") } },
        ctx,
      );
    }
    await settleWorkspaceActivity();
    bindings.push(RuntimeSession.current().binding?.worktreePath ?? null);
  }
  const after = (await tools.get("ledger_read")!.execute("2", {}, undefined, undefined, ctx)) as {
    content: Array<{ text: string }>;
  };
  const session = RuntimeSession.current();
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      pid: process.pid,
      sessionId: session.sessionId,
      bindings,
      health: session.health.state,
      firstTool: first.content[0]?.text ?? "",
      lastTool: after.content[0]?.text ?? "",
    })}\n`,
  );
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ ok: false, pid: process.pid, error: String(error) })}\n`);
  process.exit(1);
});
