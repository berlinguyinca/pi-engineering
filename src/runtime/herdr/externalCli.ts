/**
 * `pi-engineering herdr join --code-file <path|->`   redeem a one-time room join code (the code is read from a file or
 *                                                     stdin, never argv) and store the credential 0600 in the state dir
 * `pi-engineering herdr status`                      ask Herdr who this agent is
 * `pi-engineering herdr heartbeat [--status s] [--activity text]`   one presence beat
 * `pi-engineering herdr report --state running|done|failed|blocked`  report this agent's own lineage node
 * `pi-engineering herdr leave`                       withdraw and forget the credential
 *
 * The control plane URL is the global YAML `herdr.url`; no environment variable is read for it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateRoot } from "../isolation/stateDir.ts";
import { ExternalAgentClient, ExternalAgentError, type ExternalStatus } from "./externalAgent.ts";
import { loadHerdrConnection } from "./herdrConnection.ts";

const USAGE =
  "usage: pi-engineering herdr <join --code-file <path|->|status|heartbeat [--status s] [--activity text]|report --state <running|done|failed|blocked>|leave>\n";
const STATUSES: readonly string[] = ["idle", "working", "waiting", "blocked", "done", "failed"];
const STATES = ["running", "done", "failed", "blocked"] as const;

export async function runHerdrExternalCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: () => Promise<string>,
  io: { out(t: string): void; err(t: string): void } = {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
  },
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<number> {
  const sub = args[0];
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? "~", ".pi", "agent");
  const stateDir = resolveStateRoot(env);
  const d = deps.fetch ? { fetch: deps.fetch } : {};
  try {
    if (sub === "join") {
      const file = flag("--code-file");
      if (!file) {
        io.err(USAGE);
        return 2;
      }
      const code = file === "-" ? await stdin() : readFileSync(file, "utf8");
      const { connection, notes } = await loadHerdrConnection(agentDir);
      if (!connection) {
        io.err(`${notes.join("; ") || "herdr.url is not set in the global engineering.yaml"}\n`);
        return 2;
      }
      const client = await ExternalAgentClient.join(connection.baseUrl, code, stateDir, d);
      io.out(`${JSON.stringify({ result: "joined", agentId: client.agentId })}\n`);
      return 0;
    }
    const client = ExternalAgentClient.fromState(stateDir, d);
    if (!client && (sub === "status" || sub === "heartbeat" || sub === "report" || sub === "leave")) {
      io.err("not joined: run `pi-engineering herdr join` first\n");
      return 2;
    }
    if (sub === "status" && client) {
      io.out(`${JSON.stringify({ result: "ok", agentId: client.agentId, me: await client.me() })}\n`);
      return 0;
    }
    if (sub === "heartbeat" && client) {
      const status = flag("--status") ?? "idle";
      if (!STATUSES.includes(status)) {
        io.err(USAGE);
        return 2;
      }
      await client.heartbeat(status as ExternalStatus, flag("--activity") ?? "pi");
      io.out(`${JSON.stringify({ result: "ok" })}\n`);
      return 0;
    }
    if (sub === "report" && client) {
      const state = flag("--state");
      if (!state || !(STATES as readonly string[]).includes(state)) {
        io.err(USAGE);
        return 2;
      }
      await client.reportSelf(state as (typeof STATES)[number], flag("--label"));
      io.out(`${JSON.stringify({ result: "ok" })}\n`);
      return 0;
    }
    if (sub === "leave" && client) {
      await client.leave();
      io.out(`${JSON.stringify({ result: "left" })}\n`);
      return 0;
    }
  } catch (err) {
    io.err(`${err instanceof ExternalAgentError ? err.message : "failed"}\n`);
    return 1;
  }
  io.err(USAGE);
  return 2;
}
