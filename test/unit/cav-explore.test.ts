import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { writeHarness } from "../../src/cav/browser.ts";
import { exploreUi } from "../../src/cav/explore.ts";

const REPO = resolve(import.meta.dirname, "../..");

const APP = `<!doctype html><html><head><title>exp</title></head><body>
<button id="a">A</button><button id="b">B</button><a id="l" href="#">Link</a><input id="i">
<script>
  document.getElementById("a").addEventListener("click", () => { document.body.dataset.a = "1"; });
</script></body></html>`;

test("explorer performs a bounded number of reproducible actions with no blockers", async () => {
  const dir = `${REPO}/.pi-eng/cav/explore-test`;
  const url = await writeHarness(dir, APP);
  const result = await exploreUi({ url, artifactsDir: `${dir}/out`, maxSteps: 10, seed: 7 });
  assert.equal(result.passed, true, JSON.stringify(result.blockers));
  assert.ok(result.steps.length >= 1);
  assert.ok(result.steps.length <= 10);
  // Trace is reproducible: every step has a recorded selector + action.
  for (const s of result.steps) {
    assert.ok(s.selector.length > 0);
    assert.ok(["click", "focus"].includes(s.action));
  }
});

test("explorer fails closed when exploration triggers a page exception", async () => {
  const dir = `${REPO}/.pi-eng/cav/explore-test-dirty`;
  const url = await writeHarness(
    dir,
    `<!doctype html><html><head><title>exp</title></head><body>
<button id="boom" onclick="throw new Error('explore-js-exception')">Boom</button></body></html>`,
  );
  const result = await exploreUi({ url, artifactsDir: `${dir}/out`, maxSteps: 5, seed: 1 });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((b) => b.includes("page exception")));
});

test("explorer is bounded (never exceeds maxSteps) even on a busy page", async () => {
  const dir = `${REPO}/.pi-eng/cav/explore-test-busy`;
  const url = await writeHarness(
    dir,
    `<!doctype html><html><head><title>exp</title></head><body>
${Array.from({ length: 50 }, (_, i) => `<button id="btn${i}">${i}</button>`).join("")}
</body></html>`,
  );
  const result = await exploreUi({ url, artifactsDir: `${dir}/out`, maxSteps: 3, seed: 2 });
  assert.ok(result.steps.length <= 3);
});
