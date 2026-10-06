/**
 * Candidate probe, run in a SEPARATE Node process during validation (spec §16).
 * It covers the runtime initialization test and the hot-reload smoke test.
 *
 *   node probe.ts <candidateDir> <entry> <scratchDir>
 *
 * It loads the candidate through a real RuntimeHost, starts it, checks its
 * health, reloads it once and checks that nothing was registered twice. It
 * prints one `PROBE {json}` line. The candidate's code never runs inside the
 * Pi process before it has passed this check. The probe's ExtensionAPI only
 * records what the candidate registers: there is no session, model or UI here.
 */

import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RuntimeHost } from "../runtime/host/host.ts";

export interface ProbeReport {
  ok: boolean;
  stage: "load" | "start" | "health" | "reload" | "done";
  failure?: string;
  commands: string[];
  tools: string[];
  handlers: number;
  handlersAfterReload?: number;
  health?: Array<{ name: string; ok: boolean; detail?: string }>;
}

/** An ExtensionAPI that records registrations and performs no actions. */
export function recordingApi(): {
  api: ExtensionAPI;
  commands: Set<string>;
  tools: Set<string>;
  handlerCount: () => number;
} {
  const commands = new Set<string>();
  const tools = new Set<string>();
  const handlers: Array<[string, unknown]> = [];
  const api = {
    on: (event: string, handler: unknown) => {
      handlers.push([event, handler]);
      return () => {};
    },
    registerCommand: (name: string) => {
      commands.add(name);
    },
    registerTool: (tool: { name: string }) => {
      tools.add(tool.name);
    },
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setModel: async () => false,
    getActiveTools: () => [],
    getAllTools: () => [],
    getCommands: () => [],
    events: { on: () => () => {}, emit: () => {} },
  };
  return { api: api as unknown as ExtensionAPI, commands, tools, handlerCount: () => handlers.length };
}

export async function probeCandidate(candidateDir: string, entry: string, scratchDir: string): Promise<ProbeReport> {
  const rec = recordingApi();
  const host = new RuntimeHost({ pi: rec.api, generationsDir: scratchDir, handoverWaitMs: 5_000 });
  const report = (r: Omit<ProbeReport, "commands" | "tools" | "handlers">): ProbeReport => ({
    ...r,
    commands: [...rec.commands].sort(),
    tools: [...rec.tools].sort(),
    handlers: rec.handlerCount(),
  });
  const source = { root: candidateDir, entry, version: "candidate", commit: null, label: "candidate", direct: true };
  const started = await host.start(source);
  if (!started.ok) {
    return report({
      ok: false,
      stage: /health check failed/.test(started.failure ?? "") ? "health" : "start",
      ...(started.failure ? { failure: started.failure } : {}),
    });
  }
  const health = await host.health();
  const handlers = rec.handlerCount();
  const reload = await host.handover({ kind: "reload", source: { ...source, direct: false } });
  const after = rec.handlerCount();
  await host.shutdown({ type: "session_shutdown", reason: "quit" }, undefined);
  if (!reload.ok) return report({ ok: false, stage: "reload", failure: reload.failure ?? "reload failed" });
  if (after !== handlers) {
    return report({
      ok: false,
      stage: "reload",
      failure: `reload changed Pi handler registrations (${handlers} → ${after})`,
      handlersAfterReload: after,
    });
  }
  return report({ ok: health.healthy, stage: "done", health: health.checks, handlersAfterReload: after });
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [candidateDir, entry, scratchDir] = process.argv.slice(2);
  const out = await probeCandidate(candidateDir as string, entry as string, scratchDir as string).catch(
    (error: unknown): ProbeReport => ({
      ok: false,
      stage: "load",
      failure: error instanceof Error ? error.message : String(error),
      commands: [],
      tools: [],
      handlers: 0,
    }),
  );
  process.stdout.write(`PROBE ${JSON.stringify(out)}\n`);
  // Candidate code may leave handles open; the probe's verdict is already out.
  process.exit(0);
}
