/**
 * `/room`: a THIN local client over Herdr's authenticated collaboration API. There is no second state store: every
 * command is one request/response against the control plane named by the GLOBAL engineering.yaml `herdr:` block
 * (`url`, `api_key_file`, `room_id`), so closing the terminal cancels nothing and a restart loses nothing.
 *
 *   /room                         compact project tree, current agents, attention inbox, link to the full graph
 *   /room say <text>              post a message to the room (idempotency key per command)
 *   /room assign <agent> <text>   give work to one agent of the room (id, name or address; ambiguous = refused)
 *   /room rooms                   list the rooms this key can read
 *   --room <id> <command>         first on the line: use another room than `herdr.room_id`
 *
 * The key is read by loadHerdrConnection (absolute path, 0600, owned by you), sent only as `Authorization: Bearer` to the
 * configured url, never logged, printed or put in an error. Redirects are refused. Everything the server sends is
 * untrusted text (task text is flagged `untrusted`): control characters and escape sequences are stripped before display.
 */
import { randomUUID } from "node:crypto";
import { type HerdrConnection, loadHerdrConnection } from "./herdrConnection.ts";

const COLLAB = "/api/v1/collab";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ROWS = 40;
const MAX_TEXT = 4000;

export class RoomClientError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "RoomClientError";
    this.status = status;
  }
}

/** Strip ANSI/OSC escape sequences and every C0/C1 control character, collapse whitespace, cap the length. */
export function cleanForTerminal(value: unknown, max = 160): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  const stripped = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the sanitizer
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the sanitizer
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the sanitizer
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

export interface RoomClientDeps {
  fetch?: typeof globalThis.fetch;
  /** Idempotency key source; default a random UUID per command. */
  newKey?: () => string;
}

export class RoomClient {
  readonly baseUrl: string;
  readonly roomId: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly newKey: () => string;

  constructor(conn: { baseUrl: string; apiKey: string }, roomId: string, deps: RoomClientDeps = {}) {
    this.baseUrl = conn.baseUrl;
    this.apiKey = conn.apiKey;
    this.roomId = roomId;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.newKey = deps.newKey ?? (() => `pi-room-${randomUUID()}`);
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${COLLAB}${path}`;
    const init: RequestInit = {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    let res: Response | undefined;
    // One retry on a transport failure only. A POST carries the same idempotency key, so a retry cannot double-post.
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch {
        if (attempt === 1) throw new RoomClientError("could not reach the control plane");
      }
    }
    if (!res) throw new RoomClientError("could not reach the control plane");
    if (!res.ok) {
      const hint =
        res.status === 401 ? " (key not accepted)" : res.status === 404 ? " (no such room, or no access)" : "";
      throw new RoomClientError(`${method} ${path.split("?")[0]} refused: HTTP ${res.status}${hint}`, res.status);
    }
    const parsed = (await res.json().catch(() => null)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  }

  private room(suffix: string): string {
    return `/rooms/${encodeURIComponent(this.roomId)}${suffix}`;
  }

  state(): Promise<Record<string, unknown>> {
    return this.call("GET", `${this.room("/state")}?since=-1&cursor=0&wait=0`);
  }
  attention(): Promise<Record<string, unknown>> {
    return this.call("GET", this.room("/attention"));
  }
  rooms(): Promise<Record<string, unknown>> {
    return this.call("GET", "/rooms");
  }
  say(text: string, key = this.newKey()): Promise<Record<string, unknown>> {
    return this.call("POST", this.room("/messages"), { text, idempotency_key: key });
  }
  assign(agentId: string, text: string, key = this.newKey()): Promise<Record<string, unknown>> {
    return this.call("POST", this.room("/tasks"), { target_agent_id: agentId, text, idempotency_key: key });
  }

  /** The full lineage graph lives in Herdr's own UI; this is where to open it. */
  graphUrl(): string {
    return `${this.baseUrl}/#/collab?room=${encodeURIComponent(this.roomId)}`;
  }
}

