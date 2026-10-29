import { randomUUID } from "node:crypto";
/**
 * Native room client for Pi, on the existing HCN collab API (`/api/v1/collab/rooms/{id}/...`). It reuses
 * `ExternalAgentClient` (credential, device header, 0600 storage, redirect refusal): there is no second chat service,
 * no second credential store and no second transport.
 *
 * Reconnect model (`follow`): read pages from the cursor until `has_more` is false, then hold the SSE stream open
 * from that cursor. Any drop goes through the SAME path again from the unchanged cursor, so the stream and the pages
 * cannot disagree, an event is shown once (dedup by event_id and sequence), and nothing between two connections is
 * missed. Losing the control plane is a state (`offline`), never an error that ends the session: Pi's own work does not
 * depend on it. A fixed set of notices (connected / offline / reconnected / cursor reset / revoked) is the only
 * status output, one per transition; individual retries are silent.
 *
 * What an external Pi credential can and cannot do is decided by Herdr, not here: it reads and posts chat in ONE
 * room; the room list, task list and state long-poll answer 403 for it and surface here as `forbidden`.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExternalAgentClient } from "./externalAgent.ts";
import { type RoomEvent, RoomFeed, SseParser, VERBOSITIES, type Verbosity } from "./roomFeed.ts";

export const ROOM_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const MAX_PAGE = 200;

export type RoomErrorKind = "offline" | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "server";

export class RoomError extends Error {
  readonly kind: RoomErrorKind;
  readonly status: number;
  constructor(kind: RoomErrorKind, status = 0, message?: string) {
    super(message ?? kind);
    this.name = "RoomError";
    this.kind = kind;
    this.status = status;
  }
}

function kindOf(status: number): RoomErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "server";
}

export type Transport = Pick<ExternalAgentClient, "raw" | "roomId" | "agentId">;

export interface Page {
  events: RoomEvent[];
  next_cursor: number;
  has_more: boolean;
}

export type NoticeKind = "connected" | "offline" | "reconnected" | "cursor_reset" | "revoked" | "ended";
export interface Notice {
  kind: NoticeKind;
  text: string;
}

export interface FollowOptions {
  /** Start after this sequence (0 = from the start of what this credential may see). */
  cursor: number;
  onEvent(ev: RoomEvent): void;
  onNotice(n: Notice): void;
  /** Called after every batch so the caller can persist the cursor. */
  onCursor?(cursor: number): void;
  signal: AbortSignal;
  /** Slow-network mode: no stream, small pages polled at a longer interval. */
  slow?: boolean;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** Backoff base / cap in ms (defaults 1000 / 30000; 5000 / 60000 in slow mode). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const roomPath = (roomId: string, tail: string) => `/rooms/${encodeURIComponent(roomId)}${tail}`;

export class RoomClient {
  private readonly api: Transport;
  constructor(api: Transport) {
    this.api = api;
  }

  get defaultRoomId(): string | undefined {
    return this.api.roomId;
  }

