import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalHash } from "../../src/bootstrap/resultGate.ts";
import { declaredArtifacts, matchLiveRunners, selectCanonical, verifyTrail, type TrailRecord } from "../../src/bootstrap/trailVerifier.ts";

const SCHEMA = JSON.parse(readFileSync("docs/specs/harness-reliability-bootstrap-20261103/templates/handoff.schema.json", "utf8"));
const SHA = (letter: string) => letter.repeat(40);
const Authority = `sha256:${"a".repeat(64)}`;
const stamp = (body: Record<string, unknown>) => ({ ...body, handoffHash: canonicalHash(body) });
/** A record that conforms to the real protocol schema and carries its own correct stamp. */
const unit = (taskId: string, baseSha: string, nextTaskId: string | null, nextBaseSha: string | null, over: Record<string, unknown> = {}): TrailRecord => {
  const body = {
    specVersion: "1.2.0",
    taskId,
    status: "PASS",
    repo: "berlinguyinca/pi-engineering",
    baseSha,
    resultSha: SHA("b"),
    taskAuthorityHash: Authority,
    changedFiles: [`src/${taskId}.ts`],
    commands: [{ command: "npm run typecheck", exitCode: 0, outputArtifact: `${taskId}/logs/01.txt` }],
    evidence: [`${taskId}/logs/01.txt`, `${taskId}/out/${taskId}.handoff.json`],
    nextTaskId,
    nextBaseSha,
    blockedReasons: [],
    operatorApproval: { required: true, approved: true, approvedBy: "operator", approvedAt: null },
    ...over,
  };
  return { taskId, record: stamp(body) };
};
const CHAIN = (): TrailRecord[] => [unit("E01", SHA("1"), "E02", SHA("2")), unit("E02", SHA("2"), "E03", SHA("3")), unit("E03", SHA("3"), "E04", SHA("4")), unit("E04", SHA("4"), null, null)];
const ORDER = ["E01", "E02", "E03", "E04"];
const PRESENT = new Set(CHAIN().flatMap((entry) => declaredArtifacts(entry.record)));
const EVERYWHERE = { artifactExists: () => true, committed: () => true };
const DISK_AND_GIT = { artifactExists: (path: string) => PRESENT.has(path), committed: (path: string) => PRESENT.has(path) };
const kinds = (verdict: ReturnType<typeof verifyTrail>) => verdict.issues.map((issue) => `${issue.kind}:${issue.taskId ?? "-"}`);

test("a continuous, stamped, schema-conformant trail whose evidence is on disk and in git verifies clean", () => {
  assert.deepEqual(verifyTrail({ schema: SCHEMA, order: ORDER, records: CHAIN(), ...DISK_AND_GIT }), { ok: true, records: 4, issues: [] });
});

test("an edited record stops hashing to its own stamp; a restamped record with a dropped field breaks the schema", () => {
  const [e01, e02, e03, e04] = CHAIN();
  const tampered: TrailRecord = { ...e02!, record: { ...e02!.record, status: "BLOCKED" } };
  assert.deepEqual(kinds(verifyTrail({ schema: SCHEMA, order: ORDER, records: [e01!, tampered, e03!, e04!], ...EVERYWHERE })), ["hash-mismatch:E02"]);
  const dropped = { ...e02!.record } as Record<string, unknown>;
  delete dropped.taskAuthorityHash;
  const restamped: TrailRecord = { taskId: "E02", record: stamp(dropped) }; // stamp made to match: only the schema can catch this
  assert.deepEqual(verifyTrail({ schema: SCHEMA, order: ORDER, records: [e01!, restamped, e03!, e04!], ...EVERYWHERE }).issues, [
    { kind: "schema-violation", taskId: "E02", detail: "$.taskAuthorityHash: required property missing" },
  ]);
});

test("a child cut from a commit its parent never promised is a lineage break; an absent unit is a missing record", () => {
  const [e01, e02, e03, e04] = CHAIN();
  const rebased: TrailRecord = { taskId: "E03", record: stamp({ ...e03!.record, baseSha: SHA("9") }) };
  assert.deepEqual(verifyTrail({ schema: SCHEMA, order: ORDER, records: [e01!, e02!, rebased, e04!], ...EVERYWHERE }).issues, [
    { kind: "lineage-break", taskId: "E03", detail: `E02.nextBaseSha ${SHA("3")} != E03.baseSha ${SHA("9")}` },
  ]);
  assert.deepEqual(kinds(verifyTrail({ schema: SCHEMA, order: ["E01", "E02", "E99"], records: [e01!, e02!], ...EVERYWHERE })), ["missing-record:E99", "next-pointer-mismatch:E02"], "the absent successor breaks the pointer too");
});

