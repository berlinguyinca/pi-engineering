// Needs the real YAML connection loader, so it opts back in (isolatedState.ts sets HERDR_DISABLED by default).
delete process.env.HERDR_DISABLED;

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanForTerminal, renderRoomView, runRoomCommand } from "../../src/runtime/herdr/roomClient.ts";

const KEY = "sk-room-test-0123456789abcdef";

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown> | null;
}

let server: Server;
let base = "";
let dir = "";
const seen: Seen[] = [];
const posted = new Map<string, string>(); // idempotency key -> task id
let failTransportOnce = false;
let failOnlyMethod: string | null = null;
let redirect = false;

const ROOM_STATE = {
  seq: 7,
  changed: true,
  agents: [
    { agent_id: "ag-1", name: "pi-laptop", harness_type: "pi", online: true, address: "pi-laptop@room" },
    { agent_id: "ag-2", name: "claude-a", harness_type: "claude", online: false },
    { agent_id: "ag-3", name: "claude-b", harness_type: "claude", online: true },
  ],
  tasks: [
    {
      task_id: "t-1",
      target_name: "pi-laptop",
      status: "accepted",
      text: "build the thing\u001b[31m RED\u001b[0m\u0007",
      parent_task_id: null,
    },
    { task_id: "t-2", target_name: "claude-b", status: "pending", text: "review it", parent_task_id: "t-1" },
  ],
  missions: [{ mission_id: "m-77" }],
};
const ATTENTION = {
  items: [{ severity: "error", category: "ci_failed", title: "CI failed", subject: "pr#12" }],
  counts: { open: 1 },
};

function handle(req: IncomingMessage, res: ServerResponse): void {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    const url = new URL(req.url ?? "/", base);
    const entry: Seen = {
      method: req.method ?? "",
      path: url.pathname,
      auth: req.headers.authorization,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    };
    seen.push(entry);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (failTransportOnce && (failOnlyMethod === null || failOnlyMethod === req.method)) {
      failTransportOnce = false;
      req.socket.destroy();
      return;
    }
    if (redirect) {
      res.writeHead(302, { Location: "http://127.0.0.1:1/steal" });
      res.end();
      return;
    }
    if (entry.auth !== `Bearer ${KEY}`) return json(401, { error: "unauthorized" });
    const p = url.pathname;
    if (req.method === "GET" && p === "/api/v1/collab/rooms/room-1/state") return json(200, ROOM_STATE);
    if (req.method === "GET" && p === "/api/v1/collab/rooms/room-1/attention") return json(200, ATTENTION);
    if (req.method === "GET" && p === "/api/v1/collab/rooms")
      return json(200, { rooms: [{ id: "room-1", name: "Main" }] });
    if (req.method === "POST" && p === "/api/v1/collab/rooms/room-1/messages") return json(201, { ok: true });
    if (req.method === "POST" && p === "/api/v1/collab/rooms/room-1/tasks") {
      const key = String(entry.body?.idempotency_key);
      const replayed = posted.has(key);
      if (!replayed) posted.set(key, `task-${posted.size + 1}`);
      return json(201, { task_id: posted.get(key), status: "pending", ...(replayed ? { replayed: true } : {}) });
    }
    json(404, { error: "not found" });
  });
}

before(async () => {
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), "room-"));
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  writeFileSync(
    join(dir, "engineering.yaml"),
    `herdr:\n  url: ${base}\n  api_key_file: ${keyFile}\n  room_id: room-1\n`,
  );
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  seen.length = 0;
  failTransportOnce = false;
  failOnlyMethod = null;
  redirect = false;
});

