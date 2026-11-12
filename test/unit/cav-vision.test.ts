/**
 * The vision reviewer is advisory: it may add findings, it may be unavailable,
 * it may fail mid-call — in every one of those cases a hard gate stays put.
 *
 * Capture is evidence, not a precondition for this contract. `Page.captureScreenshot`
 * fails transiently under concurrent resource pressure and some hosts cannot
 * capture at all — the same finding cav-visual-capture-failure.test.ts exists
 * for on the golden path, and the reason the production capture sites wrap it
 * (src/cav/browser.ts). So this file attempts a real capture and falls back to a
 * synthesized PNG: a runner that cannot drive Chromium reports a host limit, not
 * a gate defect, and the assertions below still run against a real image.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Browser } from "playwright";
import { PNG } from "pngjs";

import { launchChromium, writeHarness } from "../../src/cav/browser.ts";
import { runVisionReview } from "../../src/cav/vision.ts";

const REPO = resolve(import.meta.dirname, "../..");

const HARNESS_HTML = `<!doctype html><html><head><title>v</title><style>body{margin:0;background:#fff}h1{color:#000;font-family:sans-serif}</style></head><body><h1>Vision Review Target</h1></body></html>`;

/** A white 800x400 PNG, for hosts where the browser cannot deliver one. */
async function writeSyntheticShot(path: string): Promise<void> {
  const img = new PNG({ width: 800, height: 400 });
  img.data.fill(0xff); // opaque white, the same frame the harness renders
  await writeFile(path, PNG.sync.write(img));
}

/** Screenshot the harness if this host can; otherwise synthesize an equivalent frame. */
async function captureOrSynthesize(dir: string): Promise<{ shot: string; captured: boolean; note?: string }> {
  const shot = join(dir, "out", "shot.png");
  await mkdir(join(dir, "out"), { recursive: true });
  const url = await writeHarness(dir, HARNESS_HTML);
  const problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    let browser: Browser | undefined;
    try {
      browser = await launchChromium();
      const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
      await page.goto(url, { waitUntil: "load" });
      await page.screenshot({ path: shot });
      return { shot, captured: true };
    } catch (error) {
      problems.push(`attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await browser?.close().catch(() => {});
    }
  }
  await writeSyntheticShot(shot);
  return { shot, captured: false, note: problems.join("; ") };
}

test("vision review is advisory: never overrides a hard gate, even when it runs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cav-vision-"));
  try {
    const { shot, captured, note } = await captureOrSynthesize(dir);
    if (!captured)
      t.diagnostic(`vision-test: host could not capture a screenshot, reviewed a synthesized PNG instead (${note})`);

    const result = await runVisionReview({
      screenshotPath: shot,
      cwd: REPO,
      brief: "Check the heading is legible and centered.",
    });
    // The contract: vision can add findings but overrideHardGate is always false.
    assert.equal(result.overrideHardGate, false);
    assert.equal(result.modelId, "qwen3.8-27b-vision");
    // A reviewer that cannot be reached degrades to no findings; it does not
    // invent them, and it does not throw at the pipeline that asked for advice.
    assert.ok(Array.isArray(result.findings));
    if (result.completed) {
      for (const f of result.findings) {
        assert.ok(["info", "low", "medium", "high"].includes(f.severity));
        assert.ok(typeof f.description === "string");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("vision review degrades gracefully when the screenshot is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cav-vision-missing-"));
  try {
    const result = await runVisionReview({
      screenshotPath: join(dir, "does-not-exist.png"),
      cwd: REPO,
    });
    assert.equal(result.completed, false);
    assert.deepEqual(result.findings, []);
    assert.equal(result.overrideHardGate, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("vision review reports a model failure as degraded, not as a thrown advisory", async () => {
  // A provider that is configured but unreachable is the case that used to
  // escape runVisionReview as an unhandled rejection: advisory code must not be
  // able to break the run it advises. The bogus model id is resolved through the
  // operator's runtime, so no network is required to reach a failure path.
  const dir = await mkdtemp(join(tmpdir(), "cav-vision-fail-"));
  try {
    const img = new PNG({ width: 8, height: 8 });
    img.data.fill(0xff);
    const shot = join(dir, "shot.png");
    await writeFile(shot, PNG.sync.write(img));
    const result = await runVisionReview({
      screenshotPath: shot,
      cwd: REPO,
      provider: "no-such-provider",
      modelId: "no-such-model",
    });
    assert.equal(result.overrideHardGate, false);
    assert.equal(result.completed, false);
    assert.deepEqual(result.findings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
