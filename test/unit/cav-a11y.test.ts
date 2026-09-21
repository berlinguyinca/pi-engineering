import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { verifyAccessibility } from "../../src/cav/a11y.ts";
import { writeHarness } from "../../src/cav/browser.ts";

const REPO = resolve(import.meta.dirname, "../..");

const GOOD_HTML = `<!doctype html><html lang="en"><head><title>a11y</title></head>
<body>
  <main>
    <h1>Good page</h1>
    <div data-state="loading" role="progressbar" aria-label="Loading indicator"></div>
    <div data-state="empty" aria-label="empty list">Empty</div>
    <div role="alert" data-state="error">An error occurred</div>
    <input id="field" aria-label="Name" tabindex="0">
    <div style="width:100px;height:20px;overflow:hidden"><div style="width:500px">long content</div></div>
  </main>
</body></html>`;

test("a11y: a clean page passes with states present and focus reachable", async () => {
  const dir = `${REPO}/.pi-eng/cav/a11y-good`;
  const url = await writeHarness(dir, GOOD_HTML);
  const result = await verifyAccessibility({
    url,
    artifactsDir: `${dir}/out`,
    requireStates: ["loading", "empty", "error"],
    focusTarget: "#field",
  });
  assert.equal(result.passed, true, JSON.stringify(result.blockers));
  assert.deepEqual(result.statesMissing, []);
  assert.equal(result.focusReachable, true);
});

test("a11y: missing required states fail closed", async () => {
  const dir = `${REPO}/.pi-eng/cav/a11y-nostates`;
  const url = await writeHarness(
    dir,
    `<!doctype html><html lang="en"><head><title>a</title></head><body><h1>no states</h1></body></html>`,
  );
  const result = await verifyAccessibility({
    url,
    artifactsDir: `${dir}/out`,
    requireStates: ["error"],
  });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((b) => b.includes("error")));
});

test("a11y: unreachable focus target fails closed", async () => {
  const dir = `${REPO}/.pi-eng/cav/a11y-nofocus`;
  const url = await writeHarness(
    dir,
    `<!doctype html><html lang="en"><head><title>a</title></head><body><h1>x</h1><input id="hidden" style="display:none"></body></html>`,
  );
  const result = await verifyAccessibility({
    url,
    artifactsDir: `${dir}/out`,
    focusTarget: "#hidden",
  });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((b) => b.includes("focus")));
});
