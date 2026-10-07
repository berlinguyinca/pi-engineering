/**
 * Sanitized real mission requests (PR #106 final review C): the owner's own
 * prompts, with usernames, hosts, secrets and personal paths replaced by
 * neutral placeholders (${L} launch repository, ${T} target repository,
 * ${R} another repository, ${D} a scratch/input directory). Each must keep
 * resolving to the repository it was meant to change.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WorkspaceManifestResolver } from "../../src/orchestration/workspaceManifest.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

interface RealPrompt {
  source: string;
  prompt: string;
  expect: Array<"L" | "T" | "R"> | "refuse";
}

const PROMPTS = JSON.parse(
  readFileSync(new URL("../fixtures/real-prompts-workspace.json", import.meta.url), "utf8"),
) as RealPrompt[];

describe("workspace authority on sanitized real prompts", () => {
  let paths: { L: string; T: string; R: string; D: string };
  const disposers: Array<() => Promise<void>> = [];

  before(async () => {
    const make = async () => {
      const repo = await makeFixtureRepo();
      disposers.push(repo.cleanup);
      return repo.root;
    };
    const D = await mkdtemp(join(tmpdir(), "pi-eng-real-data-"));
    disposers.push(() => rm(D, { recursive: true, force: true }));
    paths = { L: await make(), T: await make(), R: await make(), D };
  });

  after(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
  });

  it("has a representative sample", () => {
    assert.ok(PROMPTS.length >= 20 && PROMPTS.length <= 40);
  });

  for (const sample of PROMPTS) {
    it(`${sample.source}: ${sample.prompt.slice(0, 80).replace(/\s+/g, " ")}`, async () => {
      const prompt = sample.prompt
        .replaceAll("${L}", paths.L)
        .replaceAll("${T}", paths.T)
        .replaceAll("${R}", paths.R)
        .replaceAll("${D}", paths.D);
      const outcome = await new WorkspaceManifestResolver().resolve(prompt, paths.L).catch((error: unknown) => error);
      if (sample.expect === "refuse") {
        assert.ok(outcome instanceof Error, "expected a refusal");
        return;
      }
      assert.ok(!(outcome instanceof Error), String(outcome));
      const names = (outcome as Awaited<ReturnType<WorkspaceManifestResolver["resolve"]>>).repositories
        .map((repository) => Object.entries(paths).find(([, value]) => value === repository.canonicalRoot)?.[0] ?? "?")
        .sort();
      assert.deepEqual(names, [...sample.expect].sort());
    });
  }
});
