// /room against a REAL Herdr control plane (ControlPlaneServer + CollabService on loopback), not a fake.
// Gated: runs only when the gitignored test/fixtures/room-live.local.yaml names a Herdr checkout (herdr_src) and a
// python (default python3) that can import it; otherwise it skips cleanly. The server is test/fixtures/herdr-live-room-server.py: random user token written to a
// 0600 file, in-memory repo, bound to 127.0.0.1:<ephemeral>, killed by exact PID in after(). No production host is touched.
delete process.env.HERDR_DISABLED;

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readYaml } from "../../src/lifecycle/policy.ts";
import { runRoomCommand } from "../../src/runtime/herdr/roomClient.ts";

// Local, optional, gitignored config (no environment variables): test/fixtures/room-live.local.yaml
//   herdr_src: /abs/path/to/herdr-engineering   # a Herdr checkout
//   python: /abs/path/to/python                 # optional, default python3; must have Herdr's dependencies
const LOCAL = join(import.meta.dirname, "..", "fixtures", "room-live.local.yaml");
const cfg = existsSync(LOCAL) ? ((await readYaml(LOCAL)).raw as Record<string, unknown> | null) : null;
const SRC = typeof cfg?.herdr_src === "string" ? cfg.herdr_src : "";
const PYTHON = typeof cfg?.python === "string" ? cfg.python : "python3";
const available =
  SRC !== "" &&
  spawnSync(PYTHON, ["-I", "-c", "import herdr_engineering.control_plane.collab"], {
    env: { PYTHONPATH: SRC, PATH: process.env.PATH ?? "" },
  }).status === 0;

interface Ready {
  base: string;
  room: string;
  agent_id: string;
  agent_name: string;
}

describe(
  "/room against the real Herdr control plane",
  { skip: !available && "test/fixtures/room-live.local.yaml absent or Herdr not importable" },
  () => {
    let child: ChildProcess;
    let dir = "";
    let ready: Ready;
    let token = "";

    const api = async (path: string, init: RequestInit = {}): Promise<{ status: number; json: any }> => {
      const res = await fetch(`${ready.base}/api/v1/collab${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), "room-live-"));
      const keyFile = join(dir, "key");
      child = spawn(PYTHON, ["-I", join(import.meta.dirname, "..", "fixtures", "herdr-live-room-server.py"), keyFile], {
        env: { PYTHONPATH: SRC, PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "inherit"],
      });
      ready = await new Promise<Ready>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("control plane did not start")), 30_000);
        child.stdout?.on("data", (c) => {
          buf += c;
          const nl = buf.indexOf("\n");
          if (nl >= 0) {
            clearTimeout(timer);
            resolve(JSON.parse(buf.slice(0, nl)) as Ready);
          }
        });
        child.once("exit", () => reject(new Error("control plane exited")));
      });
      chmodSync(keyFile, 0o600);
      token = readFileSync(keyFile, "utf8").trim();
      writeFileSync(
        join(dir, "engineering.yaml"),
        `herdr:\n  url: ${ready.base}\n  api_key_file: ${keyFile}\n  room_id: ${ready.room}\n`,
      );
    });
    after(() => {
      child?.kill("SIGTERM"); // the exact child PID we spawned
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("status renders the live room: agent roster, empty attention inbox, the real graph link", async () => {
      const out = await runRoomCommand("", { agentDir: dir });
      assert.equal(out.level, "info", out.text);
      assert.match(out.text, new RegExp(`Room ${ready.room} \\(seq \\d+\\)`));
      assert.ok(out.text.includes(`${ready.agent_name} [pi] ${ready.agent_id}`), out.text);
      assert.match(out.text, /Attention \(0 open\)/);
      assert.match(out.text, /nothing needs you/);
      assert.ok(out.text.includes(`Full graph: ${ready.base}/#/room/${ready.room}`));
      assert.ok(!out.text.includes(token));
    });

    it("rooms lists the room the key can read", async () => {
      const out = await runRoomCommand("rooms", { agentDir: dir });
      assert.ok(out.text.includes(`${ready.room}  Pi live room  (owner)`), out.text);
    });

    it("say lands in the room's event log; a replay with the same key does not post twice", async () => {
      const first = await runRoomCommand("say hello from pi", { agentDir: dir, newKey: () => "pi-room-live-say" });
      assert.match(first.text, /Posted to the room \(event \d+\)\./, first.text);
      const again = await runRoomCommand("say hello from pi", { agentDir: dir, newKey: () => "pi-room-live-say" });
      assert.match(again.text, /Already posted/);
      const events = await api(`/rooms/${ready.room}/events?cursor=0&limit=200`);
      assert.equal(events.status, 200);
      const msgs = (events.json.events as any[]).filter(
        (e) => e.event_type === "message" && e.text === "hello from pi",
      );
      assert.equal(msgs.length, 1, "exactly one message server-side");
      assert.equal(msgs[0].sender.id, "alice");
    });

    it("assign creates one task for the named agent; the live state and flow graph show it", async () => {
      const out = await runRoomCommand(`assign ${ready.agent_name} run the live check`, {
        agentDir: dir,
        newKey: () => "pi-room-live-task",
      });
      assert.match(out.text, new RegExp(`assigned to ${ready.agent_id}\\.`), out.text);
      const dup = await runRoomCommand(`assign ${ready.agent_name} run the live check`, {
        agentDir: dir,
        newKey: () => "pi-room-live-task",
      });
      assert.match(dup.text, /\(already existed\)/);
      const state = await api(`/rooms/${ready.room}/state?since=-1&cursor=0&wait=0`);
      const tasks = state.json.tasks as any[];
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].target_agent_id, ready.agent_id);
      assert.equal(tasks[0].text, "run the live check");
      assert.equal(state.json.flow.tasks.length, 1, "the room graph has the task edge");
      const view = await runRoomCommand("status", { agentDir: dir });
      assert.match(view.text, /\[pending\] .*: run the live check/);
    });

    it("refusals carry the server's reason; unknown agent and wrong key are rejected", async () => {
      const ghost = await runRoomCommand("assign ghost do it", { agentDir: dir });
      assert.match(ghost.text, /no agent "ghost"/);
      const nope = await runRoomCommand("--room room_nope status", { agentDir: dir });
      assert.match(nope.text, /HTTP 404.*: not found/);
      const wrong = await fetch(`${ready.base}/api/v1/collab/rooms`, { headers: { Authorization: "Bearer nope" } });
      assert.equal(wrong.status, 401);
      const apiKeyHeader = await fetch(`${ready.base}/api/v1/collab/rooms`, { headers: { "X-API-Key": token } });
      assert.equal(apiKeyHeader.status, 401, "only `Authorization: Bearer` is accepted");
    });
  },
);