  private async json(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.api.raw(method, path, body !== undefined ? { body } : {});
    } catch {
      throw new RoomError("offline");
    }
    if (!res.ok) throw new RoomError(kindOf(res.status), res.status);
    return res.json().catch(() => ({}));
  }

  /** One server-side page after `cursor` (forward, stable while new events are appended). */
  async readPage(roomId: string, cursor: number, limit = 100): Promise<Page> {
    const n = Math.max(1, Math.min(MAX_PAGE, Math.trunc(limit)));
    const body = (await this.json("GET", roomPath(roomId, `/events?cursor=${cursor}&limit=${n}`))) as Partial<Page>;
    return {
      events: Array.isArray(body.events) ? body.events : [],
      next_cursor: Number.isSafeInteger(body.next_cursor) ? (body.next_cursor as number) : cursor,
      has_more: body.has_more === true,
    };
  }

  /** Post a chat line. The idempotency key makes a retried post a no-op on the server. */
  async post(roomId: string, text: string, key = `pi-${randomUUID()}`): Promise<unknown> {
    return this.json("POST", roomPath(roomId, "/messages"), { text, idempotency_key: key });
  }

  /** Read-only task list; an external credential gets `forbidden` (Herdr withholds it). */
  async tasks(roomId: string): Promise<unknown[]> {
    const body = (await this.json("GET", roomPath(roomId, "/tasks"))) as { tasks?: unknown };
    return Array.isArray(body.tasks) ? body.tasks : [];
  }

  async me(): Promise<Record<string, unknown>> {
    return (await this.json("GET", "/agents/external/me")) as Record<string, unknown>;
  }

  /** Follow a room until `signal` aborts or access is revoked. Resolves with the final cursor; never rejects. */
  async follow(roomId: string, o: FollowOptions): Promise<{ cursor: number; reason: "aborted" | "revoked" }> {
    const feed = new RoomFeed(o.cursor);
    const sleep = o.sleep ?? defaultSleep;
    const base = o.backoffBaseMs ?? (o.slow ? 5000 : 1000);
    const max = o.backoffMaxMs ?? (o.slow ? 60_000 : 30_000);
    const pageSize = o.slow ? 20 : 100;
    let online: boolean | undefined;
    let failures = 0;
    let missed = 0;
    let offlineAt = o.cursor;

    const emit = (ev: RoomEvent): void => {
      if (feed.accept(ev) !== "new") return;
      missed++;
      o.onEvent(ev);
    };
    const markOnline = (): void => {
      if (online === false) {
        o.onNotice({
          kind: "reconnected",
          text: `HCN reconnected; ${missed} event${missed === 1 ? "" : "s"} caught up since sequence ${offlineAt}.`,
        });
      } else if (online === undefined) {
        o.onNotice({ kind: "connected", text: `Connected to room ${roomId}.` });
      }
      online = true;
      failures = 0;
    };
    // Read every page after the cursor. Throws RoomError.
    const drain = async (): Promise<void> => {
      for (;;) {
        const page = await this.readPage(roomId, feed.cursor, pageSize);
        if (feed.adoptServerCursor(page.next_cursor)) {
          o.onNotice({
            kind: "cursor_reset",
            text: `The control plane's log is behind this client (now at ${feed.cursor}); continuing from there. Earlier messages may be re-sent.`,
          });
        }
        for (const ev of page.events) emit(ev);
        o.onCursor?.(feed.cursor);
        if (!page.has_more) return;
      }
    };
    const revoked = (why: string): { cursor: number; reason: "revoked" } => {
      o.onNotice({
        kind: "revoked",
        text: `Room access ended (${why}). Standalone Pi is unaffected; run \`pi-engineering room join\` for a new code.`,
      });
      return { cursor: feed.cursor, reason: "revoked" };
    };

    while (!o.signal.aborted) {
      try {
        await drain();
        markOnline();
        if (o.slow) {
          await sleep(base, o.signal);
          continue;
        }
        await this.stream(roomId, feed, o, markOnline);
        // A stream that ended (server max age, proxy idle cut) is reconnected at once and silently.
      } catch (err) {
        if (o.signal.aborted) break;
        if (err instanceof RoomError && (err.kind === "unauthorized" || err.kind === "forbidden")) {
          return revoked(`HTTP ${err.status}`);
        }
        if (err instanceof RoomError && err.kind === "not_found") return revoked("room not found");
        if (online !== false) {
          online = false;
          missed = 0;
          offlineAt = feed.cursor;
          o.onNotice({
            kind: "offline",
            text: "HCN offline: Pi keeps working standalone; reconnecting in the background from the saved position.",
          });
        }
        failures++;
        const retryAfter = err instanceof RoomError && err.kind === "rate_limited" ? base * 4 : 0;
        await sleep(Math.max(retryAfter, Math.min(max, base * 2 ** (failures - 1))), o.signal);
      }
    }
    return { cursor: feed.cursor, reason: "aborted" };
  }

  /** Hold one SSE connection. Returns when it ends cleanly; throws RoomError on failure; resolves on abort. */
  private async stream(roomId: string, feed: RoomFeed, o: FollowOptions, markOnline: () => void): Promise<void> {
    let res: Response;
    try {
      res = await this.api.raw("GET", roomPath(roomId, `/events/stream?cursor=${feed.cursor}`), {
        signal: o.signal,
        timeoutMs: 0,
      });
    } catch {
      if (o.signal.aborted) return;
      throw new RoomError("offline");
    }
    if (!res.ok) throw new RoomError(kindOf(res.status), res.status);
    if (!res.body) throw new RoomError("server", res.status, "empty stream");
    markOnline();
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await reader.read();
        } catch {
          if (o.signal.aborted) return;
          throw new RoomError("offline");
        }
        if (chunk.done) return;
        let frames: unknown[];
        try {
          frames = parser.push(decoder.decode(chunk.value ?? new Uint8Array(), { stream: true }));
        } catch {
          throw new RoomError("server", 0, "oversized stream frame");
        }
        for (const f of frames) {
          const frame = f as { type?: string; reason?: string } & Partial<RoomEvent>;
          if (frame.type === "closed") {
            if (frame.reason === "access_revoked") throw new RoomError("unauthorized", 401);
            return; // too_many_streams etc.: back off through the normal path
          }
          if (typeof frame.event_type === "string") {
            if (feed.accept(frame) === "new") o.onEvent(frame as RoomEvent);
            o.onCursor?.(feed.cursor);
          }
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
  }
}

// --- local, private per-room position -------------------------------------------------------------------------

export interface RoomLocalState {
  cursor: number;
  verbosity?: Verbosity;
}

const stateFile = (stateDir: string, roomId: string) => join(stateDir, "rooms", `${roomId}.json`);

/** The saved position for a room, or {cursor: 0}. A file that is not private, not ours or not parseable is ignored. */
export function loadRoomState(stateDir: string, roomId: string): RoomLocalState {
  if (!ROOM_ID_RE.test(roomId)) return { cursor: 0 };
  const file = stateFile(stateDir, roomId);
  try {
    if (!existsSync(file)) return { cursor: 0 };
    const st = lstatSync(file);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || st.size > 4096) return { cursor: 0 };
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return { cursor: 0 };
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<RoomLocalState>;
    return {
      cursor: Number.isSafeInteger(v.cursor) && (v.cursor as number) >= 0 ? (v.cursor as number) : 0,
      ...(VERBOSITIES.includes(v.verbosity as Verbosity) ? { verbosity: v.verbosity as Verbosity } : {}),
    };
  } catch {
    return { cursor: 0 };
  }
}

export function saveRoomState(stateDir: string, roomId: string, state: RoomLocalState): void {
  if (!ROOM_ID_RE.test(roomId)) return;
  const file = stateFile(stateDir, roomId);
  mkdirSync(join(stateDir, "rooms"), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
