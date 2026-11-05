/**
 * Issue #506: a reproduced finding had nowhere to put the output that reproduced
 * it, so it entered the ledger as an unverified claim. `ledger_evidence` records
 * that output as an Evidence entity plus a stored artifact, derives everything
 * it can derive (status from the exit code, metrics from the text), and never
 * takes a number, a status, or a trust level from the caller.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import type { Evidence, LedgerEntity } from "../../src/core/types.ts";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { buildCoreTools } from "../../src/tools/coreTools.ts";

const TAP = "# Subtest: room client\nok 1 - room client\n# tests 12\n# suites 1\n# pass 12\n# fail 0\n";

interface Result {
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

interface Harness {
  dir: string;
  file: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  evidence: (params: Record<string, unknown>) => Promise<Result>;
  claim: (params: Record<string, unknown>) => Promise<Result>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-ledger-evidence-"));
  const file = join(dir, "ledger.jsonl");
  const ledger = await Ledger.create(file);
  const artifacts = await ArtifactStore.create(join(dir, "artifacts"));
  await ledger.createWorkItem("ledger evidence", "medium", ["."], { type: "system" });
  const tools = buildCoreTools(() => ({
    ledger: ledger as never,
    artifacts: artifacts as never,
    broker: null as never,
    currentWorkItemId: () => null,
    actor: () => ({ type: "system" }),
  }));
  const exec = (name: string, params: Record<string, unknown>): Promise<Result> => {
    const tool = tools.find((t) => (t as { name?: string }).name === name) as unknown as {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: { cwd: string },
      ) => Promise<Result>;
    };
    return tool.execute("t1", params, undefined, undefined, { cwd: "/tmp" });
  };
  return {
    dir,
    file,
    ledger,
    artifacts,
    evidence: (params) => exec("ledger_evidence", params),
    claim: (params) => exec("ledger_claim", params),
  };
}

test("recorded output becomes evidence whose metrics are read out of the text", async () => {
  const { dir, ledger, artifacts, evidence } = await harness();
  try {
    const result = await evidence({ command: "node --test test/unit/room-client.test.ts", output: TAP, exit_code: 0 });
    const id = String(result.details.id);
    assert.match(id, /^EVID-/);
    assert.equal(result.details.trust, "observed");
    assert.equal(result.details.status, "passed");
    assert.deepEqual(result.details.metrics, { tests: 12, suites: 1, pass: 12, fail: 0 });
    assert.match(result.content[0]!.text, /Metrics read from the output: tests=12/);
    assert.match(result.content[0]!.text, /Cite it in ledger_claim as evidence:/);

    const recorded = ledger.getEvidence(id) as Evidence;
    assert.ok(recorded, "the Evidence entity exists");
    assert.equal(recorded.trust, "observed");
    assert.equal(recorded.status, "passed");
    assert.equal(recorded.exit_code, 0);
    assert.equal(recorded.command, "node --test test/unit/room-client.test.ts");
    assert.equal(recorded.tool, "node");
    assert.equal(recorded.type, "repro");
    assert.equal(recorded.summary.tests, 12);

    const uri = String(result.details.uri);
    assert.equal(recorded.artifacts[0], uri);
    const stored = await artifacts.readSliceByUri(uri, 0, 10_000);
    assert.equal(stored?.content, TAP, "the stored artifact holds the output verbatim");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the caller has no way to assert a count, a status, or a trust level", async () => {
  const { dir, ledger, evidence } = await harness();
  try {
    const result = await evidence({
      command: "node --test",
      output: TAP,
      exit_code: 1,
      // Ignored entirely: these are not parameters of the tool.
      trust: "deterministic",
      status: "passed",
      summary: { tests: 999 },
    } as never);
    const recorded = ledger.getEvidence(String(result.details.id))!;
    assert.equal(recorded.status, "failed", "status comes from the exit code");
    assert.equal(recorded.trust, "observed");
    assert.equal(recorded.summary.tests, 12, "metrics come from the output text, not the caller");
    assert.equal(recorded.summary.pass, 12, "`# pass 12` is the runner's own line");
    assert.notEqual(recorded.summary.suites, 999);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recorded evidence backs the count claim it was recorded for", async () => {
  const { dir, claim, evidence } = await harness();
  try {
    const recorded = await evidence({
      command: "node --test test/unit/room-client.test.ts",
      output: TAP,
      exit_code: 0,
    });
    const id = String(recorded.details.id);
    const result = await claim({
      kind: "fact",
      claim: "test/unit/room-client.test.ts has 12 unit tests",
      evidence: id,
    });
    assert.equal(result.details.refused, undefined, "the number the output reports backs the claim");
    assert.equal(result.details.status, "verified");
    assert.equal(result.details.backedBy, "observed", "the claim says how it is backed");
    assert.match(result.content[0]!.text, /trust observed/);
    assert.match(result.content[0]!.text, /did not run the command/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a count the recorded output does not report is still refused", async () => {
  const { dir, claim, evidence } = await harness();
  try {
    const recorded = await evidence({
      command: "node --test test/unit/room-client.test.ts",
      output: TAP,
      exit_code: 0,
    });
    const result = await claim({
      kind: "finding",
      claim: "test/unit/room-client.test.ts has 13 unit tests",
      evidence: String(recorded.details.id),
    });
    assert.equal(result.details.refused, "count_without_metric_evidence");
    assert.match(result.content[0]!.text, /"13 unit tests"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing run still reports its counts, and that is what a count needs", async () => {
  const { dir, claim, evidence } = await harness();
  try {
    const recorded = await evidence({
      command: "node --test test/unit/room-client.test.ts",
      output: TAP,
      exit_code: 1,
    });
    assert.equal(recorded.details.status, "failed");
    const result = await claim({
      kind: "fact",
      claim: "test/unit/room-client.test.ts has 12 unit tests",
      evidence: String(recorded.details.id),
    });
    // How many tests a file holds is a property of the file, not of whether the
    // run passed: `# tests 12` printed by a failing run still says there are 12.
    // "12 tests pass" is a different claim, and the evidence status is what
    // answers it — recorded here as `failed` and visible to any reader.
    assert.equal(result.details.refused, undefined);
    assert.equal(result.details.status, "verified");
    assert.equal(result.details.backedBy, "observed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence attaches to the finding that reproduced it", async () => {
  const { dir, ledger, claim, evidence } = await harness();
  try {
    const finding = await claim({
      kind: "finding",
      claim: "the room client drops a frame when the socket closes mid-write",
    });
    const entityId = String(finding.details.id);
    const recorded = await evidence({
      command: "node --test test/unit/room-client.test.ts",
      output: "# Subtest: closes mid-write\nnot ok 1 - drops the frame\n",
      exit_code: 1,
      entity: entityId,
    });
    assert.equal(recorded.details.attached, true);
    assert.match(recorded.content[0]!.text, new RegExp(`Attached to ${entityId}`));
    const entity = ledger.getEntity(entityId) as LedgerEntity;
    assert.deepEqual(entity.evidence, [String(recorded.details.id)]);
    assert.equal(entity.status, "open", "attaching evidence does not certify the claim");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown entity records the evidence and says plainly that nothing was attached", async () => {
  const { dir, ledger, evidence } = await harness();
  try {
    const recorded = await evidence({
      command: "node --test",
      output: TAP,
      exit_code: 0,
      entity: "FND-DOES-NOT-EXIST",
    });
    assert.equal(recorded.details.attached, false);
    assert.match(recorded.content[0]!.text, /does not exist, though the evidence record stands/);
    assert.ok(ledger.getEvidence(String(recorded.details.id)), "the evidence itself is kept");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an output that reports two different values for one noun is called ambiguous", async () => {
  const { dir, evidence } = await harness();
  try {
    const result = await evidence({
      command: "node --test",
      output: "# tests 12\nthe wrapper summary claims 13 tests\n",
      exit_code: 0,
    });
    assert.equal((result.details.metrics as Record<string, number>).tests, 12, "the runner's own line wins over prose");
    assert.deepEqual(result.details.ambiguousMetrics, ["tests"]);
    assert.match(result.content[0]!.text, /ambiguous: tests/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an oversized capture is stored truncated and says so", async () => {
  const { dir, artifacts, evidence } = await harness();
  try {
    const huge = `# tests 4\n${"x".repeat(250_000)}\n# fail 0\n`;
    const result = await evidence({ command: "node --test", output: huge, exit_code: 0 });
    assert.equal(result.details.truncated, true);
    const stored = await artifacts.readSliceByUri(String(result.details.uri), 0, 300_000);
    assert.ok(stored);
    assert.ok(stored.content.length < huge.length, "the stored artifact is bounded");
    assert.match(stored.content, /\[ledger_evidence truncated the capture at 200000 characters\]/);
    assert.equal((result.details.metrics as Record<string, number>).tests, 4, "the head still reports its counts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty output and a non-integer exit code are refused", async () => {
  const { dir, evidence } = await harness();
  try {
    const empty = await evidence({ command: "node --test", output: "   \n", exit_code: 0 });
    assert.equal(empty.details.refused, "empty_output");
    assert.equal(empty.isError, true);
    const bad = await evidence({ command: "node --test", output: TAP, exit_code: 1.5 as never });
    assert.equal(bad.details.refused, "bad_exit_code", "status is derived, so the code must be a real integer");
    const kind = await evidence({ command: "node --test", output: TAP, exit_code: 0, kind: "Repro Run!" });
    assert.equal(kind.details.refused, "bad_kind");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recorded evidence and its attachment survive a reload", async () => {
  const { dir, file, claim, evidence } = await harness();
  try {
    const finding = await claim({ kind: "finding", claim: "the room client drops a frame mid-write" });
    const recorded = await evidence({
      command: "node --test test/unit/room-client.test.ts",
      output: TAP,
      exit_code: 0,
      entity: String(finding.details.id),
    });
    const replay = await Ledger.create(file);
    const id = String(recorded.details.id);
    assert.ok(replay.getEvidence(id), "the Evidence entity replays");
    assert.deepEqual(replay.getEntity(String(finding.details.id))?.evidence, [id]);
    assert.equal(replay.listEntities("finding").length, 1, "attaching must not duplicate the entity");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
