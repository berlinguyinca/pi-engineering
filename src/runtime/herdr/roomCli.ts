/**
 * `pi-engineering room <list|join|attach|history|catchup|tasks|artifacts|say|leave>` and the Pi `/rooms` / `/room ...`
 * slash commands. One module, two thin front ends: the CLI prints JSON (exit 0 ok, 1 refused/failed, 2 usage or not
 * joined, 3 HCN offline), the slash handler turns the same result objects into short text.
 *
 * It extends the existing `herdr` external-agent CLI instead of replacing it: `room join` and `room leave` ARE
 * `herdr join` / `herdr leave` (same credential file, same 0600 rules, join code read from a file or stdin, never argv).
 *
 * Standalone safety: nothing here is imported by the runtime's start path. Without `herdr.url` and a stored credential
 * these commands say so and do nothing; with the control plane unreachable they report `HCN offline` and Pi keeps
 * working on its own.
 */
import { join } from "node:path";
import { resolveStateRoot } from "../isolation/stateDir.ts";
import { ExternalAgentClient } from "./externalAgent.ts";
import { runHerdrExternalCli } from "./externalCli.ts";
import { loadHerdrConnection } from "./herdrConnection.ts";
import { MAX_PAGE, ROOM_ID_RE, RoomClient, RoomError, loadRoomState, saveRoomState } from "./roomClient.ts";
import { type RoomEvent, VERBOSITIES, type Verbosity, renderEvent, safeText } from "./roomFeed.ts";

export const ROOM_USAGE =
  "usage: pi-engineering room <list|join --code-file <path|->|attach [--room id] [--activity|--expert] [--slow] [--json] [--from-start|--cursor n]|history [--room id] [--cursor n] [--limit n] [--tail n] [--text]|catchup [--room id]|tasks [--room id]|artifacts [--room id]|say --text <t> [--room id]|leave>\n";

export interface RoomIo {
  out(t: string): void;
  err(t: string): void;
}
export interface RoomDeps {
  fetch?: typeof globalThis.fetch;
  /** Abort to detach `attach` (tests); the CLI wires SIGINT / SIGTERM. */
  signal?: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Session =
  | { ok: true; api: ExternalAgentClient; rooms: RoomClient; stateDir: string }
  | { ok: false; reason: "no_herdr" | "not_joined"; message: string };

export async function openRoomSession(env: NodeJS.ProcessEnv, deps: RoomDeps = {}): Promise<Session> {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? "~", ".pi", "agent");
  const stateDir = resolveStateRoot(env);
  const { connection, notes } = await loadHerdrConnection(agentDir);
  if (!connection) {
    return {
      ok: false,
      reason: "no_herdr",
      message: notes.join("; ") || "herdr.url is not set in the global engineering.yaml: Pi runs standalone",
    };
  }
  const api = ExternalAgentClient.fromState(stateDir, deps.fetch ? { fetch: deps.fetch } : {}, connection.baseUrl);
  if (!api) {
    return {
      ok: false,
      reason: "not_joined",
      message:
        "not joined to a room (or the stored credential is not for herdr.url, or its file is not private): run `pi-engineering room join --code-file <path>`",
    };
  }
  return { ok: true, api, rooms: new RoomClient(api), stateDir };
}

// --- operations: plain result objects shared by the CLI and the slash commands ---------------------------------

export type OpResult = { result: string; exit: number; [k: string]: unknown };

const offline = (): OpResult => ({
  result: "offline",
  exit: 3,
  hcn: "offline",
  standalone: true,
  message: "HCN offline: Pi works standalone; room features resume when the control plane is reachable.",
});

function failure(err: unknown): OpResult {
  if (err instanceof RoomError) {
    if (err.kind === "offline") return offline();
    const message =
      err.kind === "unauthorized"
        ? "the room credential was revoked or expired: run `pi-engineering room join` with a new code"
        : err.kind === "forbidden"
          ? "this credential is not allowed to do that in the room (Herdr withholds it from external agents)"
          : err.kind === "not_found"
            ? "room not found, or this credential cannot see it"
            : err.kind === "rate_limited"
              ? "the control plane asked Pi to slow down; try again shortly"
              : `the control plane refused the request (HTTP ${err.status})`;
    return { result: err.kind, exit: 1, status: err.status, message };
  }
  return { result: "error", exit: 1, message: "failed" };
}

function pickRoom(s: Extract<Session, { ok: true }>, room: string | undefined): string | OpResult {
  const id = room ?? s.rooms.defaultRoomId;
  if (!id) return { result: "usage", exit: 2, message: "no room: pass --room <id>" };
  if (!ROOM_ID_RE.test(id)) return { result: "usage", exit: 2, message: "invalid room id" };
  return id;
}

