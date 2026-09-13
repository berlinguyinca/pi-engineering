/**
 * Smoke test: invoke the extension factory with a mock ExtensionAPI and confirm
 * the documented commands and semantic tools are registered.
 */
import extensionFactory from "../extensions/index.ts";

const commands: string[] = [];
const tools: string[] = [];
const events: Array<[string, unknown]> = [];

const mockPi: any = {
  registerCommand: (name: string) => {
    commands.push(name);
  },
  registerTool: (t: { name: string }) => {
    tools.push(t.name);
  },
  on: (event: string, handler: unknown) => {
    events.push([event, handler]);
  },
};

extensionFactory(mockPi);

const EXPECTED_COMMANDS = [
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
  "blackhole",
];
const EXPECTED_TOOLS = ["ledger_read", "ledger_claim", "artifact_read", "repo_search", "symbol", "tests_for"];

for (const c of EXPECTED_COMMANDS) {
  if (!commands.includes(c)) {
    console.error(`MISSING COMMAND /${c}`);
    process.exit(1);
  }
}
for (const t of EXPECTED_TOOLS) {
  if (!tools.includes(t)) {
    console.error(`MISSING TOOL ${t}`);
    process.exit(1);
  }
}
console.log("Registered commands:", commands.join(", "));
console.log("Registered tools:", tools.join(", "));
console.log("COMMANDS OK");
