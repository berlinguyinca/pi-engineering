/**
 * Property-style fuzz for the workspace-authority invariant (PR #106 final
 * review C): a path named with any exclusion phrasing is never writable, in
 * any position relative to the target, with any mutation verb.
 *
 * The full grid (phrasings x verbs x positions) runs against the pure
 * request analysis; a deterministic sample runs end to end through the
 * resolver against real git repositories.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { analyzeRequest } from "../../src/orchestration/pathIntent.ts";
import { WorkspaceManifestResolver } from "../../src/orchestration/workspaceManifest.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const PHRASINGS: string[] = [
  "Do not modify {R}",
  "Don't touch {R}",
  "Dont touch {R}",
  "Never change {R}",
  "Do NOT edit {R}",
  "Please do not modify {R}",
  "Under no circumstances modify {R}",
  "Absolutely do not touch {R}",
  "Really, don't change {R}",
  "Do not, under any circumstances, modify {R}",
  "Please, please do not write to {R}",
  "You really must not, under any circumstances, add files to {R}",
  "Avoid {R}",
  "Avoid modifying {R}",
  "Skip {R}",
  "Ignore {R}",
  "Exclude {R}",
  "Excluding {R}",
  "Except {R}",
  "Without touching {R}",
  "Leave {R} alone",
  "Leave {R} untouched",
  "{R} stays unchanged",
  "{R} must remain as it is",
  "{R} must remain the same",
  "Keep {R} as is",
  "Keep {R} as-is",
  "Hands off {R}",
  "{R} is off-limits",
  "{R} is off limits",
  "Refrain from modifying {R}",
  "Changes to {R} are forbidden",
  "Modifying {R} is prohibited",
  "Writing to {R} is disallowed",
  "Changes to {R} are not allowed",
  "{R} is read-only",
  "{R} is readonly",
  "Treat {R} as read only",
  "Use {R} for reference",
  "Use {R} for context",
  "Look at {R}",
  "Inspect {R}",
  "Analyze {R}",
  "Audit {R}",
  "Review {R}",
  "Compare against {R}",
  "Copy the approach of {R}",
  "Mirror {R}",
  "Follow {R}",
  "Based on {R}",
  "Take the parser from {R}",
  "Nothing in {R} should change",
  "None of {R} may change",
  "You can't modify {R}",
  "You cannot modify {R}",
  "You won't modify {R}",
  "You mustn't modify {R}",
  "You shouldn't modify {R}",
  "It doesn't need changes in {R}",
  "Do not fix {R}",
  "Do not add anything to {R}",
  "Never install packages into {R}",
];

const VERBS: string[] = [
  "Fix {T}",
  "Update {T}",
  "Refactor {T}",
  "Implement the feature in {T}",
  "Add tests to {T}",
  "Create files in {T}",
  "Install packages into {T}",
  "Patch {T}",
  "Build {T}",
  "Apply the patch to {T}",
  "Change {T}",
  "Edit {T}",
  "Modify {T}",
  "Write docs in {T}",
  "Rename files in {T}",
  "Delete dead code in {T}",
  "Migrate {T}",
  "Port the module into {T}",
];

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const fill = (text: string, t: string, r: string) => text.replaceAll("{T}", t).replaceAll("{R}", r);
const withR = (verb: string) => verb.replace("{T}", "{T} and {R}");

const POSITIONS: Array<{ name: string; build: (verb: string, phrase: string) => string }> = [
  { name: "next sentence", build: (verb, phrase) => `${verb}. ${phrase}.` },
  { name: "previous sentence", build: (verb, phrase) => `${phrase}. ${verb}.` },
  { name: "same sentence, and", build: (verb, phrase) => `${verb} and ${lowerFirst(phrase)}` },
  { name: "same sentence, but", build: (verb, phrase) => `${verb}, but ${lowerFirst(phrase)}` },
  { name: "same sentence, semicolon", build: (verb, phrase) => `${phrase}; ${lowerFirst(verb)}` },
  { name: "list", build: (verb, phrase) => `- ${verb}\n- ${phrase}` },
  { name: "R also a target, next sentence", build: (verb, phrase) => `${withR(verb)}. ${phrase}.` },
  { name: "R also a target, before", build: (verb, phrase) => `${phrase}. ${withR(verb)}.` },
  { name: "R also a target, same sentence", build: (verb, phrase) => `${withR(verb)}, but ${lowerFirst(phrase)}` },
  {
    name: "markdown intro list",
    build: (verb, phrase) => `${verb}.\n\n${phrase.replace("{R}", "the following")}:\n\n- {R}`,
  },
];

describe("workspace authority fuzz: excluded path never writable (PR #106 final review C)", () => {
  it(`pure analysis: ${PHRASINGS.length} phrasings x ${VERBS.length} verbs x ${POSITIONS.length} positions`, () => {
    assert.ok(PHRASINGS.length >= 40 && VERBS.length >= 15);
    const T = "/srv/fuzz/target-repo";
    const R = "/srv/fuzz/excluded-repo";
    let checked = 0;
    for (const phrase of PHRASINGS) {
      for (const verb of VERBS) {
        for (const position of POSITIONS) {
          const prompt = fill(position.build(verb, phrase), T, R);
          const analysis = analyzeRequest(prompt, "/srv/fuzz/launch");
          const writableR = analysis.mentions.some(
            (mention, index) => mention.path === R && analysis.writeEligible(index),
          );
          assert.equal(writableR, false, `[${position.name}] ${JSON.stringify(prompt)}`);
          checked += 1;
        }
      }
    }
    assert.ok(checked >= 40 * 15 * 5);
  });

  describe("end to end through the resolver (deterministic sample)", () => {
    let roots: { L: string; T: string; R: string };
    const disposers: Array<() => Promise<void>> = [];
    before(async () => {
      const make = async () => {
        const repo = await makeFixtureRepo();
        disposers.push(repo.cleanup);
        return repo.root;
      };
      roots = { L: await make(), T: await make(), R: await make() };
    });
    after(async () => {
      for (const dispose of disposers.splice(0).reverse()) await dispose();
    });

    it("never grants write to the excluded repository", async () => {
      let index = 0;
      for (const phrase of PHRASINGS) {
        for (const position of POSITIONS) {
          const verb = VERBS[index % VERBS.length]!;
          index += 1;
          const prompt = fill(position.build(verb, phrase), roots.T, roots.R);
          const resolved = await new WorkspaceManifestResolver().resolve(prompt, roots.L).catch(() => null);
          if (!resolved) continue;
          assert.ok(
            !resolved.authorizedRoots.some((root) => root.access === "write" && root.canonicalPath === roots.R),
            `[${position.name}] ${JSON.stringify(prompt)}`,
          );
        }
      }
    });
  });
});