export async function opList(s: Extract<Session, { ok: true }>): Promise<OpResult> {
  const id = s.rooms.defaultRoomId;
  let hcn: "online" | "offline" = "online";
  let me: Record<string, unknown> = {};
  try {
    me = await s.rooms.me();
  } catch (err) {
    if (err instanceof RoomError && err.kind === "offline") hcn = "offline";
    else return failure(err);
  }
  const saved = id ? loadRoomState(s.stateDir, id) : { cursor: 0 };
  return {
    result: "ok",
    exit: 0,
    hcn,
    // An external Pi credential belongs to one room; Herdr's room index is for people, so the list is this room.
    rooms: id
      ? [
          {
            room_id: id,
            label: me.label ?? null,
            actions: me.actions ?? null,
            expires_at: me.expires_at ?? null,
            saved_cursor: saved.cursor,
          },
        ]
      : [],
  };
}

export async function opHistory(
  s: Extract<Session, { ok: true }>,
  o: { room?: string; cursor?: number; limit?: number; tail?: number },
): Promise<OpResult> {
  const room = pickRoom(s, o.room);
  if (typeof room !== "string") return room;
  try {
    if (o.tail !== undefined) {
      const keep: RoomEvent[] = [];
      let cursor = o.cursor ?? 0;
      let more = true;
      for (let pages = 0; more && pages < 100; pages++) {
        const p = await s.rooms.readPage(room, cursor, MAX_PAGE);
        keep.push(...p.events);
        if (keep.length > o.tail * 2) keep.splice(0, keep.length - o.tail);
        cursor = p.next_cursor;
        more = p.has_more;
      }
      const events = keep.slice(-o.tail);
      return { result: "ok", exit: 0, room_id: room, events, next_cursor: cursor, has_more: more };
    }
    const p = await s.rooms.readPage(room, o.cursor ?? 0, o.limit ?? 50);
    return { result: "ok", exit: 0, room_id: room, events: p.events, next_cursor: p.next_cursor, has_more: p.has_more };
  } catch (err) {
    return failure(err);
  }
}

/** Everything since the saved position (bounded), then advance the saved position. */
export async function opCatchup(s: Extract<Session, { ok: true }>, o: { room?: string }): Promise<OpResult> {
  const room = pickRoom(s, o.room);
  if (typeof room !== "string") return room;
  const saved = loadRoomState(s.stateDir, room);
  try {
    const events: RoomEvent[] = [];
    let cursor = saved.cursor;
    let more = true;
    for (let pages = 0; more && pages < 5; pages++) {
      const p = await s.rooms.readPage(room, cursor, MAX_PAGE);
      events.push(...p.events);
      cursor = p.next_cursor;
      more = p.has_more;
    }
    saveRoomState(s.stateDir, room, { ...saved, cursor });
    return { result: "ok", exit: 0, room_id: room, since: saved.cursor, events, next_cursor: cursor, has_more: more };
  } catch (err) {
    return failure(err);
  }
}

export async function opTasks(s: Extract<Session, { ok: true }>, o: { room?: string }): Promise<OpResult> {
  const room = pickRoom(s, o.room);
  if (typeof room !== "string") return room;
  try {
    return { result: "ok", exit: 0, room_id: room, tasks: await s.rooms.tasks(room) };
  } catch (err) {
    return failure(err);
  }
}

/** Artifact ids referenced by room messages (the room feed is the only artifact listing an external credential has). */
export async function opArtifacts(s: Extract<Session, { ok: true }>, o: { room?: string }): Promise<OpResult> {
  const room = pickRoom(s, o.room);
  if (typeof room !== "string") return room;
  try {
    const out: Array<{ artifact_id: string; event_id: string; sequence: number; sender: string | null }> = [];
    let cursor = 0;
    let more = true;
    for (let pages = 0; more && pages < 50; pages++) {
      const p = await s.rooms.readPage(room, cursor, MAX_PAGE);
      for (const ev of p.events) {
        for (const id of ev.artifact_ids ?? []) {
          out.push({ artifact_id: id, event_id: ev.event_id, sequence: ev.sequence, sender: ev.sender?.id ?? null });
        }
      }
      cursor = p.next_cursor;
      more = p.has_more;
    }
    return { result: "ok", exit: 0, room_id: room, artifacts: out, complete: !more };
  } catch (err) {
    return failure(err);
  }
}

export async function opSay(s: Extract<Session, { ok: true }>, o: { room?: string; text: string }): Promise<OpResult> {
  const room = pickRoom(s, o.room);
  if (typeof room !== "string") return room;
  if (!o.text.trim()) return { result: "usage", exit: 2, message: "empty message" };
  try {
    await s.rooms.post(room, o.text);
    return { result: "sent", exit: 0, room_id: room };
  } catch (err) {
    return failure(err);
  }
}

// --- CLI ----------------------------------------------------------------------------------------------------

