import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DiffGuardReport } from "../../src/bootstrap/diffGuard.ts";
import {
  type GateObservations,
  type Proof,
  canonicalHash,
  evaluateResultGate,
  hashArtifact,
  writeHandoff,
} from "../../src/bootstrap/resultGate.ts";

const RECORD = {
  taskId: "B05",
  status: "PASS",
  commands: [{ argv: ["npm", "run", "typecheck"], cwd: ".", exitCode: 0, outputArtifact: "logs/01.txt" }],
  changedFiles: ["src/bootstrap/resultGate.ts"],
  nested: { z: 1, a: { b: [1, { deep: "ünïcödé" }] } },
};
const HASH = "sha256:fdbadf5d8b7f61fc8e44f4350239d69364bb4f03b2e47f23db08ee73239e8da6"; // computed independently with the protocol's canonicalization (sorted keys, compact JSON, UTF-8)
const diff = (ok = true): DiffGuardReport => ({
  ok,
  changedPaths: ["src/x.ts"],
  productionFiles: 1,
  testFiles: 1,
  added: 120,
  deleted: 0,
  violations: ok ? [] : [{ kind: "changed-line-budget", path: null, detail: "120 > 100" }],
});
const proof: Proof = { command: "npm run typecheck", exitCode: 0, outputArtifact: "logs/01.txt" };
const good: GateObservations = {
  requiredCommands: [proof.command],
  proofs: [proof],
  artifactSha256: { [proof.outputArtifact]: "sha256:aa" },
  expectedArtifactSha256: { [proof.outputArtifact]: "sha256:aa" },
  diff: diff(),
  commitParentSha: "b".repeat(40),
  approvedBaseSha: "b".repeat(40),
};
test("missing proof, failing proof and missing or tampered evidence all block the gate", () => {
  assert.deepEqual(evaluateResultGate(good), { ok: true, blockers: [] });
  assert.deepEqual(evaluateResultGate({ ...good, proofs: [] }).blockers, [
    "missing proof for required command: npm run typecheck",
  ]);
  assert.deepEqual(evaluateResultGate({ ...good, proofs: [{ ...proof, exitCode: 1 }] }).blockers, [
    "proof exit code 1 != 0 for: npm run typecheck",
  ]);
  const dir = mkdtempSync(join(tmpdir(), "b05-hash-"));
  assert.equal(hashArtifact(join(dir, "absent.txt")), null, "absence is reported, never guessed");
  assert.match(String(hashArtifact("src/bootstrap/resultGate.ts")), /^sha256:[0-9a-f]{64}$/u, "real bytes hash");
  assert.deepEqual(evaluateResultGate({ ...good, artifactSha256: {} }).blockers, [
    "evidence artifact absent or unreadable: logs/01.txt",
  ]);
  assert.deepEqual(evaluateResultGate({ ...good, artifactSha256: { [proof.outputArtifact]: "sha256:bb" } }).blockers, [
    "evidence tampered: logs/01.txt sha sha256:bb != recorded sha256:aa",
  ]);
});
test("diff-scope violations and a commit not sitting on the approved base block the gate", () => {
  assert.deepEqual(evaluateResultGate({ ...good, diff: diff(false) }).blockers, [
    "diff scope rejected (changed-line-budget): 120 > 100",
  ]); // prettier-ignore
  assert.deepEqual(evaluateResultGate({ ...good, commitParentSha: "f".repeat(40) }).blockers, [
    `commit parent ${"f".repeat(40)} != approved base ${"b".repeat(40)}`,
  ]);
});
test("the handoff writer is atomic, immutable and stamps the protocol checksum", () => {
  const dir = mkdtempSync(join(tmpdir(), "b05-write-"));
  const written = writeHandoff(dir, "B05", RECORD);
  assert.deepEqual(
    written,
    { path: join(dir, "B05.handoff.json"), handoffHash: HASH },
    "returns the path and checksum it stamped",
  );
  assert.equal(canonicalHash(RECORD), HASH, "canonicalization unchanged from B04, which now re-exports this function");
  assert.equal(JSON.parse(readFileSync(written.path, "utf8")).handoffHash, HASH, "handoff includes its checksum");
  assert.throws(() => writeHandoff(dir, "B05", RECORD), /refusing to overwrite an existing handoff/u);
  assert.deepEqual(readdirSync(dir), ["B05.handoff.json"], "no temp file left behind");
});
