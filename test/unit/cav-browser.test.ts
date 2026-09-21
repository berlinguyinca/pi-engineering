import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { instrumentBrowserRun, writeHarness } from "../../src/cav/browser.ts";

const REPO = resolve(import.meta.dirname, "../..");
const ART = `${REPO}/.pi-eng/cav/browser-test`;

const CLEAN_HTML = `<!doctype html><html><head><title>cav</title></head>
<body><h1 id="h">hello cav</h1><script>
  window.__ok = true;
  window.addEventListener("load", () => {
    document.getElementById("h").textContent = "loaded";
  });
</script></body></html>`;

const DIRTY_HTML = `<!doctype html><html><head><title>cav-dirty</title></head>
<body><h1>boom</h1><script>
  console.error("deliberate console error for test");
  throw new Error("deliberate page exception for test");
</script></body></html>`;

test("browser instrumentation: clean page passes with no blockers + artifacts written", async (t) => {
  const dir = `${ART}/clean`;
  const url = await writeHarness(dir, CLEAN_HTML);
  const result = await instrumentBrowserRun({
    url,
    artifactsDir: `${ART}/clean/out`,
    verify: async (page) => {
      const text = await page.textContent("#h");
      assert.equal(text, "loaded");
    },
  });
  assert.equal(result.passed, true, JSON.stringify(result.blockers));
  assert.deepEqual(result.pageExceptions, []);
  assert.deepEqual(result.consoleErrors, []);
  assert.equal(result.screenshotPath.length > 0, true);
});

test("browser instrumentation: console error + page exception fail closed", async (t) => {
  const dir = `${ART}/dirty`;
  const url = await writeHarness(dir, DIRTY_HTML);
  const result = await instrumentBrowserRun({
    url,
    artifactsDir: `${ART}/dirty/out`,
    verify: async () => {},
  });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((b) => b.includes("console error")));
  assert.ok(result.blockers.some((b) => b.includes("page exception")));
});

test("browser instrumentation: allowlist can waive a specific console error but not a page exception", async (t) => {
  const dir = `${ART}/dirty2`;
  const url = await writeHarness(dir, DIRTY_HTML);
  const result = await instrumentBrowserRun({
    url,
    artifactsDir: `${ART}/dirty2/out`,
    allowConsoleErrors: ["deliberate console error"],
    verify: async () => {},
  });
  // Console error waived, but the page exception is NOT allowlistable.
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((b) => b.includes("page exception")));
  assert.ok(!result.blockers.some((b) => b.includes("console error")));
});
