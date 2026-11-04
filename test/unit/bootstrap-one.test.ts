import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bootstrapOne, canonicalHash, executionPlan, type Observations } from "../../scripts/bootstrap-one.ts";

const BASE = "bfffb539025959a7429cb8703779573c132ead1f"; const PARENT = {"specVersion": "1.2.0", "taskId": "B03", "status": "PASS", "repo": "pi", "baseSha": "bcfee3b03791afae66e41050a981d28e2e8a03de", "resultSha": "bfffb539025959a7429cb8703779573c132ead1f", "taskAuthorityHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "changedFiles": [{"path": "src/bootstrap/diffGuard.ts", "changeType": "added", "summary": "guard"}, {"path": "test/unit/bootstrap-diff-guard.test.ts", "changeType": "added", "summary": "tests"}], "commands": [{"argv": ["npm", "run", "typecheck"], "cwd": ".", "exitCode": 0, "durationMs": null, "outputArtifact": "docs/logs/01.txt"}], "evidence": ["docs/logs/01.txt", "annotated entry"], "blockedReasons": ["B03-1 note"], "nextTaskId": "B04", "nextBaseSha": "bfffb539025959a7429cb8703779573c132ead1f", "operatorApproval": {"required": true, "approved": true, "approvedBy": "operator", "approvedAt": "2026-11-04T01:03:16Z"}, "handoffHash": "sha256:7c422083a6b280d0163272d14c4fd303b8c6a93d60749cb394f96c7672b1c43e"};
const MANIFEST = {"taskId": "B04", "baseSha": "bfffb539025959a7429cb8703779573c132ead1f", "repoId": "pi", "objective": "CLI skeleton that plans one bootstrap microtask", "allowPaths": ["scripts/**"], "denyPaths": ["scripts/evidence/**"], "commands": [{"argv": ["npm", "run", "typecheck"], "cwd": "."}, {"argv": ["node", "--test", "--import", "./test/support/isolatedState.ts", "test/unit/bootstrap-one.test.ts"], "cwd": "."}], "limits": {"maxProductionFiles": 2, "maxTestFiles": 2, "maxChangedLines": 100}, "parentHandoffHash": "sha256:7c422083a6b280d0163272d14c4fd303b8c6a93d60749cb394f96c7672b1c43e", "expectedOutputs": ["scripts/bootstrap-one.ts"], "mode": "isolated-change" as const};
const obs = (over: Partial<Observations> = {}): Observations => ({ manifestText: JSON.stringify(MANIFEST), parentHandoffText: JSON.stringify(PARENT), headSha: BASE, porcelain: "", ...over });
test("canonical hashing agrees with the handoff protocol's Python canonicalization", () => {
  assert.equal(canonicalHash(PARENT), PARENT.handoffHash, "must match the protocol canonicalization");
  assert.equal(canonicalHash({ ...PARENT, changedFiles: [{ ...PARENT.changedFiles[0], summary: "changed" }, PARENT.changedFiles[1] ] }) !== PARENT.handoffHash, true, "nested changes move the hash");
});
test("one accepted manifest yields a deterministic plan and touches nothing", () => {
  assert.deepEqual(bootstrapOne(obs()), { exitCode: 0, lines: [`parent=B03 accepted ${PARENT.handoffHash.slice(0, 18)}…`, ...executionPlan(MANIFEST)] });
  assert.deepEqual(executionPlan(MANIFEST), ["task=B04", "mode=isolated-change", "repo=pi", "base=bfffb539025959a7429cb8703779573c132ead1f", "allow=scripts/**", "deny=scripts/evidence/**", "limits=2/2/100", "command=. :: npm run typecheck", "command=. :: node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts"]);
});
test("malformed manifests and baseline drift are rejected before any planning", () => {
  const bad = bootstrapOne(obs({ manifestText: JSON.stringify({ ...MANIFEST, allowPaths: ["**"], limits: { maxProductionFiles: 9, maxTestFiles: 1, maxChangedLines: 100 } }) }));
  assert.equal(bad.exitCode, 2); assert.match(bad.lines.join("\n"), /allowPaths|limits/u);
  assert.equal(bootstrapOne(obs({ manifestText: "{not json" })).exitCode, 2);
  assert.deepEqual(bootstrapOne(obs({ headSha: "f".repeat(40) })).lines, [`REJECT baseline: HEAD ${"f".repeat(40)} != manifest baseSha ${BASE}`]);
  assert.match(bootstrapOne(obs({ porcelain: " M src/index.ts\n" })).lines.join("\n"), /worktree is not clean[\s\S]*M src\/index\.ts/u);
});
test("handoff mismatch is rejected and no model, scheduler or inference path is reachable", () => {
  assert.equal(bootstrapOne(obs({ parentHandoffText: null })).exitCode, 4);
  assert.match(bootstrapOne(obs({ manifestText: JSON.stringify({ ...MANIFEST, parentHandoffHash: `sha256:${"0".repeat(64)}` }) })).lines.join("\n"), /!= manifest parentHandoffHash sha256:0{64}/u);
  const forged = { ...PARENT, nextTaskId: "B05" }; forged.handoffHash = canonicalHash(forged);
  assert.match(bootstrapOne(obs({ manifestText: JSON.stringify({ ...MANIFEST, parentHandoffHash: canonicalHash(forged) }), parentHandoffText: JSON.stringify(forged) })).lines.join("\n"), /parent nextTaskId B05 != B04/u);
  assert.match(bootstrapOne(obs({ parentHandoffText: JSON.stringify({ ...PARENT, status: "BLOCKED" }) })).lines.join("\n"), /stored hash .* != canonical/u);
  const source = readFileSync("scripts/bootstrap-one.ts", "utf8"); const imports = source.split("\n").filter((line) => line.trimStart().startsWith("import")).join(" ");
  for (const banned of [/orchestration/iu, /scheduler/iu, /plannerWorker/iu, /gateway/iu, /capability/iu]) assert.equal(banned.test(imports), false, `forbidden import: ${banned}`); assert.equal(/\bfetch\s*\(|createModel|generateContent|completeChat/i.test(source), false, "no model call site anywhere in the wrapper");
});
