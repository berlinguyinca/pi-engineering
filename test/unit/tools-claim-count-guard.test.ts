import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { buildCoreTools } from "../../src/tools/coreTools.ts";

const TAP = "# Subtest: room client\nok 1 - room client\n# tests 12\n# suites 1\n# pass 12\n# fail 0\n";

interface ClaimResult {
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
}

async function harness(): Promise<{
  dir: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  claim: (params: Record<string, unknown>) => Promise<ClaimResult>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-count-guard-"));
  const ledger = await Ledger.create(join(dir, "ledger.jsonl"));
  const artifacts = await ArtifactStore.create(join(dir, "artifacts"));
  await ledger.createWorkItem("count guard", "medium", ["."], { type: "system" });
  await artifacts.put("verify", "tap-run", TAP, "node --test summary");
  const tools = buildCoreTools(() => ({
    ledger: ledger as never,
    artifacts: artifacts as never,
    broker: null as never,
    currentWorkItemId: () => null,
    actor: () => ({ type: "system" }),
  }));
  const ledgerClaim = tools[1]!; // order: ledger_read, ledger_claim, artifact_read, ...
  const execute = ledgerClaim.execute as unknown as (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: { cwd: string },
  ) => Promise<ClaimResult>;
  return { dir, ledger, artifacts, claim: (params) => execute("c1", params, undefined, undefined, { cwd: "/tmp" }) };
}

test("a count-bearing claim is refused when the cited output does not report that number", async () => {
  const { dir, ledger, claim } = await harness();
  try {
    const result = await claim({
      kind: "finding",
      claim: "main's test/unit/room-client.test.ts has 13 unit tests",
      evidence: "artifact://verify/tap-run",
    });
    assert.equal(result.details.refused, "count_without_metric_evidence");
    assert.match(result.content[0]!.text, /Refused: the claim states a count \("13 unit tests"\)/);
    assert.equal(ledger.listEntities("finding").length, 0, "a refused count must not enter the ledger");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the same claim is recorded when the cited runner output reports the number", async () => {
  const { dir, ledger, claim } = await harness();
  try {
    const result = await claim({
      kind: "finding",
      claim: "main's test/unit/room-client.test.ts has 12 unit tests",
      evidence: "artifact://verify/tap-run",
    });
    assert.equal(result.details.refused, undefined);
    assert.equal(result.details.evidenceResolved, true);
    assert.equal(ledger.listEntities("finding").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a recorded metric evidence entity backs the count it measured", async () => {
  const { dir, ledger, claim } = await harness();
  try {
    const ev = await ledger.recordEvidence(
      null,
      "metric",
      "node --test",
      "node --test --experimental-strip-types test/unit/room-client.test.ts",
      0,
      "passed",
      { tests: 13, pass: 13, fail: 0 },
      [],
      "deterministic",
      null,
      { type: "system" },
    );
    const result = await claim({
      kind: "fact",
      claim: "the candidate's room-client file has 13 unit tests",
      evidence: ev.id,
    });
    assert.equal(result.details.refused, undefined);
    assert.equal(result.details.status, "verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a count claim with a fabricated reference is refused, not downgraded into a fact", async () => {
  const { dir, ledger, claim } = await harness();
  try {
    const result = await claim({
      kind: "fact",
      claim: "the suite runs 5,521 unit tests",
      evidence: "artifact://verify/nonexistent",
    });
    assert.equal(result.details.refused, "count_without_metric_evidence");
    assert.equal(ledger.listEntities("fact").length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claims without a count are unaffected, evidenced or not", async () => {
  const { dir, ledger, claim } = await harness();
  try {
    const bare = await claim({
      kind: "finding",
      claim: "drain() never checks o.signal.aborted, so it keeps fetching after the user aborts",
    });
    assert.equal(bare.details.refused, undefined);
    assert.equal(bare.details.status, "open");
    assert.match(bare.content[0]!.text, /No recorded machine evidence/);
    assert.equal(ledger.listEntities("finding").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