function num(v: string | undefined, min: number, max: number): number | null | undefined {
  if (v === undefined) return undefined;
  if (!/^\d{1,12}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

export async function runRoomCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: () => Promise<string>,
  io: RoomIo = { out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t) },
  deps: RoomDeps = {},
): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const has = (name: string) => rest.includes(name);
  const usage = (): number => {
    io.err(ROOM_USAGE);
    return 2;
  };
  const herdrDeps = deps.fetch ? { fetch: deps.fetch } : {};
  // Same code path as `herdr join|leave`: one credential file, one set of rules.
  if (sub === "join") return runHerdrExternalCli(["join", ...rest], env, stdin, io, herdrDeps);
  if (sub === "leave") return runHerdrExternalCli(["leave"], env, stdin, io, herdrDeps);
  if (!sub || !["list", "attach", "history", "catchup", "tasks", "artifacts", "say"].includes(sub)) return usage();

  const cursor = num(flag("--cursor"), 0, Number.MAX_SAFE_INTEGER);
  const limit = num(flag("--limit"), 1, MAX_PAGE);
  const tail = num(flag("--tail"), 1, 1000);
  if (cursor === null || limit === null || tail === null) return usage();
  const room = flag("--room");
  const verbosity = has("--expert")
    ? "expert"
    : has("--activity")
      ? "activity"
      : (flag("--verbosity") as Verbosity | undefined);
  if (verbosity !== undefined && !VERBOSITIES.includes(verbosity)) return usage();

  const s = await openRoomSession(env, deps);
  if (!s.ok) {
    io.err(`${s.message}\n`);
    io.out(`${JSON.stringify({ result: s.reason, standalone: true })}\n`);
    return 2;
  }
  const print = (r: OpResult): number => {
    const { exit, ...body } = r;
    io.out(`${JSON.stringify(body)}\n`);
    if (exit !== 0 && typeof r.message === "string") io.err(`${r.message}\n`);
    return exit;
  };

  if (sub === "list") return print(await opList(s));
  if (sub === "catchup") return print(await opCatchup(s, { ...(room ? { room } : {}) }));
  if (sub === "tasks") return print(await opTasks(s, { ...(room ? { room } : {}) }));
  if (sub === "artifacts") return print(await opArtifacts(s, { ...(room ? { room } : {}) }));
  if (sub === "say") {
    const file = flag("--text-file");
    const text = file === "-" ? await stdin() : (flag("--text") ?? "");
    return print(await opSay(s, { ...(room ? { room } : {}), text }));
  }
  if (sub === "history") {
    const r = await opHistory(s, {
      ...(room ? { room } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(tail !== undefined ? { tail } : {}),
    });
    if (has("--text") && r.result === "ok") {
      const level: Verbosity = verbosity ?? "simple";
      for (const ev of r.events as RoomEvent[]) {
        const line = renderEvent(ev, level);
        if (line) io.out(`${line}\n`);
      }
      if (r.has_more) io.err(`more: --cursor ${r.next_cursor}\n`);
      return 0;
    }
    return print(r);
  }

  // attach: follow the room until detached. Detaching only closes this client's read stream; it never touches any agent.
  const roomId = pickRoom(s, room);
  if (typeof roomId !== "string") return print(roomId);
  const saved = loadRoomState(s.stateDir, roomId);
  const level: Verbosity = verbosity ?? saved.verbosity ?? "simple";
  const start = has("--from-start") ? 0 : (cursor ?? saved.cursor);
  const json = has("--json");
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  deps.signal?.addEventListener("abort", stop, { once: true });
  if (deps.signal?.aborted) ctl.abort();
  const sigs: NodeJS.Signals[] = deps.signal ? [] : ["SIGINT", "SIGTERM"];
  for (const sig of sigs) process.once(sig, stop);
  let last = start;
  const persist = () => saveRoomState(s.stateDir, roomId, { cursor: last, verbosity: level });
  try {
    const end = await s.rooms.follow(roomId, {
      cursor: start,
      signal: ctl.signal,
      slow: has("--slow"),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      onEvent: (ev) => {
        if (json) io.out(`${JSON.stringify(ev)}\n`);
        else {
          const line = renderEvent(ev, level);
          if (line) io.out(`${line}\n`);
        }
      },
      onNotice: (n) => io.err(`[room] ${safeText(n.text, 300)}\n`),
      onCursor: (c) => {
        if (c !== last) {
          last = c;
          persist();
        }
      },
    });
    last = end.cursor;
    persist();
    if (json)
      io.out(
        `${JSON.stringify({ result: end.reason === "revoked" ? "revoked" : "detached", room_id: roomId, cursor: last })}\n`,
      );
    else io.err(`[room] detached at sequence ${last}; no agent was stopped.\n`);
    return end.reason === "revoked" ? 1 : 0;
  } finally {
    for (const sig of sigs) process.off(sig, stop);
    deps.signal?.removeEventListener("abort", stop);
  }
}

