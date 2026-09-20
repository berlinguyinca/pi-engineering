/**
 * BAR-001 — Bootstrap & dogfood: persistent data model.
 *
 * Dedicated deterministic gate for the BAR persistent audit store
 * (src/bar/store.ts). Covers the BAR-001 requirements:
 *   - machine-readable state/evidence with provenance persisted durably;
 *   - restart/resume does not lose evidence or duplicate completed work;
 *   - immutable append-only baselines (never overwritten, never weakened);
 *   - negative/adversarial cases: idempotence, immutability, resume safety.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type AuditBaseline,
  BarStore,
  type RequirementRecord,
  buildBaseline,
  environmentFingerprint,
  generateCampaigns,
} from "../../src/bar/index.ts";

function makeReq(partial: Partial<RequirementRecord> = {}): RequirementRecord {
  return {
    id: "R1",
    project: "p",
    statement: "s",
    provenance: null,
    dependencies: [],
    evidenceRequirements: [],
    state: "UNKNOWN",
    sourceMappings: [],
    runtimeMappings: [],
    tests: [],
    artifacts: [],
    verifierIdentity: null,
    createdAt: "t",
    updatedAt: "t",
    blockers: [],
    repairCampaignIds: [],
    ...partial,
  };
}

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bar-store-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("BAR-001 resume: persisted requirements survive reopen without loss", async () => {
  await withTmp(async (dir) => {
    const store = await BarStore.open(dir);
    await store.upsertRequirement(makeReq({ id: "R1", statement: "alpha" }));
    await store.upsertRequirement(makeReq({ id: "R2", statement: "beta" }));
    assert.equal(store.listRequirements().length, 2);

    const resumed = await BarStore.open(dir); // restart/resume
    assert.equal(resumed.listRequirements().length, 2, "no evidence lost on resume");
    assert.equal(resumed.getRequirement("R1")?.statement, "alpha");
    assert.equal(resumed.getRequirement("R2")?.statement, "beta");
  });
});

test("BAR-001 negative: idempotent upsert never duplicates completed work", async () => {
  await withTmp(async (dir) => {
    const store = await BarStore.open(dir);
    const created = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      await store.upsertRequirement(makeReq({ id: "R1", statement: "same", createdAt: created }));
    }
    assert.equal(store.listRequirements().length, 1, "re-apply must not duplicate");
    const rec = store.getRequirement("R1")!;
    assert.equal(rec.createdAt, created, "original createdAt preserved on re-apply");

    const reopened = await BarStore.open(dir);
    assert.equal(reopened.listRequirements().length, 1, "on-disk file also has no duplicate");
  });
});

test("BAR-001 negative: immutable baseline cannot be overwritten or weakened", async () => {
  await withTmp(async (dir) => {
    const store = await BarStore.open(dir);
    const base = buildBaseline({
      project: "p",
      sourceRevision: "abc123",
      requirements: [makeReq({ state: "UNKNOWN" })],
      services: ["svc"],
      cavResults: [],
      findings: ["initial finding"],
      cwd: dir,
    });
    // First save returns true (newly stored).
    assert.equal(await store.saveBaseline(base), true);
    // Attempting to overwrite with a mutated (weakened) baseline is rejected.
    // A tampered baseline that attempts to weaken the immutable marker. Cast
    // through unknown because the structural `immutable: true` contract is
    // exactly what tampering tries to violate.
    const tampered = { ...base, immutable: false as const, findings: ["tampered"] } as unknown as AuditBaseline;
    assert.equal(await store.saveBaseline(tampered), false, "re-save of existing auditId rejected");
    const stored = store.getBaseline(base.auditId)!;
    assert.equal(stored.immutable, true, "immutable marker cannot be weakened");
    assert.deepEqual(stored.findings, ["initial finding"], "original snapshot preserved");
  });
});

test("BAR-001 resume safety: corrupt/partial lines are skipped without data loss", async () => {
  await withTmp(async (dir) => {
    const store = await BarStore.open(dir);
    await store.upsertRequirement(makeReq({ id: "R1", statement: "good" }));

    // Append a partial/corrupt line to the requirements file (simulates a
    // crash mid-write). Reopen must skip it and keep the valid record.
    const reqFile = join(dir, ".pi-eng", "bar", "requirements.jsonl");
    await writeFile(reqFile, `${await readFile(reqFile, "utf-8")}{"partial":\n`, "utf-8");

    const resumed = await BarStore.open(dir);
    assert.equal(resumed.listRequirements().length, 1, "corrupt line skipped, valid evidence kept");
    assert.equal(resumed.getRequirement("R1")?.statement, "good");
  });
});

test("BAR-001 environment provenance is deterministic for a given cwd", () => {
  const a = environmentFingerprint("/repo");
  const b = environmentFingerprint("/repo");
  assert.equal(a, b, "same cwd -> same fingerprint");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, environmentFingerprint("/other"));
});

test("BAR-001 campaigns persist with their planned settlement status", async () => {
  await withTmp(async (dir) => {
    const store = await BarStore.open(dir);
    const base = buildBaseline({
      project: "p",
      sourceRevision: "r",
      requirements: [],
      services: [],
      cavResults: [],
      findings: [],
      cwd: dir,
    });
    await store.saveBaseline(base);
    const campaign = generateCampaigns([{ cluster: "c", requirements: ["R1"], evidence: ["e"] }], [makeReq()], {
      auditId: base.auditId,
    })[0]!;
    await store.saveCampaign(campaign);
    const resumed = await BarStore.open(dir);
    assert.equal(resumed.getCampaign(campaign.id)?.status, "PLANNED");
    assert.equal(resumed.getCampaign(campaign.id)?.auditId, base.auditId);
  });
});
