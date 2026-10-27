import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { buildCoreTools } from "../../src/tools/coreTools.ts";

test("ledger_claim does not verify a claim citing a fabricated artifact URI (review MED #7)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-tools-"));
  try {
    const ledger = await Ledger.create(join(dir, "ledger.jsonl"));
    const artifacts = await ArtifactStore.create(join(dir, "artifacts"));
    const wi = await ledger.createWorkItem("t", "medium", ["."], { type: "system" });
    // Store one REAL artifact so the resolver has something to distinguish.
    await artifacts.put("verify", "real-1", "real output", "real");

    let resolvedCwd = "";
    const tools = buildCoreTools(async (cwd) => {
      resolvedCwd = cwd;
      return {
        ledger: ledger as never,
        artifacts: artifacts as never,
        broker: null as never,
        currentWorkItemId: () => wi.id,
        actor: () => ({ type: "user" }),
      };
    });
    const ledgerClaim = tools[1]!; // order: ledger_read, ledger_claim, artifact_read, ...

    const execute = ledgerClaim.execute as unknown as (
      id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: { cwd: string },
    ) => Promise<{ details: Record<string, unknown> }>;

    // A fabricated artifact:// URI must NOT produce a verified fact.
    const fabricated = await execute(
      "c1",
      {
        kind: "fact",
        claim: "the sky is green",
        evidence: "artifact://verify/nonexistent",
      },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
    assert.equal(fabricated.details.status, "open", "fabricated artifact must stay an open hypothesis");
    assert.equal(resolvedCwd, "/tmp");

    // A REAL artifact URI does verify the claim.
    const real = await execute(
      "c2",
      {
        kind: "fact",
        claim: "verified by real artifact",
        evidence: "artifact://verify/real-1",
      },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
    assert.equal(real.details.status, "verified");

    // An agent-claim (no evidence) stays open.
    const agentClaim = await execute(
      "c3",
      {
        kind: "fact",
        claim: "unverified agent claim",
        evidence: "agent-claim",
      },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
    assert.equal(agentClaim.details.status, "open");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ledger_claim validates reopened artifact bytes before promoting recorded evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-claim-corrupt-artifact-"));
  try {
    const ledger = await Ledger.create(join(dir, "ledger.jsonl"));
    const root = join(dir, "artifacts");
    const writer = await ArtifactStore.create(root);
    const corrupt = await writer.put("verify", "corrupt", "trusted output", "corrupt sample");
    const valid = await writer.put("verify", "valid", "valid output", "valid sample");
    // Same-size corruption remains discoverable as metadata after lazy reopen,
    // but metadata presence must never authenticate its machine evidence.
    await writeFile(join(root, "verify", "corrupt.txt"), "changed output");
    const artifacts = await ArtifactStore.create(root);
    assert.ok(artifacts.getByUri(corrupt.uri));
    const tools = buildCoreTools(() => ({
      ledger,
      artifacts,
      broker: null,
      currentWorkItemId: () => null,
      actor: () => ({ type: "agent" }),
    }));
    const execute = tools.find((tool) => tool.name === "ledger_claim")!.execute as unknown as (
      id: string,
      params: Record<string, unknown>,
      signal: undefined,
      update: undefined,
      ctx: { cwd: string },
    ) => Promise<{ details: { id: string; status: string; evidenceResolved: boolean } }>;
    const rejected = await execute(
      "corrupt",
      { kind: "fact", claim: "the output is verified", evidence: corrupt.uri },
      undefined,
      undefined,
      { cwd: dir },
    );
    assert.equal(rejected.details.status, "open");
    assert.equal(rejected.details.evidenceResolved, false);
    assert.deepEqual(ledger.getEntity(rejected.details.id)?.evidence, []);
    const accepted = await execute(
      "valid",
      { kind: "fact", claim: "valid output captured", evidence: valid.uri },
      undefined,
      undefined,
      { cwd: dir },
    );
    assert.equal(accepted.details.status, "verified");
    assert.equal(accepted.details.evidenceResolved, true);
    assert.deepEqual(ledger.getEntity(accepted.details.id)?.evidence, [valid.uri]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ledger_claim resolves evidence records and never verifies a hypothesis by reference alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-claim-evidence-"));
  try {
    const ledger = await Ledger.create(join(dir, "ledger.jsonl"));
    const artifacts = await ArtifactStore.create(join(dir, "artifacts"));
    const stored = await artifacts.put("verify", "observed", "wa=0 id=50", "vmstat sample");
    const observed = await ledger.recordEvidence(
      null,
      "measurement",
      "bash",
      "vmstat",
      0,
      "passed",
      {},
      [],
      "observed",
      null,
      { type: "system" },
    );
    const unverified = await ledger.recordEvidence(
      null,
      "claim",
      "agent",
      null,
      0,
      "passed",
      {},
      [],
      "unverified",
      null,
      { type: "agent" },
    );
    const tools = buildCoreTools(() => ({
      ledger,
      artifacts,
      broker: null,
      currentWorkItemId: () => null,
      actor: () => ({ type: "agent" }),
    }));
    const execute = tools.find((tool) => tool.name === "ledger_claim")!.execute as unknown as (
      id: string,
      params: Record<string, unknown>,
      signal: undefined,
      update: undefined,
      ctx: { cwd: string },
    ) => Promise<{ details: { id: string; status: string; evidenceResolved: boolean } }>;
    for (const evidence of ["EVID-invented", "test-run://invented", unverified.id]) {
      const result = await execute("claim", { kind: "fact", claim: "tests passed", evidence }, undefined, undefined, {
        cwd: dir,
      });
      assert.equal(result.details.status, "open", `${evidence} must not verify a fact`);
      assert.equal(result.details.evidenceResolved, false, "unverified references must be explicit in tool results");
      assert.deepEqual(ledger.getEntity(result.details.id)?.evidence, []);
    }
    const fact = await execute(
      "fact",
      { kind: "fact", claim: "sample captured", evidence: observed.id },
      undefined,
      undefined,
      { cwd: dir },
    );
    assert.equal(fact.details.status, "verified");
    assert.equal(fact.details.evidenceResolved, true);
    const hypothesis = await execute(
      "hypothesis",
      { kind: "hypothesis", claim: "swap caused the timeout", evidence: stored.uri },
      undefined,
      undefined,
      { cwd: dir },
    );
    assert.equal(hypothesis.details.status, "open", "capturing a sample does not prove a causal hypothesis");
    assert.deepEqual(ledger.getEntity(hypothesis.details.id)?.evidence, [stored.uri]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact_read errors (not silently empty) when the content file is missing (milestone MED #2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-tools-"));
  try {
    const ledger = await Ledger.create(join(dir, "ledger.jsonl"));
    const artifacts = await ArtifactStore.create(join(dir, "artifacts"));
    const meta = await artifacts.put("candidate", "c1", "full diff", "diff");
    // Corrupt: delete the content file, leaving only the metadata index.
    const contentPath = join(artifacts.rootDir, "candidate", "c1.txt");
    await rm(contentPath, { force: true });

    const tools = buildCoreTools(async () => ({
      ledger: ledger as never,
      artifacts: artifacts as never,
      broker: null as never,
      currentWorkItemId: () => null,
      actor: () => ({ type: "user" }),
    }));
    const artifactRead = tools[2]!;
    const execute = artifactRead.execute as unknown as (
      id: string,
      params: { uri: string },
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: { cwd: string },
    ) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
    const res = await execute("r", { uri: meta.uri }, undefined, undefined, { cwd: "/tmp" });
    assert.equal(res.isError, true, "a missing content file must surface as an error");
    assert.match(res.content[0]?.text ?? "", /content file is missing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mission tool forwards the caller cancellation signal to orchestration", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const tools = buildCoreTools(async () => ({
    ledger: {} as never,
    artifacts: {} as never,
    broker: null,
    currentWorkItemId: () => null,
    actor: () => ({ type: "user" }),
    baseRef: () => "base",
    orchestrator: {
      orchestrate: async (_request: string, opts: { signal?: AbortSignal }) => {
        receivedSignal = opts.signal;
        return {
          mission: {
            mission_id: "MSN-test",
            status: "CANCELED",
            workflow_class: "engineering",
            required_gates: [],
          },
          intent: { intent: ["engineering"] },
          completed: false,
          failureReason: "canceled",
        };
      },
    } as never,
  }));
  const mission = tools.find((tool) => tool.name === "mission")!;
  const execute = mission.execute as unknown as (
    id: string,
    params: { request: string },
    signal: AbortSignal,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<unknown>;

  await execute("m", { request: "cancel me" }, controller.signal, undefined, { cwd: "/repo" });

  assert.equal(receivedSignal, controller.signal);
});
