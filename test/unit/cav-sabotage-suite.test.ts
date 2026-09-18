import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { runSabotageSuite } from "../../src/cav/sabotage.ts";

const REPO = resolve(import.meta.dirname, "../..");

test("sabotage suite: verifier detects every seeded defect (never shrinks catalog to green)", async () => {
  const results = await runSabotageSuite(`${REPO}/.pi-eng/cav/sabotage`);
  const undetected = results.filter((r) => !r.detected);
  assert.deepEqual(undetected, [], `undetected sabotages: ${undetected.map((u) => u.kind).join(", ")}`);
  assert.ok(results.length >= 4);
});

test("sabotage: a clean page is NOT falsely flagged (verifier has no false positives)", async () => {
  const { writeHarness, instrumentBrowserRun } = await import("../../src/cav/browser.ts");
  const url = await writeHarness(
    `${REPO}/.pi-eng/cav/sabotage-clean`,
    `<!doctype html><html><head><title>c</title></head><body><h1>clean</h1><button id="expected-button">ok</button></body></html>`,
  );
  const r = await instrumentBrowserRun({
    url,
    artifactsDir: `${REPO}/.pi-eng/cav/sabotage-clean/out`,
    verify: async (page) => {
      const count = await page.locator("#expected-button").count();
      if (count !== 1) throw new Error("missing #expected-button");
    },
  });
  assert.equal(r.passed, true, JSON.stringify(r.blockers));
});
