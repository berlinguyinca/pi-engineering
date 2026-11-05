// R08: retries never promote a temporary recovery to root-cause resolution; resolution needs reproduction, identity, a passing check and scope.
import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; import { it } from "node:test";
import { RESOLUTION_SHA, classifyResolution, type ResolutionEvidenceInput, type ResolutionVerdict } from "../../src/incidents/resolutionEvidence.ts";
const SHA = `sha256:${"0".repeat(64)}`, SHA63 = `sha256:${"0".repeat(63)}`, SHA_UP = `sha256:${"A".repeat(64)}`;
const FAIL = { command: "npm test", exitCode: 1, artifact: "artifact://fail" }, PASS = { command: "npm test", exitCode: 0, artifact: "artifact://pass" };
const POSTS: (ResolutionEvidenceInput["postFixStatus"])[] = [undefined, "recovered", "unresolved", "suppressed", "unknown"];
const base = (over: Partial<ResolutionEvidenceInput> = {}): ResolutionEvidenceInput => ({ reproduction: FAIL, patchIdentity: SHA, settingIdentity: SHA, passingCheck: PASS, scopeAllowed: true, changedFiles: ["src/a.ts"], allowedPaths: ["src/a.ts"], postFixStatus: "recovered", sameCheckSequencePassed: false, ...over });
const five = (i: ResolutionEvidenceInput): boolean => i.reproduction !== null && i.reproduction !== undefined && i.reproduction.exitCode !== 0 && i.reproduction.command.trim() !== "" && RESOLUTION_SHA.test(i.patchIdentity ?? "") && RESOLUTION_SHA.test(i.settingIdentity ?? "") && i.passingCheck?.exitCode === 0 && i.passingCheck.command !== "" && i.passingCheck.artifact !== "" && i.scopeAllowed === true && (i.changedFiles ?? []).every((f) => (i.allowedPaths ?? []).some((p) => f === p || f.startsWith(`${p}/`)));

