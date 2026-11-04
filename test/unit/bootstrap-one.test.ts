import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalHash as protocolHash } from "../../src/bootstrap/resultGate.ts";
import { bootstrapOne, canonicalHash, executionPlan, validateParentHandoff, type Observations } from "../../scripts/bootstrap-one.ts";

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

// FIX-2: the parent chain the record asserts must be verified where the handoff is STAMPED, not only in a plan-only run at the base commit.
type StampKind = "valid" | "absent" | "tampered" | "sequence";
/** A committed-clean temp repo (fixtures/ is git-ignored, so porcelain stays empty) whose HEAD is a task commit on its own approved base, plus one `--emit-handoff` run in it. */
function stampRun(t: { after(fn: () => void): void }, kind: StampKind): { status: number | null; stdout: string; written: string[]; declared: string } {
  const dir = mkdtempSync(join(tmpdir(), "fix2-stamp-")); const out = mkdtempSync(join(tmpdir(), "fix2-out-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); });
  const git = (args: string[]): string => execFileSync("git", ["-C", dir, "-c", "user.name=fix2", "-c", "user.email=fix2@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: join(dir, "absent-global-config"), GIT_CONFIG_NOSYSTEM: "1" } });
  git(["init", "-q"]); mkdirSync(join(dir, "fixtures/logs"), { recursive: true }); writeFileSync(join(dir, ".gitignore"), "fixtures/\n"); git(["add", ".gitignore"]); git(["commit", "-q", "-m", "approved base"]);
  const baseSha = git(["rev-parse", "HEAD"]).trim(); mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src/x.ts"), "export const x = 1;\nexport const y = 2;\n"); git(["add", "src/x.ts"]); git(["commit", "-q", "-m", "task"]);
  const fx = (rel: string, data: unknown): void => { writeFileSync(join(dir, "fixtures", rel), typeof data === "string" ? data : JSON.stringify(data)); };
  fx("logs/01.txt", "ok\n"); fx("proofs.json", [{ command: "true", exitCode: 0, outputArtifact: "fixtures/logs/01.txt" }]); fx("record.json", { taskId: "T1", status: "PASS", evidence: [], nextTaskId: "T2", nextBaseSha: git(["rev-parse", "HEAD"]).trim() });
  const parent: Record<string, unknown> = { specVersion: "1.2.0", taskId: "E01", status: "PASS", repo: "pi", baseSha, resultSha: baseSha, evidence: [], nextTaskId: kind === "sequence" ? "OTHER" : "T1", nextBaseSha: baseSha };
  const declared = protocolHash(parent); if (kind === "tampered") parent.status = "BLOCKED"; // the stored checksum below is then stale, exactly as an edited handoff would be
  fx("parent.json", { ...parent, handoffHash: declared }); fx("manifest.json", { ...MANIFEST, taskId: "T1", baseSha, allowPaths: ["src/**"], denyPaths: [], commands: [{ argv: ["true"], cwd: "." }], limits: { maxProductionFiles: 1, maxTestFiles: 1, maxChangedLines: 100 }, expectedOutputs: ["src/x.ts"], parentHandoffHash: declared });
  const argv = [join(process.cwd(), "scripts/bootstrap-one.ts"), "--cwd", dir, "--manifest", "fixtures/manifest.json", "--proofs", "fixtures/proofs.json", "--handoff-record", "fixtures/record.json", "--emit-handoff", out];
  if (kind !== "absent") argv.push("--parent-handoff", "fixtures/parent.json"); const run = spawnSync(process.execPath, argv, { encoding: "utf8" });
  return { status: run.status, stdout: `${run.stdout}${run.stderr}`, written: readdirSync(out), declared };
}

test("validateParentHandoff is pure: a manifest with no parent and a correct parent both yield no blockers", () => {
  assert.deepEqual(validateParentHandoff(MANIFEST, JSON.stringify(PARENT)), [], "the existing fixture chain is valid");
  assert.deepEqual(validateParentHandoff({ ...MANIFEST, parentHandoffHash: null }, null), [], "nothing is declared, so nothing is verified");
  assert.equal(canonicalHash(PARENT), protocolHash(PARENT), "the CLI re-export is the protocol canonicalization itself");
});

test("FIX-2: a declared parent that is absent at stamp time blocks the gate, exits 5 and writes no handoff", (t) => {
  const run = stampRun(t, "absent"); assert.equal(run.status, 5, run.stdout); assert.match(run.stdout, /REJECT gate: manifest declares parentHandoffHash sha256:[0-9a-f]{64} but no parent handoff was supplied/u); assert.doesNotMatch(run.stdout, /gate=accepted/u); assert.deepEqual(run.written, [], "the output directory holds no <taskId>.handoff.json");
});

test("FIX-2: a parent whose stored hash is not its canonical hash is rejected at stamp time", (t) => {
  const run = stampRun(t, "tampered"); assert.equal(run.status, 5, run.stdout); assert.match(run.stdout, /REJECT gate: stored hash sha256:[0-9a-f]{64} != canonical sha256:[0-9a-f]{64}/u); assert.deepEqual(run.written, []);
});

test("FIX-2: a correctly hashed parent pointing at the wrong next task is rejected at stamp time", (t) => {
  const run = stampRun(t, "sequence"); assert.equal(run.status, 5, run.stdout); assert.match(run.stdout, /REJECT gate: parent nextTaskId OTHER != T1/u); assert.deepEqual(run.written, []);
});

test("FIX-2: a valid parent chain stamps, and the stamping run itself prints the verification", (t) => {
  const run = stampRun(t, "valid"); assert.equal(run.status, 0, run.stdout); assert.match(run.stdout, /gate=accepted/u); assert.deepEqual(run.written, ["T1.handoff.json"]);
  assert.equal(run.stdout.includes(`parent=E01 accepted ${run.declared.slice(0, 18)}`), true, "the verification is visible in the stamping log");
});
