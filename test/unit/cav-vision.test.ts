import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { writeHarness } from "../../src/cav/browser.ts";
import { runVisionReview } from "../../src/cav/vision.ts";

const REPO = resolve(import.meta.dirname, "../..");

test("vision review is advisory: never overrides a hard gate, even when it runs", async (t) => {
  // Capture a real screenshot with the browser.
  const dir = `${REPO}/.pi-eng/cav/vision-test`;
  const url = await writeHarness(
    dir,
    `<!doctype html><html><head><title>v</title><style>body{margin:0;background:#fff}h1{color:#000;font-family:sans-serif}</style></head><body><h1>Vision Review Target</h1></body></html>`,
  );
  await mkdir(`${dir}/out`, { recursive: true });
  const { chromium } = await import("playwright");
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 800, height: 400 } });
  await p.goto(url, { waitUntil: "load" });
  await p.screenshot({ path: `${dir}/out/shot.png` });
  await b.close();

  const result = await runVisionReview({
    screenshotPath: `${dir}/out/shot.png`,
    cwd: REPO,
    brief: "Check the heading is legible and centered.",
  });
  // The contract: vision can add findings but overrideHardGate is always false.
  assert.equal(result.overrideHardGate, false);
  assert.equal(result.modelId, "qwen3.8-27b-vision");
  // The model either completed (advisory findings) or was unavailable — either
  // way it must not override a hard gate. If it ran, findings are structured.
  if (result.completed) {
    assert.ok(Array.isArray(result.findings));
    for (const f of result.findings) {
      assert.ok(["info", "low", "medium", "high"].includes(f.severity));
      assert.ok(typeof f.description === "string");
    }
  }
});

test("vision review degrades gracefully when the screenshot is missing", async () => {
  const result = await runVisionReview({
    screenshotPath: `${REPO}/.pi-eng/cav/does-not-exist.png`,
    cwd: REPO,
  });
  assert.equal(result.completed, false);
  assert.deepEqual(result.findings, []);
  assert.equal(result.overrideHardGate, false);
});