test("a record the plan never ordered is reported as a deviation, and a duplicate is reported, not admitted", () => {
  const chain = CHAIN();
  const withFix = [...chain, unit("FIX-1", SHA("5"), null, null)];
  assert.deepEqual(kinds(verifyTrail({ schema: SCHEMA, order: ORDER, records: withFix, ...EVERYWHERE })), ["unplanned-record:FIX-1"]);
  assert.deepEqual(kinds(verifyTrail({ schema: SCHEMA, order: ORDER, records: [...chain, chain[0]!], ...EVERYWHERE })), ["duplicate-record:E01"]);
});

test("declared evidence is checked on disk and in the repository, and the two failures are told apart", () => {
  const chain = CHAIN();
  const bothGone = verifyTrail({ schema: SCHEMA, order: ORDER, records: chain, artifactExists: () => false, committed: () => false });
  assert.deepEqual(kinds(bothGone).slice(0, 4), ["evidence-absent:E01", "evidence-uncommitted:E01", "evidence-absent:E01", "evidence-uncommitted:E01"]);
  assert.deepEqual(kinds(verifyTrail({ schema: SCHEMA, order: ORDER, records: chain, ...EVERYWHERE, committed: () => false })).slice(0, 2), ["evidence-uncommitted:E01", "evidence-uncommitted:E01"]);
  assert.equal(verifyTrail({ schema: SCHEMA, order: ORDER, records: chain }).issues.length, 0, "an omitted observer skips its check instead of guessing");
});

test("a process the run started that is still alive blocks the verdict", () => {
  const verdict = verifyTrail({ schema: SCHEMA, order: ORDER, records: CHAIN(), ...DISK_AND_GIT, liveRunners: ["node --test test/unit/e01.test.ts"] });
  assert.deepEqual(verdict.issues, [{ kind: "live-runner", taskId: null, detail: "process started by the run is still alive: node --test test/unit/e01.test.ts" }]);
  assert.equal(verdict.ok, false);
});

test("declaredArtifacts unions evidence and command outputs, deduplicated and sorted; junk is ignored", () => {
  assert.deepEqual(declaredArtifacts({ evidence: ["b.txt", "a.txt"], commands: [{ outputArtifact: "b.txt" }, { outputArtifact: 7 }, "string", null] }), ["a.txt", "b.txt"]);
  assert.deepEqual(declaredArtifacts({}), []);
});

test("verification observes and never mutates the records it is handed", () => {
  const records = CHAIN();
  const before = structuredClone(records);
  verifyTrail({ schema: SCHEMA, order: ORDER, records, ...DISK_AND_GIT, liveRunners: [] });
  assert.deepEqual(records, before);
});

test("the newest generation is the canonical record; a tie is kept, not chosen", () => {
  const first = unit("E01", SHA("1"), null, null, { status: "BLOCKED" });
  const second = unit("E01", SHA("1"), null, null);
  const canonical = selectCanonical([{ ...first, generation: 1 }, { ...second, generation: 4 }, { ...first, generation: 4 }]);
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0]!.record.handoffHash, second.record.handoffHash, "a tie at the top generation keeps the first entry seen instead of picking");
  assert.deepEqual(selectCanonical([{ ...second, generation: 2 }]), [second]);
});

test("live runners are matched against the commands the trail recorded, and the verifier excludes itself", () => {
  const lines = ["node --test test/unit/e01.test.ts", "/bin/zsh -c npm run test", "tsx scripts/verify-handoff-trail.ts --trail x", "login -pf operator"];
  assert.deepEqual(matchLiveRunners(lines, ["npm run test", "node --test test/unit/e01.test.ts", "npm run test"]), ["/bin/zsh -c npm run test", "node --test test/unit/e01.test.ts"]);
  assert.deepEqual(matchLiveRunners(lines, []), [], "nothing recorded means nothing attributed");
  assert.deepEqual(matchLiveRunners(["node --test  ", "node --test "], ["node --test"]), ["node --test"], "identical lines are reported once");
});

test("a record that points at a successor the plan does not order is a pointer mismatch", () => {
  const [e01, e02, e03, e04] = CHAIN();
  const retargeted: TrailRecord = { taskId: "E02", record: stamp({ ...e02!.record, nextTaskId: "E99" }) };
  assert.deepEqual(verifyTrail({ schema: SCHEMA, order: ORDER, records: [e01!, retargeted, e03!, e04!], ...EVERYWHERE }).issues, [
    { kind: "next-pointer-mismatch", taskId: "E02", detail: 'record declares nextTaskId "E99" where the plan orders "E03"' },
  ]);
  assert.deepEqual(verifyTrail({ schema: SCHEMA, order: ["E01", "E02", "E03"], records: [e01!, e02!, e03!], ...EVERYWHERE }).issues, [
    { kind: "next-pointer-mismatch", taskId: "E03", detail: 'record declares nextTaskId "E04" where the plan orders null' },
  ]);
});
