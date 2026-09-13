import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
