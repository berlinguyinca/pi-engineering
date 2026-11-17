/**
 * #629 (1/2) — "remove X **from** Y" marked `Y`, the removal's own target,
 * read-only, so every removal-worded request resolved to *no writable
 * workspace* and the mission blocked at once.
 *
 * The `from` link itself was already exempted for a single-path removal
 * (`removalOfSinglePath`). What still tainted the sentence was the rest of it:
 * the outcome clause ("so it is excluded from all Pi installations") carries a
 * restriction word (`excluded`), and a sentence-level restriction word makes
 * every path in it read-only. But a result clause says what the mutation
 * ACHIEVES — being excluded from installs is the *point* of the removal, not a
 * boundary around it. Failing closed on your own goal is not fail-safe, it is a
 * dead end.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { analyzeRequest } from "../../src/orchestration/pathIntent.ts";
import { WorkspaceManifestResolver } from "../../src/orchestration/workspaceManifest.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

describe("#629 removal wording grants the path it removes from", () => {
  let launch: string;
  let target: string;
  let source: string;
  const disposers: Array<() => Promise<void>> = [];

  before(async () => {
    const make = async () => {
      const repo = await makeFixtureRepo();
      disposers.push(repo.cleanup);
      return repo.root;
    };
    launch = await make();
    target = await make();
    source = await make();
  });

  after(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
  });

  const writable = async (request: string): Promise<string[]> => {
    const resolved = await new WorkspaceManifestResolver().resolve(request, launch);
    return resolved.authorizedRoots.filter((root) => root.access !== "read").map((root) => root.canonicalPath);
  };

  // The exact wording from the issue (MSN-fQfe1D). Built lazily: the fixture
  // directories only exist once `before` has run.
  const issue = () =>
    `Remove the vendored split-view extension from the project ${target} so it is excluded from all Pi installations.`;

  it("grants the target of the reported request", async () => {
    assert.deepEqual(await writable(issue()), [target]);
  });

  for (const verb of ["Remove", "Delete", "Strip", "Purge", "Drop"]) {
    it(`grants for "${verb.toLowerCase()} X from Y"`, async () => {
      const request = `${verb} the legacy adapter module from ${target} and update the manifest.`;
      assert.deepEqual(await writable(request), [target]);
    });
  }

  // The exemption must not leak into the genuine exclusion case: `from` after a
  // non-removal verb is still a source.
  it("still treats `copy X from R` as a read-only source", () => {
    const analysis = analyzeRequest(`Copy the release notes from ${source} into ${target}.`, launch);
    const index = analysis.mentions.findIndex((m) => m.path === source);
    assert.ok(index >= 0 && analysis.tainted[index], "`from` after a non-removal verb still taints");
  });

  // And a restriction aimed straight at the path must still refuse outright.
  it("still refuses when the target is explicitly excluded", async () => {
    await assert.rejects(
      () => writable(`Fix the parser in ${target}. Do not modify ${target}.`),
      /No writable workspace/,
      "a direct restriction on the path must still block writes",
    );
  });

  it("keeps a restriction inside a result clause that names its own path", () => {
    const analysis = analyzeRequest(`Fix ${target} so ${source} is left untouched.`, launch);
    const sourceIndex = analysis.mentions.findIndex((m) => m.path === source);
    assert.ok(sourceIndex >= 0 && analysis.tainted[sourceIndex], "a path inside the clause keeps its taint");
  });
});
