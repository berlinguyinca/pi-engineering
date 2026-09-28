/** CLI client for live PI session instances; never opens a second PI agent. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  type SessionDescriptor,
  type SessionQueryResult,
  discoverSessions,
  queryAllSessions,
  requestSession,
  sessionControlRoot,
} from "./SessionControl.ts";

export interface SessionCliOptions {
  rootDir?: string;
  write?: (text: string) => void;
  error?: (text: string) => void;
  signal?: AbortSignal;
}

function display(rows: SessionQueryResult[]): string {
  if (rows.length === 0) return "No live PI Engineering session descriptors found.\n";
  return `${rows
    .map(({ descriptor, reachable, reply }) => {
      const state = reachable && reply?.ok ? `${reply.data.currentTool ?? "idle"}` : "UNREACHABLE";
      const mission = reachable && reply?.ok ? reply.data.missions.at(-1) : undefined;
      return `${descriptor.instanceId}  ${state}  ${mission ? `${mission.id}:${mission.status}` : ""}  ${descriptor.cwd}`;
    })
    .join("\n")}\n`;
}

function watchKey(rows: SessionQueryResult[]): string {
  return JSON.stringify(
    rows.map(({ descriptor, reachable, reply }) => ({
      instanceId: descriptor.instanceId,
      reachable,
      currentTool: reply?.ok ? reply.data.currentTool : null,
      lastToolProgressAt: reply?.ok ? reply.data.lastToolProgressAt : null,
      missions: reachable && reply?.ok ? reply.data.missions : [],
    })),
  );
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function runSessionsCommand(args: string[], options: SessionCliOptions = {}): Promise<number> {
  const out = options.write ?? ((value: string) => process.stdout.write(value));
  const err = options.error ?? ((value: string) => process.stderr.write(value));
  const root = options.rootDir ?? sessionControlRoot();
  const json = args.includes("--json");
  const repoArg = args.find((a) => a.startsWith("--repo="));
  const repo = repoArg ? resolve(repoArg.slice("--repo=".length)) : null;
  const action = args[0];
  const intervalArg = args.find((a) => a.startsWith("--interval-ms="));
  const interval = intervalArg ? Number(intervalArg.slice("--interval-ms=".length)) : 2000;
  if (action === "list" || action === "watch") {
    if (action === "watch" && (!Number.isInteger(interval) || interval < 20 || interval > 60000)) {
      err("--interval-ms must be between 20 and 60000\n");
      return 2;
    }
    let previous = "";
    do {
      let rows = await queryAllSessions(root, { fullStatus: true });
      if (repo) rows = rows.filter(({ descriptor }) => resolve(descriptor.cwd) === repo);
      const key = watchKey(rows);
      if (action === "list" || key !== previous) out(json ? `${JSON.stringify(rows)}\n` : display(rows));
      previous = key;
      if (action === "list" || options.signal?.aborted) break;
      await wait(interval, options.signal);
    } while (!options.signal?.aborted);
    return 0;
  }
  if (!(["ping", "status", "note"] as string[]).includes(action ?? "")) {
    err("usage: pi-engineering sessions <list|watch|ping|status|note> [instance-id] [--json]\n");
    return 2;
  }
  const instanceId = args[1];
  if (!instanceId || !/^[0-9a-f-]{36}$/.test(instanceId)) {
    err("Provide an exact instance ID from `sessions list`.\n");
    return 2;
  }
  const descriptor = (await discoverSessions(root)).find((entry) => entry.instanceId === instanceId);
  if (!descriptor) {
    err("No descriptor for that exact instance ID.\n");
    return 2;
  }
  const message =
    action === "note"
      ? args
          .slice(2)
          .filter((a) => a !== "--json")
          .join(" ")
      : "";
  if (action === "note" && !message.trim()) {
    err("usage: pi-engineering sessions note <instance-id> <text>\n");
    return 2;
  }
  const nonce = randomUUID();
  try {
    const reply = await requestSession(
      descriptor,
      action === "ping"
        ? { version: 1, op: "ping", nonce }
        : action === "status"
          ? { version: 1, op: "status" }
          : { version: 1, op: "note", messageId: randomUUID(), text: message },
    );
    if (!reply.ok) {
      err(`${reply.error}\n`);
      return 1;
    }
    if (action === "ping" && reply.data.nonce !== nonce) {
      err("Ping nonce mismatch.\n");
      return 1;
    }
    if (json) out(`${JSON.stringify(reply.data)}\n`);
    else if (action === "note") out(`Delivered informational note to ${descriptor.instanceId}.\n`);
    else
      out(
        `${descriptor.instanceId} responded at ${reply.data.respondedAt}; ` +
          `tool=${reply.data.currentTool ?? "idle"}; mission=${reply.data.missions.at(-1)?.status ?? "none"}\n`,
      );
    return 0;
  } catch (error) {
    err(
      `Instance ${descriptor.instanceId} did not respond: ${error instanceof Error ? error.message : "unreachable"}\n`,
    );
    return 1;
  }
}