// --- Pi slash commands --------------------------------------------------------------------------------------

export interface SlashResult {
  text: string;
  level: "info" | "warning";
}

function lines(events: RoomEvent[], level: Verbosity): string[] {
  const out: string[] = [];
  for (const ev of events) {
    const l = renderEvent(ev, level);
    if (l) out.push(l);
  }
  return out;
}

function slashText(r: OpResult, level: Verbosity): string {
  if (r.result === "offline") return String(r.message);
  if (r.result !== "ok" && r.result !== "sent") return String(r.message ?? r.result);
  if (r.result === "sent") return "Sent.";
  if (Array.isArray(r.rooms)) {
    const rooms = r.rooms as Array<{ room_id: string; label: string | null }>;
    const head = r.hcn === "offline" ? "HCN offline (showing the saved room).\n" : "";
    return rooms.length
      ? `${head}${rooms.map((x) => `${x.room_id}${x.label ? `  ${safeText(x.label, 60)}` : ""}`).join("\n")}`
      : "No room joined. Run `pi-engineering room join --code-file <path>` in a terminal.";
  }
  if (Array.isArray(r.events)) {
    const l = lines(r.events as RoomEvent[], level);
    return l.length ? `${l.join("\n")}${r.has_more ? "\n(more: run /room catchup again)" : ""}` : "Nothing new.";
  }
  if (Array.isArray(r.tasks)) {
    const t = r.tasks as Array<{ task_id?: string; status?: string; text?: string }>;
    return t.length
      ? t.map((x) => `${safeText(x.status ?? "pending", 20)}  ${safeText(x.text ?? "", 120)}`).join("\n")
      : "No tasks.";
  }
  if (Array.isArray(r.artifacts)) {
    const a = r.artifacts as Array<{ artifact_id: string; sender: string | null }>;
    return a.length
      ? a.map((x) => `${safeText(x.artifact_id, 80)}${x.sender ? `  from ${safeText(x.sender, 60)}` : ""}`).join("\n")
      : "No artifacts mentioned in this room.";
  }
  return "ok";
}

/**
 * `/rooms` and `/room <join|catchup|tasks|artifacts|list>`. `name` is the command that was invoked. Never throws and
 * never prompts for a join code: a code typed into a slash command would land in the session transcript, so `join`
 * only accepts `--code-file`.
 */
export async function runRoomSlash(
  name: "rooms" | "room",
  args: string,
  env: NodeJS.ProcessEnv,
  deps: RoomDeps = {},
): Promise<SlashResult> {
  try {
    const argv = args.trim().split(/\s+/).filter(Boolean);
    const sub = name === "rooms" ? "list" : (argv.shift() ?? "catchup");
    const level: Verbosity = argv.includes("--expert") ? "expert" : argv.includes("--activity") ? "activity" : "simple";
    const roomIdx = argv.indexOf("--room");
    const room = roomIdx >= 0 ? argv[roomIdx + 1] : undefined;
    const ro = room ? { room } : {};
    if (sub === "join") {
      const file = argv.indexOf("--code-file") >= 0 ? argv[argv.indexOf("--code-file") + 1] : undefined;
      if (!file || file === "-") {
        return {
          text: "Usage: /room join --code-file <path>. The code is never accepted inline; from a terminal use `pi-engineering room join --code-file -`.",
          level: "warning",
        };
      }
      const chunks = { out: [] as string[], err: [] as string[] };
      const code = await runRoomCli(
        ["join", "--code-file", file],
        env,
        async () => "",
        {
          out: (t) => void chunks.out.push(t),
          err: (t) => void chunks.err.push(t),
        },
        deps,
      );
      return code === 0
        ? { text: "Joined the room.", level: "info" }
        : { text: (chunks.err.join("") || chunks.out.join("") || "join failed").trim(), level: "warning" };
    }
    if (!["list", "catchup", "tasks", "artifacts"].includes(sub)) {
      return {
        text: "Usage: /rooms | /room join --code-file <path> | /room catchup | /room tasks | /room artifacts",
        level: "warning",
      };
    }
    if (room !== undefined && !ROOM_ID_RE.test(room)) return { text: "Invalid room id.", level: "warning" };
    const s = await openRoomSession(env, deps);
    if (!s.ok) return { text: `${s.message}`, level: "info" };
    const r =
      sub === "list"
        ? await opList(s)
        : sub === "catchup"
          ? await opCatchup(s, ro)
          : sub === "tasks"
            ? await opTasks(s, ro)
            : await opArtifacts(s, ro);
    return { text: slashText(r, level), level: r.exit === 0 ? "info" : "warning" };
  } catch {
    return { text: "Room command failed; Pi itself is unaffected.", level: "warning" };
  }
}
