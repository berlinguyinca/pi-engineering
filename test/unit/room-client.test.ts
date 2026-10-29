// Native Pi room client (UW P04): feed/dedup/render, reconnect + cursor + gap recovery, CLI contract, and
// INV-013 standalone operation with no HCN. Opts back in from the harness-wide HERDR_DISABLED default.
delete process.env.HERDR_DISABLED;
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";
import { ExternalAgentClient } from "../../src/runtime/herdr/externalAgent.ts";
import { runRoomCli, runRoomSlash } from "../../src/runtime/herdr/roomCli.ts";
import { type Notice, RoomClient, loadRoomState } from "../../src/runtime/herdr/roomClient.ts";
import { registerRoomCommands } from "../../src/runtime/herdr/roomCommands.ts";
import { type RoomEvent, RoomFeed, SseParser, renderEvent, safeText } from "../../src/runtime/herdr/roomFeed.ts";

const BASE = "http://127.0.0.1:9";
const CRED = ["cred", String(process.pid), "r"].join("-");
const CODE = ["hcj", "one", "time"].join("_");

const msg = (sequence: number, text = `m${sequence}`, extra: Partial<RoomEvent> = {}): RoomEvent => ({
  sequence,
  event_id: `e${sequence}`,
  event_type: "message",
  created_at: "2026-10-29T10:15:00Z",
  sender: { type: "user", id: "ann" },
  text,
  ...extra,
});
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const sse = (frames: unknown[], opts: { hold?: AbortSignal } = {}) => {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < frames.length) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(frames[i++])}\n\n`));
          return;
        }
        if (!opts.hold) return c.close();
        return new Promise<void>((resolve) => {
          opts.hold?.addEventListener("abort", () => {
            try {
              c.close();
            } catch {}
            resolve();
          });
        });
      },
    }),
    { status: 200 },
  );
};

function world() {
  const root = mkdtempSync(join(tmpdir(), "room-cli-"));
  const agentDir = join(root, "agent");
  const stateDir = join(root, "state");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "engineering.yaml"), `herdr:\n  url: ${BASE}\n`);
  const env = { PI_CODING_AGENT_DIR: agentDir, PI_ENGINEERING_STATE_DIR: stateDir, HOME: root } as NodeJS.ProcessEnv;
  return { root, agentDir, stateDir, env };
}
const joined = async (stateDir: string) =>
  ExternalAgentClient.join(BASE, CODE, stateDir, {
    fetch: (async () =>
      json({ agent_id: "ag1", credential: CRED, device_id: "dev1", room_id: "r1" }, 201)) as typeof fetch,
  });
const cap = () => {
  const o: string[] = [];
  const e: string[] = [];
  return { o, e, io: { out: (t: string) => void o.push(t), err: (t: string) => void e.push(t) } };
};
const noSleep = async () => {};

describe("room feed", () => {
  it("accepts an event once by sequence and by id, and treats gaps in sequence as normal", () => {
    const f = new RoomFeed(10);
    assert.equal(f.accept(msg(14)), "new"); // sequences are server-global: 11..13 belong to other rooms
    assert.equal(f.accept(msg(14)), "duplicate");
    assert.equal(f.accept(msg(12)), "duplicate"); // behind the cursor
    assert.equal(f.accept({ ...msg(20), event_id: "e14" }), "duplicate"); // same id, new sequence
    assert.equal(f.accept({ sequence: "x" }), "invalid");
    assert.equal(f.cursor, 14);
    assert.equal(f.adoptServerCursor(3), true);
    assert.equal(f.adoptServerCursor(99), false);
    assert.equal(f.cursor, 3);
  });

  it("parses SSE across chunk boundaries and drops comments and garbage", () => {
    const p = new SseParser();
    assert.deepEqual(p.push(': keep-alive\n\ndata: {"a"'), []);
    assert.deepEqual(p.push(':1}\n\ndata: not json\n\ndata: {"b":2}\n\n'), [{ a: 1 }, { b: 2 }]);
    assert.throws(() => p.push("x".repeat(SseParser.MAX_BUFFER + 1)), RangeError);
  });

  it("strips terminal escapes and direction overrides from untrusted text", () => {
    const evil = "hi\u001b[31m red\u001b]0;title\u0007 ‮evil\u0000!";
    assert.equal(safeText(evil), "hi red evil!");
    assert.ok(!renderEvent(msg(1, evil), "simple")?.includes("\u001b"));
  });

  it("renders simple < activity < expert", () => {
    const task: RoomEvent = { ...msg(2), event_type: "task_updated", task: { status: "running", text: "build" } };
    const done: RoomEvent = { ...task, task: { status: "completed", text: "build" } };
    const grant: RoomEvent = { ...msg(3), event_type: "agent_granted" };
    assert.match(renderEvent(msg(1), "simple") ?? "", /^10:15 ann: m1$/);
    assert.equal(renderEvent(task, "simple"), null);
    assert.match(renderEvent(done, "simple") ?? "", /task completed: build/);
    assert.equal(renderEvent(grant, "simple"), null);
    assert.match(renderEvent(task, "activity") ?? "", /task running/);
    assert.match(renderEvent(grant, "activity") ?? "", /agent granted/);
    assert.match(renderEvent(msg(1), "expert") ?? "", /#1 e1$/);
  });
});

describe("RoomClient.follow", () => {
  const run = async (
    handler: (url: string, n: number) => Response | Promise<Response>,
    over: { cursor?: number; stop: (events: RoomEvent[], notices: Notice[], ctl: AbortController) => boolean },
  ) => {
    const w = world();
    const api = await joined(w.stateDir);
    const calls: string[] = [];
    let n = 0;
    const real = ExternalAgentClient.fromState(w.stateDir, {
      fetch: (async (url: string) => {
        calls.push(url.replace(`${BASE}/api/v1/collab`, ""));
        return handler(url, n++);
      }) as unknown as typeof fetch,
    }) as ExternalAgentClient;
    void api;
    const events: RoomEvent[] = [];
    const notices: Notice[] = [];
    const ctl = new AbortController();
    const cursors: number[] = [];
    const end = await new RoomClient(real).follow("r1", {
      cursor: over.cursor ?? 0,
      signal: ctl.signal,
      sleep: async () => {
        if (over.stop(events, notices, ctl)) ctl.abort();
      },
      onEvent: (e) => {
        events.push(e);
        if (over.stop(events, notices, ctl)) ctl.abort();
      },
      onNotice: (x) => notices.push(x),
      onCursor: (c) => cursors.push(c),
    });
    return { events, notices, calls, end, cursors };
  };

  it("pages then streams from the cursor, showing each event once even when page and stream overlap", async () => {
    const r = await run(
      (url) => {
        if (url.includes("/events/stream")) return sse([{ type: "connected", cursor: 12 }, msg(12), msg(13), msg(13)]);
        if (url.includes("cursor=0")) return json({ events: [msg(10), msg(11)], next_cursor: 11, has_more: true });
        return json({ events: [msg(12)], next_cursor: 12, has_more: false });
      },
      { stop: (ev) => ev.length >= 4 },
    );
    assert.deepEqual(
      r.events.map((e) => e.sequence),
      [10, 11, 12, 13],
    );
    assert.ok(r.calls.some((c) => c.includes("/events/stream?cursor=12")));
    assert.equal(r.notices.filter((n) => n.kind === "connected").length, 1);
    assert.equal(r.end.cursor, 13);
  });

  it("a dropped connection is ONE offline notice, then ONE reconnected notice with the missed events, from the saved cursor", async () => {
    const script: Array<(url: string) => Response> = [
      () => json({ events: [], next_cursor: 0, has_more: false }), // page: connected
      () => sse([msg(1)]), // stream ends: silent reconnect
      () => json({ events: [], next_cursor: 1, has_more: false }),
      () => {
        throw new TypeError("network down"); // stream: control plane unreachable
      },
      () => {
        throw new TypeError("network down"); // page: still down (no second notice)
      },
      () => json({ events: [msg(2), msg(3)], next_cursor: 3, has_more: false }), // back
      () => sse([msg(4)]),
    ];
    const r = await run((url, n) => (script[n] ?? (() => sse([])))(url), { stop: (ev) => ev.length >= 4 });
    assert.deepEqual(
      r.events.map((e) => e.sequence),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      r.notices.map((n) => n.kind),
      ["connected", "offline", "reconnected"],
    );
    assert.match(r.notices[2]?.text ?? "", /2 events caught up/);
    // every re-read starts from the saved cursor, never from zero again
    assert.deepEqual(
      r.calls.filter((c) => c.includes("/events?")).map((c) => /cursor=(\d+)/.exec(c)?.[1]),
      ["0", "1", "1", "1"],
    );
    assert.ok(r.calls.at(-1)?.includes("/events/stream?cursor=3"));
  });

  it("access revoked (401) ends the follow with an explicit notice; standalone Pi is untouched", async () => {
    const r = await run(() => json({ error: "unauthorized" }, 401), { stop: () => false });
    assert.equal(r.end.reason, "revoked");
    assert.deepEqual(
      r.notices.map((n) => n.kind),
      ["revoked"],
    );
  });

  it("a server cursor behind ours is announced and adopted", async () => {
    const r = await run(
      (url) =>
        url.includes("/events/stream") ? sse([msg(6)]) : json({ events: [msg(5)], next_cursor: 4, has_more: false }),
      { cursor: 50, stop: (ev) => ev.length >= 2 },
    );
    assert.ok(r.notices.some((n) => n.kind === "cursor_reset"));
    assert.deepEqual(
      r.events.map((e) => e.sequence),
      [5, 6],
    );
  });
});

describe("pi-engineering room (CLI)", () => {
  it("join reads the code from stdin, never argv, and stores a private credential; leave forgets it", async () => {
    const w = world();
    const c = cap();
    const calls: Array<{ url: string; body?: string }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string | undefined });
      return url.endsWith("/agents/join")
        ? json({ agent_id: "ag1", credential: CRED, device_id: "dev1", room_id: "r1" }, 201)
        : json({ ok: true });
    }) as unknown as typeof globalThis.fetch;
    const args = ["join", "--code-file", "-"];
    assert.ok(!args.join(" ").includes(CODE));
    assert.equal(await runRoomCli(args, w.env, async () => `${CODE}\n`, c.io, { fetch }), 0);
    assert.equal(JSON.parse(calls[0]?.body ?? "{}").token, CODE);
    assert.equal(statSync(join(w.stateDir, "herdr-external.json")).mode & 0o077, 0);
    assert.ok(!c.o.join("").includes(CRED) && !c.e.join("").includes(CRED));
    const l = cap();
    assert.equal(await runRoomCli(["leave"], w.env, async () => "", l.io, { fetch }), 0);
    assert.match(l.o.join(""), /left/);
  });

  it("history: server-side cursor pagination, stable under appended events, limit clamped", async () => {
    const w = world();
    await joined(w.stateDir);
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return json({ events: [msg(5)], next_cursor: 5, has_more: true });
    }) as unknown as typeof globalThis.fetch;
    const c = cap();
    assert.equal(
      await runRoomCli(["history", "--cursor", "3", "--limit", "50"], w.env, async () => "", c.io, { fetch }),
      0,
    );
    assert.match(urls[0] ?? "", /\/rooms\/r1\/events\?cursor=3&limit=50$/);
    const out = JSON.parse(c.o.join(""));
    assert.equal(out.next_cursor, 5);
    assert.equal(out.has_more, true);
    assert.equal(await runRoomCli(["history", "--limit", "9999"], w.env, async () => "", cap().io, { fetch }), 2);
    assert.equal(await runRoomCli(["history", "--room", "../x"], w.env, async () => "", cap().io, { fetch }), 2);
  });

  it("catchup shows only what is new since the saved position and advances it", async () => {
    const w = world();
    await joined(w.stateDir);
    let seen = 0;
    const fetch = (async (url: string) => {
      const m = /cursor=(\d+)/.exec(url);
      seen = Number(m?.[1]);
      return json(
        seen === 0
          ? { events: [msg(1), msg(2)], next_cursor: 2, has_more: false }
          : { events: [], next_cursor: seen, has_more: false },
      );
    }) as unknown as typeof globalThis.fetch;
    const c = cap();
    await runRoomCli(["catchup"], w.env, async () => "", c.io, { fetch });
    assert.equal(JSON.parse(c.o.join("")).events.length, 2);
    assert.equal(loadRoomState(w.stateDir, "r1").cursor, 2);
    const c2 = cap();
    await runRoomCli(["catchup"], w.env, async () => "", c2.io, { fetch });
    assert.equal(seen, 2);
    assert.equal(JSON.parse(c2.o.join("")).events.length, 0);
  });

  it("A15: HCN offline is an explicit state (exit 3) and standalone list still answers from the saved credential", async () => {
    const w = world();
    await joined(w.stateDir);
    const fetch = (async () => {
      throw new TypeError("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const c = cap();
    assert.equal(await runRoomCli(["history"], w.env, async () => "", c.io, { fetch }), 3);
    assert.equal(JSON.parse(c.o.join("")).hcn, "offline");
    assert.match(c.e.join(""), /HCN offline/);
    const l = cap();
    assert.equal(await runRoomCli(["list"], w.env, async () => "", l.io, { fetch }), 0);
    const list = JSON.parse(l.o.join(""));
    assert.equal(list.hcn, "offline");
    assert.equal(list.rooms[0].room_id, "r1");
  });

  it("forbidden (task list is withheld from external credentials) is reported, not thrown", async () => {
    const w = world();
    await joined(w.stateDir);
    const fetch = (async () => json({ error: "forbidden" }, 403)) as unknown as typeof globalThis.fetch;
    const c = cap();
    assert.equal(await runRoomCli(["tasks"], w.env, async () => "", c.io, { fetch }), 1);
    assert.equal(JSON.parse(c.o.join("")).result, "forbidden");
  });

  it("say posts with an idempotency key and only the allowed fields", async () => {
    const w = world();
    await joined(w.stateDir);
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return json({ ok: true }, 201);
    }) as unknown as typeof globalThis.fetch;
    assert.equal(await runRoomCli(["say", "--text", "hello"], w.env, async () => "", cap().io, { fetch }), 0);
    assert.deepEqual(Object.keys(bodies[0] ?? {}).sort(), ["idempotency_key", "text"]);
    assert.match(String(bodies[0]?.idempotency_key), /^pi-[A-Za-z0-9-]+$/);
  });

  it("attach streams, persists the cursor, and detach (abort) stops only the reader", async () => {
    const w = world();
    await joined(w.stateDir);
    const ctl = new AbortController();
    const fetch = (async (url: string, init: RequestInit) => {
      if (url.includes("/events/stream")) {
        const frames = [msg(7, "hello"), { ...msg(8, "x"), event_type: "agent_granted" }];
        const res = sse(frames, { hold: init.signal as AbortSignal });
        setTimeout(() => ctl.abort(), 20);
        return res;
      }
      return json({ events: [], next_cursor: 0, has_more: false });
    }) as unknown as typeof globalThis.fetch;
    const c = cap();
    assert.equal(
      await runRoomCli(["attach"], w.env, async () => "", c.io, { fetch, signal: ctl.signal, sleep: noSleep }),
      0,
    );
    assert.match(c.o.join(""), /ann: hello/);
    assert.ok(!c.o.join("").includes("agent granted")); // simple hides activity
    assert.match(c.e.join(""), /detached at sequence 8; no agent was stopped/);
    assert.equal(loadRoomState(w.stateDir, "r1").cursor, 8);
    assert.equal(JSON.parse(readFileSync(join(w.stateDir, "rooms", "r1.json"), "utf8")).verbosity, "simple");
    assert.equal(statSync(join(w.stateDir, "rooms", "r1.json")).mode & 0o077, 0);
  });

  it("usage errors exit 2", async () => {
    const w = world();
    assert.equal(await runRoomCli([], w.env, async () => "", cap().io), 2);
    assert.equal(await runRoomCli(["nope"], w.env, async () => "", cap().io), 2);
    assert.equal(await runRoomCli(["history", "--verbosity", "loud"], w.env, async () => "", cap().io), 2);
  });
});

describe("INV-013: Pi stands alone without HCN", () => {
  it("with no herdr block or credential every room command is a no-op that never touches the network", async () => {
    const root = mkdtempSync(join(tmpdir(), "room-solo-"));
    const env = {
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_ENGINEERING_STATE_DIR: join(root, "state"),
      HOME: root,
    } as NodeJS.ProcessEnv;
    let fetched = 0;
    const fetch = (async () => {
      fetched++;
      return json({});
    }) as unknown as typeof globalThis.fetch;
    for (const sub of ["list", "history", "catchup", "tasks", "artifacts", "attach"]) {
      const c = cap();
      assert.equal(await runRoomCli([sub], env, async () => "", c.io, { fetch }), 2, sub);
      assert.match(c.o.join(""), /standalone/);
    }
    const slash = await runRoomSlash("rooms", "", env, { fetch });
    assert.match(slash.text, /standalone/);
    // herdr.url set but never joined
    const w = world();
    assert.equal(await runRoomCli(["list"], w.env, async () => "", cap().io, { fetch }), 2);
    assert.equal(fetched, 0);
  });

  it("registering the slash commands opens nothing; an unreachable HCN degrades the slash commands to text", async () => {
    const reg: string[] = [];
    registerRoomCommands({ registerCommand: (n: string) => void reg.push(n) } as never, {});
    assert.deepEqual(reg, ["rooms", "room"]);
    const w = world();
    await joined(w.stateDir);
    const fetch = (async () => {
      throw new TypeError("down");
    }) as unknown as typeof globalThis.fetch;
    const r = await runRoomSlash("room", "catchup", w.env, { fetch });
    assert.match(r.text, /HCN offline/);
    const j = await runRoomSlash("room", "join ABC", w.env, { fetch });
    assert.match(j.text, /--code-file/);
    assert.ok(!j.text.includes("ABC"));
  });

  it("the session ingest stays fire-and-forget when HCN is down, with room scope configured", async () => {
    const ingest = new ControlPlaneIngest({
      url: BASE,
      fetch: (async () => {
        throw new TypeError("down");
      }) as unknown as typeof fetch,
      defaultScope: { roomId: "r1" },
    });
    assert.equal(await ingest.session("s", "session.started", {}), false);
  });
});