const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
const str = (v: unknown, max?: number): string => cleanForTerminal(v, max);

/** Pure: the compact view. */
export function renderRoomView(
  state: Record<string, unknown>,
  attention: Record<string, unknown> | null,
  graphUrl: string,
  roomId: string,
): string {
  const agents = arr(state.agents);
  const tasks = arr(state.tasks);
  const missions = arr(state.missions);
  const lines: string[] = [`Room ${str(roomId, 64)}${typeof state.seq === "number" ? ` (seq ${state.seq})` : ""}`];

  lines.push(
    `Project tree (${missions.length} mission${missions.length === 1 ? "" : "s"}, ${tasks.length} task${tasks.length === 1 ? "" : "s"})`,
  );
  for (const m of missions.slice(0, 10)) lines.push(`  mission ${str(m.mission_id, 64)}`);
  const known = new Set(tasks.map((t) => str(t.task_id, 80)));
  const children = new Map<string, Record<string, unknown>[]>();
  const roots: Record<string, unknown>[] = [];
  for (const t of tasks) {
    const parent = str(t.parent_task_id, 80);
    if (parent && known.has(parent)) children.set(parent, [...(children.get(parent) ?? []), t]);
    else roots.push(t);
  }
  let shown = 0;
  const walk = (t: Record<string, unknown>, depth: number): void => {
    if (shown >= MAX_ROWS) return;
    shown++;
    const who = str(t.target_name, 40) || str(t.target_agent_id, 40);
    lines.push(`  ${"  ".repeat(depth)}${depth ? "└ " : ""}[${str(t.status, 16) || "?"}] ${who}: ${str(t.text, 90)}`);
    for (const c of children.get(str(t.task_id, 80)) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  if (tasks.length > shown) lines.push(`  … ${tasks.length - shown} more task(s) in Herdr`);

  lines.push(`Agents (${agents.length})`);
  for (const a of agents.slice(0, MAX_ROWS)) {
    lines.push(
      `  ${a.online === true ? "●" : "○"} ${str(a.name, 40) || str(a.agent_id, 40)} [${str(a.harness_type, 20) || "?"}] ${str(a.agent_id, 40)}`,
    );
  }

  if (attention === null) {
    lines.push("Attention: unavailable");
  } else {
    const items = arr(attention.items);
    const counts =
      attention.counts && typeof attention.counts === "object" ? (attention.counts as Record<string, unknown>) : {};
    lines.push(`Attention (${typeof counts.open === "number" ? counts.open : items.length} open)`);
    for (const it of items.slice(0, 15)) {
      const subject = str(it.subject, 60);
      lines.push(
        `  [${str(it.severity, 10)}] ${str(it.title, 80) || str(it.category, 40)}${subject ? ` — ${subject}` : ""}`,
      );
    }
    if (items.length === 0) lines.push("  nothing needs you");
  }
  lines.push(`Full graph: ${graphUrl}`);
  return lines.join("\n");
}

export type RoomCommandResult = { text: string; level: "info" | "error" | "warning" };

export interface RoomCommandDeps extends RoomClientDeps {
  agentDir: string;
  /** Test seam; default reads the YAML `herdr:` block. */
  loadConnection?: (agentDir: string) => Promise<{ connection: HerdrConnection | null; notes: string[] }>;
}

const USAGE =
  "/room [status] | /room say <text> | /room assign <agent> <text> | /room rooms   (add --room <id> to use another room)";

function resolveAgent(agents: Record<string, unknown>[], wanted: string): { id: string } | { error: string } {
  const w = wanted.toLowerCase();
  const exact = agents.filter(
    (a) => str(a.agent_id).toLowerCase() === w || str(a.name).toLowerCase() === w || str(a.address).toLowerCase() === w,
  );
  const pool = exact.length ? exact : agents.filter((a) => str(a.name).toLowerCase().startsWith(w));
  if (pool.length === 1) return { id: String(pool[0]!.agent_id) };
  if (pool.length === 0) return { error: `no agent "${str(wanted, 40)}" in this room (see /room)` };
  return { error: `"${str(wanted, 40)}" matches ${pool.length} agents; use the agent id` };
}

/** Run one `/room` command. Never throws; never prints the key. */
export async function runRoomCommand(args: string, deps: RoomCommandDeps): Promise<RoomCommandResult> {
  let rest = args.trim();
  let roomOverride: string | undefined;
  const flag = /^--room\s+(\S+)\s*/.exec(rest);
  if (flag) {
    roomOverride = flag[1];
    rest = rest.slice(flag[0].length).trim();
  }
  const [verbRaw = "", ...tail] = rest.split(/\s+/).filter(Boolean);
  const verb = verbRaw.toLowerCase() || "status";
  const body = rest.slice(verbRaw.length).trim();

  const { connection, notes } = await (deps.loadConnection ?? loadHerdrConnection)(deps.agentDir);
  if (!connection) {
    return {
      level: "warning",
      text: `/room needs a \`herdr:\` block (url, api_key_file, room_id) in engineering.yaml.${notes.length ? `\n${notes.map((n) => cleanForTerminal(n, 200)).join("\n")}` : ""}`,
    };
  }
  if (!connection.apiKey)
    return { level: "warning", text: "/room needs `herdr.api_key_file` in engineering.yaml (no key configured)." };
  const roomId = roomOverride ?? connection.roomId;
  if (verb !== "rooms" && !roomId)
    return { level: "warning", text: "/room needs `herdr.room_id` in engineering.yaml, or pass --room <id>." };
  if (roomOverride && !/^[A-Za-z0-9._:-]{1,128}$/.test(roomOverride))
    return { level: "error", text: "--room must be 1-128 of A-Za-z0-9._:-" };
  const client = new RoomClient({ baseUrl: connection.baseUrl, apiKey: connection.apiKey }, roomId ?? "", deps);

  try {
    switch (verb) {
      case "status":
      case "show": {
        const [state, attention] = await Promise.all([client.state(), client.attention().catch(() => null)]);
        return { level: "info", text: renderRoomView(state, attention, client.graphUrl(), client.roomId) };
      }
      case "rooms": {
        const rooms = arr((await client.rooms()).rooms);
        if (!rooms.length) return { level: "info", text: "No rooms visible to this key." };
        return {
          level: "info",
          text: rooms
            .slice(0, MAX_ROWS)
            .map((r) => `${str(r.id ?? r.room_id, 64)}  ${str(r.name, 60)}`)
            .join("\n"),
        };
      }
      case "say": {
        if (!body) return { level: "error", text: USAGE };
        if (body.length > MAX_TEXT) return { level: "error", text: `message is longer than ${MAX_TEXT} characters` };
        await client.say(body);
        return { level: "info", text: "Posted to the room." };
      }
      case "assign": {
        const [agentWord = ""] = tail;
        const text = body.slice(agentWord.length).trim();
        if (!agentWord || !text) return { level: "error", text: USAGE };
        if (text.length > MAX_TEXT) return { level: "error", text: `task text is longer than ${MAX_TEXT} characters` };
        const resolved = resolveAgent(arr((await client.state()).agents), agentWord);
        if ("error" in resolved) return { level: "error", text: resolved.error };
        const out = await client.assign(resolved.id, text);
        return {
          level: "info",
          text: `Task ${str(out.task_id, 64) || "created"} assigned to ${str(resolved.id, 64)}${out.replayed === true ? " (already existed)" : ""}.`,
        };
      }
      default:
        return { level: "error", text: USAGE };
    }
  } catch (error) {
    return { level: "error", text: `/room: ${error instanceof RoomClientError ? error.message : "request failed"}` };
  }
}
