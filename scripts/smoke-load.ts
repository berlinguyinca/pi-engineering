#!/usr/bin/env node
/**
 * Deterministic "package loads as a Pi extension" proof (roadmap evidence type
 * package_load). Imports the extension entry point and registers it against a
 * stub ExtensionAPI, asserting the command + tool surface is present.
 *
 * Exit 0 = the package loads and registers as a Pi package. This runs without a
 * live model, so it is safe in CI and used by the roadmap engine.
 */
import extension from "../extensions/index.ts";

const commands = new Set<string>();
const tools = new Set<string>();

interface StubApi {
  registerCommand(name: string): void;
  registerTool(tool: { name?: string }): void;
  [k: string]: unknown;
}

const stubPi: StubApi = {
  registerCommand: (name: string) => {
    commands.add(name);
  },
  registerTool: (tool: { name?: string }) => {
    tools.add(tool.name ?? "(unnamed)");
  },
};

(extension as (pi: StubApi) => void)(stubPi);

const expectedCommands = [
  "gateway",
  "refresh-models",
  "engineer",
  "tournament",
  "plan",
  "execute",
  "ledger",
  "context",
  "verify",
  "review",
  "challenge",
  "roadmap-status",
  "remember",
  "memory",
];
const missingCommands = expectedCommands.filter((c) => !commands.has(c));
const expectedTools = ["ledger_read", "ledger_claim", "artifact_read", "repo_search", "symbol", "tests_for"];
const missingTools = expectedTools.filter((t) => !tools.has(t));

if (missingCommands.length || missingTools.length) {
  console.error(`package load FAILED`);
  if (missingCommands.length) console.error(`  missing commands: ${missingCommands.join(", ")}`);
  if (missingTools.length) console.error(`  missing tools: ${missingTools.join(", ")}`);
  process.exit(1);
}
console.log(`package load OK: ${commands.size} commands, ${tools.size} tools`);
