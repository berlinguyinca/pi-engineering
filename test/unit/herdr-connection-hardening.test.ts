/**
 * T16 review round: the Herdr connection rules, each one pinned on its own so that dropping a single clause fails a
 * test: URL scheme/host/userinfo/query/fragment, key-file mode/owner/size, and "redirects are refused" on every path
 * that carries the API key.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemorySteeringLedger } from "../../src/orchestration/steering.ts";
import { SteeringReceiver } from "../../src/runtime/herdr/SteeringReceiver.ts";
import {
  checkHerdrUrl,
  createIngestFromConnection,
  keyFileStatProblem,
} from "../../src/runtime/herdr/herdrConnection.ts";
import { createLineageFromConnection } from "../../src/runtime/herdr/lineageConfig.ts";

const seg = (...p: string[]) => p.join("");

test("URL rule: every clause rejects on its own", () => {
  const bad: Record<string, string> = {
    "plain http, remote host": "http://cp.example",
    "http with a loopback-looking suffix": "http://127.0.0.1.evil.example",
    "http with a loopback-looking prefix": "http://localhost.evil.example",
    "http on 0.0.0.0": "http://0.0.0.0:8080",
    "http on another v6 address": "http://[::2]:8080",
    "user only": seg("https://", "name", "@cp.example"),
    "password only": seg("https://", ":", "pw", "@cp.example"),
    query: "https://cp.example/?q=1",
    "empty query": "https://cp.example/?",
    fragment: "https://cp.example/#f",
    "other scheme": "ftp://cp.example",
    ws: "ws://127.0.0.1",
    "not a url": "cp.example",
    empty: "",
  };
  for (const [why, url] of Object.entries(bad)) assert.equal(checkHerdrUrl(url), null, `${why}: ${url}`);
  for (const good of [
    "https://cp.example",
    "https://cp.example:8443/base",
    "http://127.0.0.1:8080",
    "http://localhost",
    "http://[::1]:9",
  ]) {
    assert.ok(checkHerdrUrl(good), good);
  }
});

test("key file rule: owner, group/other bits, type and size are each enforced", () => {
  const ok = { mode: 0o100600, uid: 1000, size: 40, isFile: () => true };
  assert.equal(keyFileStatProblem(ok, 1000), null);
  assert.match(keyFileStatProblem({ ...ok, uid: 0 }, 1000) ?? "", /owned by the current user/);
  assert.equal(keyFileStatProblem({ ...ok, uid: 0 }, undefined), null, "no uid on this platform: owner not checked");
  for (const bit of [0o040, 0o020, 0o010, 0o004, 0o002, 0o001]) {
    assert.match(
      keyFileStatProblem({ ...ok, mode: 0o100600 | bit }, 1000) ?? "",
      /group or others/,
      `bit ${bit.toString(8)}`,
    );
  }
  assert.match(keyFileStatProblem({ ...ok, isFile: () => false }, 1000) ?? "", /regular file/);
  assert.match(keyFileStatProblem({ ...ok, size: 4097 }, 1000) ?? "", /too large/);
  assert.equal(keyFileStatProblem({ ...ok, size: 4096 }, 1000), null);
});

test("redirects are refused on every request that carries the key", async () => {
  const seen: Array<{ who: string; redirect: string | undefined }> = [];
  const expired = {
    steering: [
      {
        steering_id: "st-expired",
        action: "redirect",
        target: { node_id: "task:t1" },
        instruction: "x",
        proposed_by: { id: "a" },
        confirmed_by: { id: "b" },
        room: { id: "r" },
        trust: "untrusted",
        valid_until_epoch: 1,
      },
    ],
  };
  const spy = (who: string) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ who: String(input).includes("/ack") ? `${who}-ack` : who, redirect: init?.redirect });
      return new Response(String(input).includes("/pending") ? JSON.stringify(expired) : "{}", { status: 200 });
    }) as typeof globalThis.fetch;
  const conn = { baseUrl: "https://cp.example", apiKey: "k-for-test", lineage: true as const };
  const dir = await mkdtemp(join(tmpdir(), "herdr-redir-"));

  const ingest = createIngestFromConnection(conn, "host-1", { fetch: spy("ingest") });
  await ingest.emit("mission", "m1", "mission.started", {});

  const lineage = createLineageFromConnection(conn, "host-1", { fetch: spy("lineage"), envelopeDir: join(dir, "env") });
  assert.ok(lineage);
  lineage.workerSpawned({ agent: "lead", attempt: "lead.1", transition: "t" });
  await lineage.idle();

  const rx = new SteeringReceiver({
    baseUrl: conn.baseUrl,
    apiKey: conn.apiKey,
    ports: {
      now: () => 10_000,
      resolve: () => ({ kind: "task" as const, taskId: "t1", missionId: "m1", running: true, terminal: false }),
      steerRunning: () => "delivered",
      resumeMission: async () => ({ changed: false }),
    },
    ledger: new MemorySteeringLedger(),
    fetch: spy("steering-poll"),
  });
  await rx.pollOnce();
  await writeFile(join(dir, "unused"), "");

  for (const who of ["ingest", "lineage", "steering-poll", "steering-poll-ack"]) {
    const calls = seen.filter((s) => s.who === who);
    assert.ok(calls.length > 0, `${who} made a request`);
    assert.ok(
      calls.every((c) => c.redirect === "error"),
      `${who} must pass redirect:"error"; saw ${JSON.stringify(calls)}`,
    );
  }
});
