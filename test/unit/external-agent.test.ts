import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  EXTERNAL_STATE_FILE,
  ExternalAgentClient,
  ExternalAgentError,
  startExternalBridge,
} from "../../src/runtime/herdr/externalAgent.ts";

const CRED = ["cred", String(process.pid), "x"].join("-");
const tmp = () => mkdtempSync(join(tmpdir(), "ext-agent-"));
interface Call {
  url: string;
  init: RequestInit;
}
const fakeFetch = (calls: Call[], answer: (c: Call) => Response) =>
  (async (url: string, init: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    return answer(c);
  }) as unknown as typeof fetch;
const joinReply = () =>
  new Response(JSON.stringify({ agent_id: "ag1", credential: CRED, device_id: "dev1", room_id: "r1" }), {
    status: 201,
  });

describe("external agent client", () => {
  it("join sends only the code, stores a private credential, and later calls carry Agent auth + device", async () => {
    const dir = tmp();
    const calls: Call[] = [];
    const f = fakeFetch(calls, (c) => (c.url.endsWith("/agents/join") ? joinReply() : new Response("{}")));
    const client = await ExternalAgentClient.join("http://127.0.0.1:1", ["hcj", "code"].join("_"), dir, { fetch: f });
    assert.equal(JSON.parse(String(calls[0]?.init.body)).token, ["hcj", "code"].join("_"));
    assert.equal(calls[0]?.init.redirect, "error");
    assert.equal(statSync(join(dir, EXTERNAL_STATE_FILE)).mode & 0o077, 0);
    await client.heartbeat("working", "x".repeat(300));
    const h = calls[1]?.init.headers as Record<string, string>;
    assert.equal(h.Authorization, `Agent ${CRED}`);
    assert.equal(h["X-Herdr-Device"], "dev1");
    assert.equal(JSON.parse(String(calls[1]?.init.body)).activity.length, 140);
  });

  it("the lineage sequence advances only after Herdr accepted the event, and survives a reload", async () => {
    const dir = tmp();
    const calls: Call[] = [];
    let fail = false;
    const f = fakeFetch(calls, (c) =>
      c.url.endsWith("/agents/join") ? joinReply() : fail ? new Response("no", { status: 500 }) : new Response("{}"),
    );
    const client = await ExternalAgentClient.join("http://127.0.0.1:1", "c", dir, { fetch: f });
    await client.reportSelf("running");
    fail = true;
    await assert.rejects(client.reportSelf("done"), ExternalAgentError);
    fail = false;
    await client.reportSelf("done");
    const seqs = calls
      .filter((c) => c.url.endsWith("/lineage"))
      .map((c) => JSON.parse(String(c.init.body)).source_sequence);
    assert.deepEqual(seqs, [0, 1, 1], "the failed send is retried with the same sequence");
    const again = ExternalAgentClient.fromState(dir, { fetch: f });
    await again?.reportSelf("running");
    const last = JSON.parse(String(calls[calls.length - 1]?.init.body));
    assert.equal(last.source_sequence, 2);
    assert.equal(last.event_id, "pi-ag1-2");
  });

  it("a refused join stores nothing; no credential or no herdr.url starts no bridge and sends nothing", async () => {
    const dir = tmp();
    const calls: Call[] = [];
    const f = fakeFetch(calls, () => new Response("{}", { status: 401 }));
    await assert.rejects(ExternalAgentClient.join("http://127.0.0.1:1", "bad", dir, { fetch: f }), /HTTP 401/);
    assert.equal(ExternalAgentClient.fromState(dir), null);
    const agentDir = tmp();
    assert.equal(await startExternalBridge({ agentDir, stateDir: dir, fetch: f }), null);
    // a credential but no herdr block: still nothing
    const ok = fakeFetch(calls, () => joinReply());
    await ExternalAgentClient.join("http://127.0.0.1:1", "c", dir, { fetch: ok });
    const before = calls.length;
    assert.equal(await startExternalBridge({ agentDir, stateDir: dir, fetch: f }), null);
    assert.equal(calls.length, before);
  });

  it("the bridge heartbeats at once, and a 401 stops it", async () => {
    const dir = tmp();
    const agentDir = tmp();
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "engineering.yaml"), "herdr:\n  url: http://127.0.0.1:1\n");
    const calls: Call[] = [];
    let revoked = false;
    const f = fakeFetch(calls, (c) =>
      c.url.endsWith("/agents/join") ? joinReply() : new Response("{}", { status: revoked ? 401 : 200 }),
    );
    await ExternalAgentClient.join("http://127.0.0.1:1", "c", dir, { fetch: f });
    const bridge = await startExternalBridge({ agentDir, stateDir: dir, fetch: f, intervalMs: 10 });
    assert.ok(bridge);
    await new Promise((r) => setTimeout(r, 80));
    revoked = true;
    await new Promise((r) => setTimeout(r, 80));
    const beats = calls.filter((c) => c.url.endsWith("/heartbeat")).length;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.filter((c) => c.url.endsWith("/heartbeat")).length, beats, "stopped after the 401");
    assert.ok(beats >= 2);
    bridge.stop();
  });
  describe("the stored credential is trusted only when it is safe", () => {
    const joined = async (calls: Call[]) => {
      const dir = tmp();
      const f = fakeFetch(calls, (c) => (c.url.endsWith("/agents/join") ? joinReply() : new Response("{}")));
      await ExternalAgentClient.join("http://127.0.0.1:1", "c", dir, { fetch: f });
      return { dir, f };
    };

    it("a group/world-accessible file is refused, even with the right contents", async () => {
      const { dir } = await joined([]);
      chmodSync(join(dir, EXTERNAL_STATE_FILE), 0o666);
      assert.equal(ExternalAgentClient.fromState(dir), null);
      chmodSync(join(dir, EXTERNAL_STATE_FILE), 0o640);
      assert.equal(ExternalAgentClient.fromState(dir), null);
      chmodSync(join(dir, EXTERNAL_STATE_FILE), 0o600);
      assert.ok(ExternalAgentClient.fromState(dir));
    });

    it("a symlink, a directory and an oversized file are refused", async () => {
      const { dir } = await joined([]);
      const real = join(dir, "real.json");
      writeFileSync(real, readFileSync(join(dir, EXTERNAL_STATE_FILE)), { mode: 0o600 });
      const linked = tmp();
      symlinkSync(real, join(linked, EXTERNAL_STATE_FILE));
      assert.equal(ExternalAgentClient.fromState(linked), null);
      const big = tmp();
      const body = JSON.parse(readFileSync(real, "utf8"));
      writeFileSync(join(big, EXTERNAL_STATE_FILE), JSON.stringify({ ...body, pad: "x".repeat(10000) }), {
        mode: 0o600,
      });
      assert.equal(ExternalAgentClient.fromState(big), null);
      const asDir = tmp();
      mkdirSync(join(asDir, EXTERNAL_STATE_FILE), { mode: 0o700 });
      assert.equal(ExternalAgentClient.fromState(asDir), null);
    });

    it("a stored baseUrl that is not the YAML herdr.url is never sent the credential", async () => {
      const calls: Call[] = [];
      const { dir } = await joined(calls);
      const file = join(dir, EXTERNAL_STATE_FILE);
      const evil = { ...JSON.parse(readFileSync(file, "utf8")), baseUrl: "http://evil.example" };
      writeFileSync(file, JSON.stringify(evil), { mode: 0o600 });
      assert.equal(ExternalAgentClient.fromState(dir, {}, "http://127.0.0.1:1"), null);
      const agentDir = tmp();
      writeFileSync(join(agentDir, "engineering.yaml"), "herdr:\n  url: http://127.0.0.1:1\n");
      const seen: Call[] = [];
      const spy = fakeFetch(seen, () => new Response("{}"));
      assert.equal(await startExternalBridge({ agentDir, stateDir: dir, fetch: spy }), null);
      assert.equal(seen.length, 0, "nothing was sent anywhere");
    });

    it("no error message carries the credential, and leave forgets it", async () => {
      const dir = tmp();
      const f = fakeFetch([], (c) =>
        c.url.endsWith("/agents/join") ? joinReply() : new Response(`bad ${CRED}`, { status: 500 }),
      );
      const client = await ExternalAgentClient.join("http://127.0.0.1:1", "c", dir, { fetch: f });
      await assert.rejects(client.heartbeat("working", "x"), (e: Error) => !e.message.includes(CRED));
      const bad = fakeFetch([], () => new Response(CRED, { status: 400 }));
      await assert.rejects(
        ExternalAgentClient.join("http://127.0.0.1:1", "c", tmp(), { fetch: bad }),
        (e: Error) => !e.message.includes(CRED),
      );
      const ok = fakeFetch([], () => new Response("{}"));
      const c2 = ExternalAgentClient.fromState(dir, { fetch: ok });
      assert.ok(c2);
      await c2.leave();
      assert.equal(ExternalAgentClient.fromState(dir), null, "the credential is gone after leave");
      assert.ok(!readFileSync(join(dir, EXTERNAL_STATE_FILE), "utf8").includes(CRED));
    });
  });
});
