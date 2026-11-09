/** T08: sealed handoff authority — an edited goal is rejected on resume, the same goal with a new summary is accepted, the transcript excerpt is bounded. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type HandoffAuthorityCheck,
  MAX_TRANSCRIPT_CHARS,
  buildHandoff,
  renderHandoff,
  resumeHandoff,
  sealHandoff,
  verifyHandoffAuthority,
} from "../../src/plannerWorker/handoff.ts";
import type { HandoffArtifact, MissionBrief, TaskContract } from "../../src/plannerWorker/types.ts";
const brief: MissionBrief = {
  mission_id: "M-t08",
  summary: "s".repeat(2_000),
  architectural_context: ["arch"],
  acceptance_criteria: ["mission criterion"],
  constraints: ["brief constraint"],
};
const contract: TaskContract = {
  task_id: "T08",
  objective: "Carry contract authority through handoff",
  depends_on: [],
  scope: { allowed: ["src/plannerWorker/handoff.ts"], forbidden: ["src/plannerWorker/types.ts"] },
  acceptance: ["edited goal rejected"],
  verification: ["npm run typecheck"],
  constraints: ["types.ts denied", "transcript bounded"],
  risk: "low",
  relevant_files: ["src/plannerWorker/handoff.ts"],
  decisions: ["authority travels in a separate envelope"],
};
const handoff = (): HandoffArtifact =>
  buildHandoff({
    kind: "planner_to_worker",
    brief,
    plan: { decisions: ["d1"], architectural_context: ["p"] },
    contract,
    from: "planner",
    to: "implementer",
  });
const reasons = (r: HandoffAuthorityCheck): string[] => (r.ok ? [] : r.reasons);
const names = (r: HandoffAuthorityCheck, field: string): boolean => reasons(r).some((x) => x.includes(field));
describe("sealed handoff authority (T08)", () => {
  it("leaves buildHandoff behaviour unchanged", () => {
    const h = handoff();
    assert.ok(h.token_estimate > 0);
    assert.deepEqual(h.constraints, [...brief.constraints, ...contract.constraints]);
    assert.deepEqual(h.acceptance, contract.acceptance);
    assert.deepEqual(h.scope, contract.scope);
    assert.ok(h.mission_summary.includes("[truncated") && h.mission_summary.length < brief.summary.length); // still clips
  });
  it("seals deterministically and bounds the transcript", () => {
    const h = handoff();
    assert.deepEqual(sealHandoff(h), sealHandoff(handoff()));
    const tail = "TAIL-".repeat(1_200);
    const sealed = sealHandoff(h, `  ${"h".repeat(5_000)}${tail}  `);
    assert.ok(
      sealed.authority.transcript_excerpt.length <= MAX_TRANSCRIPT_CHARS &&
        sealed.authority.transcript_truncated === true,
    );
    assert.equal(sealed.authority.transcript_chars, 5_000 + tail.length); // trimmed length
    assert.ok(!renderHandoff(sealed.handoff).includes("TAIL-")); // the rendered handoff carries none of the transcript
    for (const bad of [undefined, null, 42, { transcript: "x" }])
      assert.equal(sealHandoff(h, bad).authority.transcript_excerpt, ""); // non-string: empty, never throws
  });
  it("rejects an edited goal but accepts the same goal with a new summary", () => {
    const sealed = sealHandoff(handoff());
    const hash = sealed.authority.authority_hash;
    const edited = { ...sealed, handoff: { ...sealed.handoff, objective: "Re-plan the mission instead" } };
    assert.ok(names(resumeHandoff(edited, hash), "objective"));
    assert.ok(names(verifyHandoffAuthority(edited, hash), "objective"));
    const r = resumeHandoff(
      {
        handoff: { ...sealed.handoff, mission_summary: "fresh summary for the resumed worker" },
        authority: sealed.authority,
      },
      hash,
    );
    assert.equal(r.ok, true);
    assert.ok(!names(r, "diverged"));
    if (r.ok) assert.equal(r.authority.authority_hash, hash);
  });
  it("rejects altered constraints, acceptance or scope, and a rewritten envelope", () => {
    const sealed = sealHandoff(handoff());
    const hash = sealed.authority.authority_hash;
    const cases: [string, (h: HandoffArtifact) => HandoffArtifact][] = [
      ["constraints", (h) => ({ ...h, constraints: [...h.constraints, "sneaked-in constraint"] })],
      ["constraints", (h) => ({ ...h, constraints: h.constraints.slice(1) })],
      ["acceptance", (h) => ({ ...h, acceptance: ["edited acceptance criterion"] })],
      ["scope", (h) => ({ ...h, scope: { allowed: [...h.scope.allowed, "src/**"], forbidden: h.scope.forbidden } })],
    ];
    for (const [field, alter] of cases) {
      const env = { ...sealed, handoff: alter(sealed.handoff) };
      assert.equal(resumeHandoff(env, hash).ok, false, field);
      assert.ok(names(resumeHandoff(env, hash), field), field);
    }
    const tampered = {
      handoff: handoff(),
      authority: { ...sealed.authority, authority_hash: `sha256:${"0".repeat(64)}` },
    }; // handoff untouched, envelope hash forged
    assert.equal(resumeHandoff(tampered, hash).ok, false);
    assert.ok(names(resumeHandoff(tampered, hash), "authority_hash"));
  });
  it("fails closed without a usable expected hash and on malformed envelopes", () => {
    const sealed = sealHandoff(handoff());
    const hash = sealed.authority.authority_hash;
    for (const missing of [undefined, "", 42, null]) {
      const r = verifyHandoffAuthority(sealed, missing);
      assert.equal(r.ok, false, String(missing));
      assert.ok(names(r, "expected authority hash missing"));
    }
    assert.equal(resumeHandoff(sealed).ok, false);
    assert.ok(names(resumeHandoff(sealed), "expected authority hash missing")); // a resumed worker must always present one
    for (const bad of [null, {}, { handoff: sealed.handoff }, { authority: sealed.authority }]) {
      const r = resumeHandoff(bad, hash);
      assert.equal(r.ok, false);
      assert.deepEqual(reasons(r), ["malformed envelope"]);
    }
  });
});