it("retries alone cannot mark root cause resolved, at 0 or at 500 (criterion 1)", () => {
  const r = classifyResolution(base({ retryCount: 40 }));
  assert.equal(r.status, "recovered_temporarily"); assert.equal(r.resolved, false); assert.notEqual(r.temporaryBecause, null); assert.ok(r.missing.includes("same-check-sequence"));
  for (let n = 0; n <= 500; n += 20) { const v = classifyResolution(base({ retryCount: n })); assert.equal(v.status, "recovered_temporarily", `retryCount ${n}`); assert.equal(v.resolved, false); assert.match(v.reason, /retryCount/); assert.equal(v.temporaryBecause, "postFixStatus.recovered:completion-record-not-removed-cause"); }
  assert.equal(classifyResolution(base({ retryCount: 500, sameCheckSequencePassed: true })).status, "root_cause_resolved", "the same check sequence promotes, never the count");
});
it("a run that already passed proves nothing was fixed (criterion 2)", () => {
  const strong = { patchIdentity: SHA, settingIdentity: SHA, passingCheck: PASS, scopeAllowed: true, changedFiles: ["src/a.ts"], allowedPaths: ["src/a.ts"], postFixStatus: "recovered" as const, sameCheckSequencePassed: true };
  for (const reproduction of [null, { command: "x", exitCode: 0 }, { command: "  ", exitCode: 1 }]) {
    const v = classifyResolution({ ...strong, reproduction });
    assert.equal(v.status, "unresolved", JSON.stringify(reproduction)); assert.deepEqual(v.missing, ["failing-reproduction"]); assert.equal(v.resolved, false); assert.equal(v.temporaryBecause, null);
  }
});
it("identity is shape, not text, and never survives into the verdict (criterion 3)", () => {
  assert.equal(RESOLUTION_SHA.test(SHA), true); for (const bad of [SHA63, SHA_UP, "abc123", "patched", "", `sha256:${"0".repeat(64)}x`]) assert.equal(RESOLUTION_SHA.test(bad), false, bad);
  const text = classifyResolution(base({ patchIdentity: "abc123", settingIdentity: "patched" }));
  assert.equal(text.status, "unresolved"); assert.deepEqual(text.missing, ["patch-identity", "setting-identity"]); assert.equal(JSON.stringify(text).includes("abc123"), false, "caller text is dropped, not echoed");
  const shaped = classifyResolution(base({ patchIdentity: SHA63, settingIdentity: SHA_UP })); assert.deepEqual(shaped.missing, ["patch-identity", "setting-identity"]); assert.equal(shaped.status, "unresolved");
  const absent = classifyResolution({ reproduction: FAIL, passingCheck: PASS, scopeAllowed: true, postFixStatus: "recovered" }); assert.deepEqual(absent.missing, ["patch-identity", "setting-identity"], "absent identities are demanded, not assumed");
  const ok = classifyResolution(base({ patchIdentity: SHA, settingIdentity: SHA, sameCheckSequencePassed: true })); assert.deepEqual(ok.missing, []); assert.equal(ok.status, "root_cause_resolved"); assert.equal(JSON.stringify(ok).includes("sha256:"), false, "a valid identity is not rewritten into the verdict");
});
it("scope is validated, and a prefix-extension file is outside (criterion 4)", () => {
  const outside: ResolutionEvidenceInput[] = [base({ scopeAllowed: false }), base({ changedFiles: ["src/a.ts", "docs/x.md"], allowedPaths: ["src/a.ts"] }), base({ allowedPaths: [] }), base({ changedFiles: ["src/a.ts.bak"], allowedPaths: ["src/a.ts"] }), base({ changedFiles: ["src/a.ts"], allowedPaths: [""] })];
  for (const input of outside) { const v = classifyResolution({ ...input, sameCheckSequencePassed: true }); assert.equal(v.status, "unresolved", JSON.stringify(input.changedFiles)); assert.ok(v.missing.includes("scope")); assert.equal(v.resolved, false); }
  const ok = classifyResolution(base({ changedFiles: ["src/a.ts", "src/b/c.ts"], allowedPaths: ["src/a.ts", "src/b/"], postFixStatus: "recovered", sameCheckSequencePassed: true }));
  assert.equal(ok.status, "root_cause_resolved"); assert.equal(ok.resolved, true); assert.deepEqual(ok.missing, []); assert.equal(ok.temporaryBecause, null);
});
it("absent or unknown post-fix status is unknown, never resolved (criterion 5)", () => {
  for (const postFixStatus of [undefined, null, "unknown"]) { const v = classifyResolution(base({ postFixStatus: postFixStatus as ResolutionEvidenceInput["postFixStatus"], sameCheckSequencePassed: true })); assert.equal(v.status, "unknown", String(postFixStatus)); assert.equal(v.resolved, false); assert.ok(v.missing.includes("post-fix-status")); assert.equal(v.temporaryBecause, null); }
  for (const s of ["unresolved", "suppressed"] as const) { const v = classifyResolution(base({ postFixStatus: s, sameCheckSequencePassed: true, retryCount: 500 })); assert.equal(v.status, "unresolved", s); assert.equal(v.resolved, false); assert.ok(v.missing.includes("post-fix-status")); }
});
it("resolved iff root_cause_resolved over the status table, and the module is pure (criterion 6)", () => {
  const all: Array<{ input: ResolutionEvidenceInput; verdict: ResolutionVerdict }> = [];
  for (const postFixStatus of POSTS) for (const sameCheckSequencePassed of [true, false]) for (const reproduction of [FAIL, null]) { const input = base({ postFixStatus, sameCheckSequencePassed, reproduction }); all.push({ input, verdict: classifyResolution(input) }); }
  assert.equal(all.length, 20, "5 post-fix values x 2 check-sequence x 2 reproduction");
  for (const { input, verdict: v } of all) {
    assert.equal(v.resolved, v.status === "root_cause_resolved", `${v.status} resolved flag`); assert.equal(v.missing.length === 0, v.resolved, "missing is empty exactly when resolved is true");
    if (v.status === "root_cause_resolved") { assert.equal(input.sameCheckSequencePassed, true); assert.equal(input.postFixStatus, "recovered"); assert.ok(five(input), "root_cause_resolved needs all five requirements"); }
    if (input.sameCheckSequencePassed !== true || input.reproduction === null) assert.equal(v.resolved, false, "no promotion without the same sequence and a failing reproduction");
    assert.equal(typeof v.temporaryBecause === "string", v.status === "recovered_temporarily"); assert.notEqual(v.reason, "");
  }
  assert.equal(all.filter(({ verdict: v }) => v.resolved).length, 1, "exactly recovered + same sequence + failing reproduction");
  assert.equal(all.filter(({ verdict: v }) => v.status === "recovered_temporarily").length, 1, "recovered without the same sequence stays temporary, resolved false");
  const src = readFileSync(new URL("../../src/incidents/resolutionEvidence.ts", import.meta.url), "utf8");
  for (const banned of ["writeFile", "appendFile", "console.", "Date.now", "Math.random", "process.env", "setTimeout", "fetch"]) assert.equal(src.includes(banned), false, banned);
  assert.deepEqual(src.split("\n").filter((line) => /^\s*import\b/.test(line)), ['import type { RecoveryOutcome } from "./recoveryOutcome.ts";'], "the only import is the type-only RecoveryOutcome import");
});
