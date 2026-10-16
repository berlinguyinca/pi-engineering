/**
 * The external JSON entry point's submit-time receipt lease: a submit acquires
 * the mission's lease with SUBMISSION_RECEIPT_LEASE_MS (5 minutes), regardless
 * of any leaseMs the caller provides (which is clamped to at most that value)
 * or omits. This keeps a submit from granting a long-lived ownership receipt;
 * the 24h DEFAULT_LEASE_MS remains for runtime-held controller leases.
 *
 * The real CLI runs as a child process against a real JSONL store in a mkdtemp
 * directory; nothing is mocked. After each submit the store is reopened
 * in-process to read the mission's created_at and the lease's renewBy.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const CLI = resolve(fileURLToPath(new URL("../../scripts/pi-engineering.ts", import.meta.url)));
const SUBMISSION_RECEIPT_LEASE_MS = 5 * 60 * 1000;

interface Run {
  code: number | null;
  json: Record<string, any>;
  stderr: string;
}

describe("pi-engineering mission (submit receipt lease)", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function store(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pi-ext-receipt-"));
    cleanup.push(dir);
    return dir;
  }

  function run(
    sub: string,
    dir: string,
    body: unknown,
    env: Record<string, string | undefined> = { PI_AUTOSPEC_ENABLED: "1" },
  ): Run {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PI_AUTOSPEC_ENABLED: undefined, PI_MISSION_DEPTH: undefined };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }
    for (const key of ["PI_AUTOSPEC_ENABLED", "PI_MISSION_DEPTH"])
      if (childEnv[key] === undefined) delete childEnv[key];
    const child = spawnSync(process.execPath, [CLI, "mission", sub, "--store", dir], {
      input: typeof body === "string" ? body : JSON.stringify(body),
      env: childEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(child.stdout || "{}");
    } catch {
      // leave empty; the assertion on stdout below reports it
    }
    return { code: child.status, json, stderr: child.stderr };
  }

  const request = (over: Record<string, unknown> = {}) => ({
    ownerId: "autospec-1",
    idempotencyKey: "key-1",
    title: "Add isEven",
    goal: "Implement isEven with tests",
    repository: "/repo/example",
    baseRef: "abc123",
    ...over,
  });

  /** Reopen the store in-process and read the mission and its latest lease. */
  async function readReceipt(dir: string, missionId: string) {
    const backend = await JsonlEventStore.open(join(dir, "orchestration.jsonl"));
    try {
      const store = MissionStore.open(backend);
      const mission = store.getMission(missionId);
      const lease = store.getLatestMissionLease(missionId);
      return { mission, lease };
    } finally {
      backend.close();
    }
  }

  async function assertReceiptLease(dir: string, missionId: string) {
    const { mission, lease } = await readReceipt(dir, missionId);
    assert.ok(mission, "mission should exist");
    assert.ok(lease, "lease should exist");
    // both timestamps must be parseable ISO strings
    const created = Date.parse(mission.created_at);
    const renewBy = Date.parse(lease.renewBy);
    assert.ok(Number.isFinite(created), `created_at must parse as ISO: ${mission.created_at}`);
    assert.ok(Number.isFinite(renewBy), `renewBy must parse as ISO: ${lease.renewBy}`);
    // The receipt lease is 5 minutes from lease acquisition, which happens a
    // couple of milliseconds after the mission record is created, so renewBy
    // can exceed created_at + 5min by that acquisition delay. Allow a small
    // tolerance while still proving the lease is ~5 minutes (never the 24h
    // runtime DEFAULT_LEASE_MS).
    const ACQUISITION_TOLERANCE_MS = 5000;
    assert.ok(
      renewBy <= created + SUBMISSION_RECEIPT_LEASE_MS + ACQUISITION_TOLERANCE_MS,
      `renewBy (${lease.renewBy}) must be within ~5min of created_at (${mission.created_at})`,
    );
  }

  it("a plain submit's receipt lease is at most created_at + 5 minutes", async () => {
    const dir = await store();
    const result = run("submit", dir, request());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.result, "created");
    await assertReceiptLease(dir, result.json.missionId);
  });

  it("a submit with leaseMs: 86400000 clamps the receipt lease to 5 minutes", async () => {
    const dir = await store();
    const result = run("submit", dir, request({ leaseMs: 86_400_000 }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.result, "created");
    await assertReceiptLease(dir, result.json.missionId);
  });

  it("a submit without leaseMs gets the 5-minute receipt lease (not DEFAULT_LEASE_MS)", async () => {
    const dir = await store();
    const result = run("submit", dir, request({ leaseMs: undefined }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.result, "created");
    await assertReceiptLease(dir, result.json.missionId);
  });
});
