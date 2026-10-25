/** T16 glue: the global engineering.yaml `herdr:` block drives lineage (room/mission/visibility) and the attention ingest. */
// This file exercises the connection layer itself, so it opts back in from the
// harness-wide HERDR_DISABLED default (test/support/isolatedState.ts).
delete process.env.HERDR_DISABLED;
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resetLegacyHerdrEnvWarning, resolveAttentionIngest } from "../../src/runtime/herdr/attentionIngest.ts";
import { createIngestFromConnection, loadHerdrConnection } from "../../src/runtime/herdr/herdrConnection.ts";
import { LineageEmitter } from "../../src/runtime/herdr/lineage.ts";
import { createLineageFromConnection, loadLineageEmitter } from "../../src/runtime/herdr/lineageConfig.ts";

async function setup(block: string): Promise<{ dir: string; key: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-yaml-lineage-"));
  const key = randomBytes(12).toString("hex");
  const keyFile = join(dir, "key");
  await writeFile(keyFile, `${key}\n`);
  await chmod(keyFile, 0o600);
  await writeFile(
    join(dir, "engineering.yaml"),
    `herdr:\n  url: http://127.0.0.1:9\n  api_key_file: ${keyFile}\n${block}`,
  );
  return { dir, key };
}

function recorder() {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("herdr: YAML lineage keys", () => {
  it("parses lineage, visibility and scope ids", async () => {
    const { dir } = await setup(
      "  lineage: true\n  visibility: room\n  room_id: room-1\n  workspace_id: ws.1\n  mission_id: m:1\n",
    );
    const { connection, notes } = await loadHerdrConnection(dir);
    assert.deepEqual(notes, []);
    assert.equal(connection?.lineage, true);
    assert.equal(connection?.visibility, "room");
    assert.equal(connection?.roomId, "room-1");
    assert.equal(connection?.workspaceId, "ws.1");
    assert.equal(connection?.missionId, "m:1");
  });

  it("HERDR_DISABLED=1 is a hard off switch even for a valid config", async () => {
    const { dir } = await setup("");
    process.env.HERDR_DISABLED = "1";
    try {
      const { connection, notes } = await loadHerdrConnection(dir);
      assert.equal(connection, null);
      assert.match(notes[0] ?? "", /disabled by HERDR_DISABLED/);
      // The env-URL path is gated too: a live HERDR_INGEST_URL must stay silent.
      const attention = await resolveAttentionIngest(
        { HERDR_DISABLED: "1", HERDR_INGEST_URL: "http://127.0.0.1:9" },
        dir,
      );
      assert.equal(attention, null);
    } finally {
      delete process.env.HERDR_DISABLED;
      // resolveAttentionIngest warns once per process about the legacy variable
      // passed above; leave the warning armed for the tests that count it.
      resetLegacyHerdrEnvWarning();
    }
  });

  it("rejects bad values and unknown keys (herdr off, with a note)", async () => {
    for (const bad of [
      "  lineage: yes-please\n",
      "  visibility: everyone\n",
      "  room_id: 'a b'\n",
      `  mission_id: ${"x".repeat(129)}\n`,
      "  room_id: 5\n",
      "  frobnicate: 1\n",
    ]) {
      const { dir } = await setup(bad);
      const { connection, notes } = await loadHerdrConnection(dir);
      assert.equal(connection, null, bad);
      assert.match(notes[0] ?? "", /herdr off/);
    }
  });

  it("absent new keys: connection unchanged and no lineage", async () => {
    const { dir } = await setup("");
    const { connection } = await loadHerdrConnection(dir);
    assert.equal(connection?.lineage, undefined);
    assert.equal(createLineageFromConnection(connection!, "h"), null);
  });
});

describe("LineageEmitter defaultScope", () => {
  it("stamps room/workspace/mission; per-call fields win", async () => {
    const drafts: Record<string, unknown>[] = [];
    const em = new LineageEmitter({
      source: "pi",
      visibility: "room",
      defaultScope: { room_id: "room-1", workspace_id: "ws-1", mission_id: "m-default" },
      sink: { stage: async (d) => void drafts.push(d as unknown as Record<string, unknown>) },
    });
    em.workerSpawned({ agent: "a", attempt: "a.1", missionId: "m-real", transition: "t" });
    em.workerSpawned({ agent: "b", attempt: "b.1", transition: "t" });
    await em.idle();
    const a = drafts.filter((d) => String(d.entity_id).endsWith(":a") || String(d.entity_id).endsWith(":a.1"));
    const b = drafts.filter((d) => String(d.entity_id).endsWith(":b") || String(d.entity_id).endsWith(":b.1"));
    assert.ok(a.length && b.length);
    for (const d of drafts) {
      assert.equal(d.room_id, "room-1");
      assert.equal(d.workspace_id, "ws-1");
      assert.equal(d.visibility_scope, "room");
    }
    assert.ok(a.every((d) => d.mission_id === "m-real"));
    assert.ok(b.every((d) => d.mission_id === "m-default"));
  });
});

describe("loadLineageEmitter from engineering.yaml", () => {
  it("delivers room-scoped v2 envelopes with the YAML key", async () => {
    const { dir, key } = await setup("  lineage: true\n  visibility: room\n  room_id: room-9\n  mission_id: m-9\n");
    const state = await mkdtemp(join(tmpdir(), "pi-yaml-lineage-state-"));
    const { calls, fetch } = recorder();
    const em = await loadLineageEmitter({ agentDir: dir, envelopeDir: state, fetch });
    assert.ok(em instanceof LineageEmitter);
    em.workerSpawned({ agent: "lead", attempt: "lead.1", transition: "t" });
    await em.idle();
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.equal(c.headers.get("x-api-key"), key);
      assert.equal(c.body.schema_version, 2);
      assert.equal(c.body.room_id, "room-9");
      assert.equal(c.body.mission_id, "m-9");
      assert.equal(c.body.visibility_scope, "room");
      assert.equal(c.body.entity_type, "lineage");
    }
  });

  it("visibility defaults to PRIVATE when the YAML does not say otherwise (and a stated value is honoured)", async () => {
    const run = async (block: string) => {
      const { dir } = await setup(block);
      const state = await mkdtemp(join(tmpdir(), "pi-yaml-lineage-state-"));
      const { calls, fetch } = recorder();
      const em = await loadLineageEmitter({ agentDir: dir, envelopeDir: state, fetch });
      assert.ok(em instanceof LineageEmitter);
      em.workerSpawned({ agent: "lead", attempt: "lead.1", transition: "t" });
      await em.idle();
      assert.ok(calls.length > 0);
      return new Set(calls.map((c) => c.body.visibility_scope));
    };
    assert.deepEqual([...(await run("  lineage: true\n  room_id: room-9\n"))], ["private"]);
    assert.deepEqual([...(await run("  lineage: true\n  visibility: org\n  room_id: room-9\n"))], ["org"]); // control
  });

  it("instance_id from the YAML is stamped on upserted nodes (Herdr pins steering to it); absent = unpinned", async () => {
    const withId = await setup("  lineage: true\n  instance_id: pi-laptop-1\n");
    const noId = await setup("  lineage: true\n");
    const seen: Array<Record<string, unknown> | undefined> = [];
    for (const { dir } of [withId, noId]) {
      const state = await mkdtemp(join(tmpdir(), "pi-yaml-lineage-state-"));
      const { calls, fetch } = recorder();
      const em = await loadLineageEmitter({ agentDir: dir, envelopeDir: state, fetch });
      assert.ok(em);
      em.workerSpawned({ agent: "lead", attempt: "lead.1", transition: "t" });
      await em.idle();
      const attempt = calls.find(
        (c) =>
          (c.body.payload as { node_id?: string }).node_id === "attempt:lead.1" && c.body.event_type === "node.upsert",
      );
      seen.push((attempt?.body.payload as { attrs?: Record<string, unknown> }).attrs);
    }
    assert.equal(seen[0]?.instance_id, "pi-laptop-1");
    assert.equal(seen[1]?.instance_id, undefined);
  });

  it("lineage false or absent: falls back to host config (none here) and sends nothing", async () => {
    const { dir } = await setup("  lineage: false\n");
    const home = await mkdtemp(join(tmpdir(), "pi-yaml-nohome-"));
    const { calls, fetch } = recorder();
    const em = await loadLineageEmitter({ agentDir: dir, fetch, hostConfig: { home } });
    assert.equal(em, null);
    assert.equal(calls.length, 0);
  });
});

describe("attention ingest resolution", () => {
  it("YAML only; the environment is never consulted; none = null", async () => {
    const { dir } = await setup("");
    const { calls, fetch } = recorder();
    const warnings: string[] = [];
    const viaYaml = await resolveAttentionIngest({ HERDR_INGEST_URL: "http://127.0.0.1:1/" }, dir, {
      fetch,
      warn: (l) => warnings.push(l),
    });
    assert.equal(viaYaml?.url, "http://127.0.0.1:9");
    await viaYaml?.emit("mission", "m1", "mission.started", {});
    assert.equal(calls[0]?.body.source, "pi");
    assert.equal(warnings.length, 1);
    const empty = await mkdtemp(join(tmpdir(), "pi-yaml-none-"));
    assert.equal(await resolveAttentionIngest({}, empty), null);
  });

  it("createIngestFromConnection without a store cannot carry lineage", async () => {
    const { dir } = await setup("  lineage: true\n");
    const { connection } = await loadHerdrConnection(dir);
    assert.equal(createIngestFromConnection(connection!, "h").diagnostics(), undefined);
  });
});
