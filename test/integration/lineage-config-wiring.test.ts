/**
 * Lineage is wired through the central fleet config, default OFF.
 * A fake control plane serves /api/v1/fleet/config and records /api/v1/ingest.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { WorkspaceManifest } from "../../src/orchestration/types.ts";
import { Platform } from "../../src/platform/index.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import type { EnvelopeV2 } from "../../src/runtime/herdr/envelope.ts";
import { loadLineageEmitter } from "../../src/runtime/herdr/lineageConfig.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

interface FakePlane {
  url: string;
  ingested: EnvelopeV2[];
  close(): Promise<void>;
}

async function fakeControlPlane(values: Record<string, Record<string, unknown>>): Promise<FakePlane> {
  const ingested: EnvelopeV2[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/api/v1/fleet/config") return send(200, { revision: "r1", values });
      if (req.url === "/api/v1/fleet/config/applied") return send(200, {});
      if (req.url === "/api/v1/ingest") {
        ingested.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as EnvelopeV2);
        return send(200, { ok: true });
      }
      return send(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    ingested,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function hostHome(url: string): string {
  const home = mkdtempSync(join(tmpdir(), "pi-lineage-home-"));
  mkdirSync(join(home, ".config", "herdr-engineering"), { recursive: true });
  writeFileSync(
    join(home, ".config", "herdr-engineering", "host.json"),
    JSON.stringify({ control_plane_url: url, host_id: "host-a", token: randomBytes(12).toString("hex") }),
  );
  return home;
}

function manifest(missionId: string): WorkspaceManifest {
  return {
    manifestId: "WM-1",
    missionId,
    generation: 1,
    authorizedRoots: [{ canonicalPath: "/repo", source: "existing_manifest", access: "write" }],
    repositories: [
      { repoId: "repo-a", canonicalRoot: "/repo", baseRef: "main", baseSha: "base-a", writableDomains: ["src/**"] },
    ],
    dependencyEdges: [],
    hash: "hash-1",
    createdAt: "2026-09-26T10:00:00.000Z",
  };
}

async function runSmallMission(lineage: Awaited<ReturnType<typeof loadLineageEmitter>>, fixtureRoot: string) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-lineage-agent-"));
  const rt = await EngineeringRuntime.open({
    cwd: fixtureRoot,
    worker: new FakeWorkerExecutor({}),
    verifier: new CommandVerifier(),
    agentDir,
    ...(lineage ? { lineage } : {}),
  });
  try {
    const store = rt.missionStore!;
    const mission = store.createMission({
      mission_id: "MSN-wired",
      title: "t",
      goal: "g",
      user_request: "u",
      repository: "/repo",
      base_ref: "base-a",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.bindWorkspaceManifest(manifest(mission.mission_id));
    const task = store.createTask({
      task_id: "task-w",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "o",
      repo_id: "repo-a",
      acceptance_ids: ["AC-1"],
      deliverables: ["d"],
      execution_budget_ms: 60_000,
      checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
      candidate_generation: 0,
      mission_generation: 0,
      fencing_token: 0,
    });
    const ex = store.createExecution({
      task_id: task.task_id,
      mission_id: mission.mission_id,
      backend: "agent",
      repo_id: "repo-a",
      base_sha: "base-a",
    });
    store.setExecutionStatus(ex.execution_id, "RUNNING", {});
    store.setExecutionStatus(ex.execution_id, "SUCCEEDED", {});
    await store.flush();
    if (lineage) {
      const platform = new Platform({ lineage });
      const parent = platform.graph.createWorker({ projectId: "P", role: "lead" });
      platform.graph.createWorker({ projectId: "P", role: "helper", parentWorkerId: parent.id });
    }
    await lineage?.idle();
    return ex.execution_id;
  } finally {
    await rt.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("config enables lineage: real envelopes reach the control plane in order", async () => {
  const plane = await fakeControlPlane({ lineage: { enabled: true }, ingest: { outbox: true } });
  const home = hostHome(plane.url);
  const envelopeDir = mkdtempSync(join(tmpdir(), "pi-lineage-env-"));
  const fixture = await makeFixtureRepo();
  try {
    const lineage = await loadLineageEmitter({ hostConfig: { home }, envelopeDir });
    assert.ok(lineage, "both keys true => emitter built");
    const executionId = await runSmallMission(lineage, fixture.root);
    const events = plane.ingested.filter((e) => e.entity_type === "lineage");
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.schema_version === 2 && e.source === lineage.source));
    const seqs = events.map((e) => e.source_sequence);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
      "arrive in source_sequence order",
    );
    assert.equal(new Set(seqs).size, seqs.length);
    const has = (type: string, pick: (p: Record<string, unknown>) => boolean) =>
      events.some((e) => e.event_type === type && pick(e.payload));
    assert.ok(
      has("node.upsert", (p) => p.node_id === `attempt:${executionId}`),
      "attempt node",
    );
    assert.ok(has("node.state", (p) => p.node_id === `attempt:${executionId}` && p.state === "running"));
    assert.ok(has("node.state", (p) => p.node_id === `attempt:${executionId}` && p.state === "done"));
    assert.ok(
      has("edge.add", (p) => p.edge_type === "spawn"),
      "spawn edge from the work graph",
    );
  } finally {
    await plane.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(envelopeDir, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("lineage stays OFF unless both config keys are true: nothing is built or sent", async () => {
  for (const values of [{}, { lineage: { enabled: true } }, { ingest: { outbox: true } }] as Array<
    Record<string, Record<string, unknown>>
  >) {
    const plane = await fakeControlPlane(values);
    const home = hostHome(plane.url);
    const envelopeDir = mkdtempSync(join(tmpdir(), "pi-lineage-env-"));
    const fixture = await makeFixtureRepo();
    try {
      const lineage = await loadLineageEmitter({ hostConfig: { home }, envelopeDir });
      assert.equal(lineage, null, JSON.stringify(values));
      await runSmallMission(lineage, fixture.root);
      assert.deepEqual(plane.ingested, [], "no ingest POST at all");
    } finally {
      await plane.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(envelopeDir, { recursive: true, force: true });
      await fixture.cleanup();
    }
  }
});

test("no host.json and an unreachable control plane both resolve null without throwing", async () => {
  const empty = mkdtempSync(join(tmpdir(), "pi-lineage-empty-"));
  try {
    assert.equal(await loadLineageEmitter({ hostConfig: { home: empty } }), null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
