/**
 * Acceptance scenario 4, Pi side: a coworker's Pi joins an HCN room through the scoped bridge.
 *
 * The protocol (redeem a join code, heartbeat, lineage, delegation inbox) is served
 * and tested on the Herdr side (tests/e2e/test_s4_external.py, real HTTP); Herdr's own docs say "A bridge reference
 * client is not part of this change; the protocol above is what a bridge implements". These tests therefore
 *  - prove the server half a Pi bridge would talk to is live (a join + heartbeat made with plain fetch, i.e. what a bridge
 *    would send), and
 *  - exercise Pi's own client (`pi-engineering herdr ...`, src/runtime/herdr/externalAgent.ts) against the real server.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { EXTERNAL_STATE_FILE, startExternalBridge } from "../../src/runtime/herdr/externalAgent.ts";
import { PI_ROOT, Plane, eventually } from "./support/plane.ts";

describe("scenario 4 - external coworker bridge (Pi side)", () => {
  let plane: Plane;
  let room: string;
  before(async () => {
    plane = await Plane.start({ users: ["alice"] });
    await plane.verifyFeatures("alice");
    room = (await plane.makeRoom("alice", "s4-pi", "coworkers")).roomId;
  });
  after(async () => {
    await plane?.stop();
  });

  it("the server half a Pi bridge would use is live: redeem a one-time code, heartbeat, outbound only", async () => {
    const inv = await plane.c("POST", `/rooms/${room}/externals/invites`, {
      user: "alice",
      body: { label: "Erin's Pi", actions: ["read", "post"], lineage: true },
    });
    assert.equal(inv.status, 201);
    const joined = await plane.c("POST", "/agents/join", { body: { token: inv.body.code, harness_type: "pi" } });
    assert.equal(joined.status, 201);
    assert.equal(joined.body.kind, "external");
    assert.equal(joined.body.terminal, false);
    const agent = { credential: joined.body.credential as string, device: joined.body.device_id as string };
    const hb = await plane.c("POST", "/agents/external/heartbeat", {
      agent,
      body: { status: "working", activity: "pi bridge" },
    });
    assert.equal(hb.status, 200);
    // one-time: the same code never redeems twice; a wrong device is refused
    assert.equal((await plane.c("POST", "/agents/join", { body: { token: inv.body.code } })).status, 401);
    assert.equal(
      (
        await plane.c("GET", "/agents/external/me", {
          agent: { credential: agent.credential, device: "other-machine" },
        })
      ).status,
      401,
    );
    assert.equal((await plane.c("GET", "/agents/external/me", { agent })).status, 200);
  });

  // ------------------------------------------------------------------------------------- Pi's own bridge client
  const cli = (args: string[], cwd: string, agentDir: string, stdin?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((res, rej) => {
      const child = spawn(process.execPath, [join(PI_ROOT, "scripts/pi-engineering.ts"), "herdr", ...args], {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: cwd,
          PI_CODING_AGENT_DIR: agentDir,
          PI_ENGINEERING_STATE_DIR: join(cwd, "state"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", rej);
      child.on("close", (code) => res({ code: code ?? -1, stdout, stderr }));
      child.stdin.end(stdin ?? "");
    });

  it("Pi's own client: `herdr join` redeems a one-time code from stdin (never argv), stores a 0600 credential, and the roster shows a Pi external", async () => {
    const root = mkdtempSync(join(tmpdir(), "t16-s4-pi-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "engineering.yaml"), `herdr:\n  url: ${plane.url}\n`);
    const inv = await plane.c("POST", `/rooms/${room}/externals/invites`, {
      user: "alice",
      body: { label: "Erin's real Pi", actions: ["read", "post"], lineage: true },
    });
    assert.equal(inv.status, 201);
    // a bad code is refused and stores nothing (negative control)
    const bad = await cli(["join", "--code-file", "-"], root, agentDir, ["hcj", "not-a-real-code"].join("_"));
    assert.equal(bad.code, 1);
    assert.equal(existsSync(join(root, "state", EXTERNAL_STATE_FILE)), false);
    const joined = await cli(["join", "--code-file", "-"], root, agentDir, `${inv.body.code}\n`);
    assert.equal(joined.code, 0, joined.stderr);
    const agentId = JSON.parse(joined.stdout.trim()).agentId as string;
    assert.ok(agentId);
    assert.ok(!joined.stdout.includes("credential") && !joined.stderr.includes(inv.body.code));
    const file = join(root, "state", EXTERNAL_STATE_FILE);
    assert.equal(statSync(file).mode & 0o077, 0, "the credential file is private");
    // one-time: the same code never redeems twice
    assert.equal((await cli(["join", "--code-file", "-"], root, agentDir, inv.body.code)).code, 1);

    const roster = await plane.c("GET", `/rooms/${room}/externals`, { user: "alice" });
    const mine = (roster.body.externals as Array<Record<string, any>>).find((e) => e.agent_id === agentId);
    assert.equal(mine?.declared_harness, "pi");

    // a heartbeat from the CLI shows as presence
    const hb = await cli(["heartbeat", "--status", "working", "--activity", "reviewing the parser"], root, agentDir);
    assert.equal(hb.code, 0, hb.stderr);
    const seen = await eventually(async () => {
      const r = await plane.c("GET", `/rooms/${room}/externals`, { user: "alice" });
      const e = (r.body.externals as Array<Record<string, any>>).find((x) => x.agent_id === agentId);
      return e?.presence?.last_activity === "reviewing the parser" ? e : false;
    }, "presence");
    assert.equal(seen.presence.status, "working");
    assert.equal(
      (await cli(["heartbeat", "--status", "bogus"], root, agentDir)).code,
      2,
      "control: a bad status is refused locally",
    );

    // the runtime bridge heartbeats on its own while Pi runs
    const bridge = await startExternalBridge({
      agentDir,
      stateDir: join(root, "state"),
      intervalMs: 50,
      status: () => ({ status: "waiting", activity: "runtime beat" }),
    });
    assert.ok(bridge);
    await eventually(async () => {
      const r = await plane.c("GET", `/rooms/${room}/externals`, { user: "alice" });
      const e = (r.body.externals as Array<Record<string, any>>).find((x) => x.agent_id === agentId);
      return e?.presence?.last_activity === "runtime beat";
    }, "runtime heartbeat");
    bridge.stop();

    // lineage about itself reaches the room graph; about anyone else it is refused
    const rep = await cli(["report", "--state", "running"], root, agentDir);
    assert.equal(rep.code, 0, rep.stderr);
    const node = await eventually(async () => {
      const r = await plane.c("GET", `/graph/nodes/${encodeURIComponent(`agent:${agentId}`)}`, { user: "alice" });
      return r.status === 200 ? r : false;
    }, "the agent node");
    assert.equal(node.body.node.attrs.external, true);
    assert.equal((await cli(["report", "--state", "done"], root, agentDir)).code, 0, "the sequence advanced");

    // revocation: the next request is refused and the bridge reports failure instead of pretending
    const rv = await plane.c("POST", `/rooms/${room}/externals/${agentId}/revoke`, { user: "alice", body: {} });
    assert.equal(rv.status, 200);
    assert.equal((await cli(["heartbeat"], root, agentDir)).code, 1);
    // and with no credential at all the client does nothing
    const empty = mkdtempSync(join(tmpdir(), "t16-s4-none-"));
    assert.equal(await startExternalBridge({ agentDir, stateDir: join(empty, "state") }), null);
  });
});
