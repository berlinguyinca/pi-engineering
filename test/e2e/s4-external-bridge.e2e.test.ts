/**
 * Acceptance scenario 4, Pi side: a coworker's Pi joins an HCN room through the scoped bridge.
 *
 * FINDING: Pi ships NO bridge client. The protocol (redeem a join code, heartbeat, lineage, delegation inbox) is served
 * and tested on the Herdr side (tests/e2e/test_s4_external.py, real HTTP); Herdr's own docs say "A bridge reference
 * client is not part of this change; the protocol above is what a bridge implements". These tests therefore
 *  - prove the server half a Pi bridge would talk to is live (a join + heartbeat made with plain fetch, i.e. what a bridge
 *    would send), and
 *  - GAP: assert the CURRENT absence of any Pi code that does it, so the day a client lands this test fails and is replaced.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { allSources, mentions } from "./support/codeGraph.ts";
import { PI_ROOT, Plane } from "./support/plane.ts";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|mjs|js|sh)$/.test(name)) out.push(p);
  }
  return out;
}

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

  it("GAP: Pi has no bridge client - nothing under src/, extensions/ or scripts/ speaks the join/heartbeat protocol", () => {
    const needles = ["agents/join", "agents/external", "externals/invites", "hcj_"];
    const re = new RegExp(needles.map((n) => n.replace(/[/.]/g, "\\$&")).join("|"));
    // structural: no TypeScript module under src/, extensions/ or scripts/ has a string literal or identifier naming
    // the bridge endpoints; non-TS files (shell, js) are scanned as text because there is no parser for them
    const hits = mentions(allSources(["src", "extensions", "scripts"]), re);
    for (const dir of ["src", "extensions", "scripts"]) {
      for (const file of sources(join(PI_ROOT, dir)).filter((f) => !f.endsWith(".ts"))) {
        if (needles.some((n) => readFileSync(file, "utf8").includes(n))) hits.push(file);
      }
    }
    // CURRENT behaviour: no client exists. When one lands this fails; replace it with a real-client test against Plane.
    assert.deepEqual(hits, []);
  });
});