describe("/room over the authenticated Herdr API", () => {
  it("shows the project tree, agents, attention inbox and the graph link, with credentials from the YAML block", async () => {
    const out = await runRoomCommand("", { agentDir: dir });
    assert.equal(out.level, "info");
    assert.match(out.text, /Room room-1 \(seq 7\)/);
    assert.match(out.text, /mission m-77/);
    assert.match(out.text, /\[accepted\] pi-laptop: build the thing RED/);
    assert.match(out.text, /└ \[pending\] claude-b: review it/, "child task nests under its parent");
    assert.match(out.text, /● pi-laptop \[pi\] ag-1/);
    assert.match(out.text, /○ claude-a/);
    assert.match(out.text, /\[error\] CI failed — pr#12/);
    assert.match(out.text, new RegExp(`Full graph: ${base.replace(/[.:/]/g, "\\$&")}/#/collab\\?room=room-1`));
    assert.ok(seen.every((s) => s.auth === `Bearer ${KEY}`));
    assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`).sort(), [
      "GET /api/v1/collab/rooms/room-1/attention",
      "GET /api/v1/collab/rooms/room-1/state",
    ]);
    assert.ok(!out.text.includes(KEY), "the key is never printed");
  });

  it("terminal escapes in server text are stripped", async () => {
    const out = await runRoomCommand("", { agentDir: dir });
    assert.ok(
      [...out.text].every((ch) => ch === "\n" || ch.charCodeAt(0) >= 32),
      "no control characters reach the terminal",
    );
    assert.equal(cleanForTerminal("a\u001b]0;evil\u0007b"), "ab");
    assert.equal(cleanForTerminal("x\u001b[2Jy"), "xy");
  });

  it("say posts with an idempotency key and does nothing else", async () => {
    const out = await runRoomCommand("say hello team", { agentDir: dir, newKey: () => "pi-room-k1" });
    assert.equal(out.level, "info");
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.body, { text: "hello team", idempotency_key: "pi-room-k1" });
  });

  it("a transport failure is retried ONCE with the same idempotency key (cannot double-post)", async () => {
    failTransportOnce = true;
    failOnlyMethod = "POST";
    const out = await runRoomCommand("say retry me", { agentDir: dir, newKey: () => "pi-room-k2" });
    assert.equal(out.level, "info", out.text);
    const posts = seen.filter((s) => s.method === "POST");
    assert.equal(posts.length, 2, "the dropped attempt and exactly one retry");
    assert.deepEqual(posts[0]!.body, posts[1]!.body);
    assert.equal(posts[1]!.body?.idempotency_key, "pi-room-k2");
  });

  it("assign resolves a name to the agent id and replays idempotently", async () => {
    const first = await runRoomCommand("assign pi-laptop build it", { agentDir: dir, newKey: () => "pi-room-k3" });
    const second = await runRoomCommand("assign pi-laptop build it", { agentDir: dir, newKey: () => "pi-room-k3" });
    assert.match(first.text, /Task task-\d+ assigned to ag-1\./);
    assert.match(second.text, /\(already existed\)/);
    const bodies = seen.filter((s) => s.path.endsWith("/tasks")).map((s) => s.body);
    assert.deepEqual(bodies[0], { target_agent_id: "ag-1", text: "build it", idempotency_key: "pi-room-k3" });
  });

  it("an ambiguous or unknown agent is refused before anything is posted", async () => {
    const amb = await runRoomCommand("assign claude do it", { agentDir: dir });
    assert.equal(amb.level, "error");
    assert.match(amb.text, /matches 2 agents/);
    const none = await runRoomCommand("assign ghost do it", { agentDir: dir });
    assert.match(none.text, /no agent "ghost"/);
    assert.equal(seen.filter((s) => s.method === "POST").length, 0);
  });

  it("closing the TUI cancels nothing: no command ever calls a cancel/stop route", async () => {
    await runRoomCommand("", { agentDir: dir });
    await runRoomCommand("say hi", { agentDir: dir });
    await runRoomCommand("rooms", { agentDir: dir });
    assert.ok(seen.every((s) => !/cancel|stop|leave|revoke/.test(s.path)));
  });

  it("a wrong key surfaces the status, never the key", async () => {
    const other = mkdtempSync(join(tmpdir(), "room-bad-"));
    try {
      const keyFile = join(other, "key");
      writeFileSync(keyFile, "sk-WRONG-0123456789\n", { mode: 0o600 });
      writeFileSync(
        join(other, "engineering.yaml"),
        `herdr:\n  url: ${base}\n  api_key_file: ${keyFile}\n  room_id: room-1\n`,
      );
      const out = await runRoomCommand("", { agentDir: other });
      assert.equal(out.level, "error");
      assert.match(out.text, /HTTP 401/);
      assert.ok(!out.text.includes("sk-WRONG"));
      assert.ok(!out.text.includes(KEY));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("redirects are refused (the key never follows a Location)", async () => {
    redirect = true;
    const out = await runRoomCommand("", { agentDir: dir });
    assert.equal(out.level, "error");
    assert.equal(seen.length >= 1, true);
    assert.ok(seen.every((s) => s.path.startsWith("/api/v1/collab")));
  });

  it("no herdr block, no key, or no room id = a plain instruction, no network", async () => {
    const empty = mkdtempSync(join(tmpdir(), "room-empty-"));
    try {
      await new Promise((r) => setTimeout(r, 50)); // let a previous test's background retry land first
      seen.length = 0;
      const none = await runRoomCommand("", { agentDir: empty });
      assert.equal(none.level, "warning");
      assert.match(none.text, /herdr:/);
      writeFileSync(join(empty, "engineering.yaml"), `herdr:\n  url: ${base}\n`);
      assert.match((await runRoomCommand("", { agentDir: empty })).text, /api_key_file/);
      assert.equal(seen.length, 0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("--room overrides the configured room; rooms lists", async () => {
    const out = await runRoomCommand("rooms", { agentDir: dir });
    assert.match(out.text, /room-1\s+Main/);
    const nope = await runRoomCommand("--room room-2", { agentDir: dir });
    assert.match(nope.text, /HTTP 404/);
  });

  it("renderRoomView is bounded for large rooms", () => {
    const tasks = Array.from({ length: 500 }, (_, i) => ({
      task_id: `t-${i}`,
      target_name: "a",
      status: "pending",
      text: "x",
      parent_task_id: null,
    }));
    const text = renderRoomView({ agents: [], tasks, missions: [] }, null, "http://x/#g", "r");
    assert.ok(text.split("\n").length < 80);
    assert.match(text, /460 more task\(s\) in Herdr/);
    assert.match(text, /Attention: unavailable/);
  });
});
