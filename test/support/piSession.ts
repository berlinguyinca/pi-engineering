/**
 * A REAL Pi AgentSession for runtime-host tests: Pi's own resource loader,
 * extension loader (jiti for path-loaded extensions), ExtensionRunner and
 * slash-command dispatch. No model is configured; nothing here talks to a
 * network. Headless, so Pi uses its own no-op UI context.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

type Factory = (pi: never) => unknown;

export interface PiTestSession {
  root: string;
  cwd: string;
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  modelRuntime: Awaited<ReturnType<typeof ModelRuntime.create>>;
  /** Run a slash command (or prompt) through Pi exactly as the TUI would. */
  run(text: string): Promise<void>;
  /** Emit an event through Pi's real ExtensionRunner. */
  emit(event: { type: string; [k: string]: unknown }): Promise<unknown>;
  /** Number of handlers Pi holds for an event across all extensions. */
  piHandlerCount(event: string): number;
  /** Command names Pi resolves. */
  piCommands(): string[];
  close(): Promise<void>;
}

export async function startPiSession(
  opts: { factories?: Factory[]; extensionPaths?: string[]; cwd?: string } = {},
): Promise<PiTestSession> {
  const root = mkdtempSync(join(tmpdir(), "pi-host-session-"));
  const agentDir = join(root, "agent");
  const cwd = opts.cwd ?? join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: (opts.factories ?? []) as never,
    ...(opts.extensionPaths ? { additionalExtensionPaths: opts.extensionPaths } : {}),
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions?.() as { errors?: Array<{ error?: string }> } | undefined;
  const errors = (loaded?.errors ?? []).map((e) => e.error ?? JSON.stringify(e));
  if (errors.length > 0) throw new Error(`extension load failed: ${errors.join("; ")}`);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    tools: [],
  });
  await session.bindExtensions({});
  const runner = session.extensionRunner as unknown as {
    emit(event: unknown): Promise<unknown>;
    extensions: Array<{ handlers: Map<string, unknown[]> }>;
    getRegisteredCommands(): Array<{ name: string }>;
  };
  let closed = false;
  return {
    root,
    cwd,
    session,
    modelRuntime,
    run: (text) => session.prompt(text),
    emit: (event) => runner.emit(event),
    piHandlerCount: (event) => runner.extensions.reduce((n, ext) => n + (ext.handlers.get(event)?.length ?? 0), 0),
    piCommands: () => runner.getRegisteredCommands().map((c) => c.name),
    close: async () => {
      if (closed) return;
      closed = true;
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
