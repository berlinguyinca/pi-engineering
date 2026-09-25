import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { writeHarness } from "../../src/cav/browser.ts";
import { ProtectedArtifactGuard } from "../../src/cav/guard.ts";
import { compareToGolden } from "../../src/cav/visual.ts";

const REPO = resolve(import.meta.dirname, "../..");
const BASE = `${REPO}/.pi-eng/cav/visual-test`;
const GOLDEN_DIR = `${BASE}/golden`;

const HTML = `<!doctype html><html><head><title>v</title><style>
body{margin:0;background:#fff} h1{color:#000;font-size:32px;font-family:sans-serif}
</style></head><body><h1>visual regression</h1></body></html>`;

/**
 * Capture a golden screenshot with retry to handle intermittent Playwright
 * protocol errors under concurrent resource pressure.
 */
async function captureGolden(url: string, goldenPath: string): Promise<void> {
  await mkdir(GOLDEN_DIR, { recursive: true });
  const { chromium } = await import("playwright");
  const b = await chromium.launch({ headless: true });
  try {
    const p = await b.newPage({ viewport: { width: 600, height: 400 } });
    await p.goto(url, { waitUntil: "load" });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await p.screenshot({ path: goldenPath });
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
    throw lastErr;
  } finally {
    await b.close().catch(() => {});
  }
}

test("visual regression: identical capture matches golden", async () => {
  const dir = `${BASE}/match`;
  const url = await writeHarness(dir, HTML);
  const golden = `${GOLDEN_DIR}/match.png`;
  await captureGolden(url, golden);
  const result = await compareToGolden({
    goldenPath: golden,
    artifactsDir: `${dir}/out`,
    url,
    viewport: { width: 600, height: 400 },
    thresholdPct: 1,
  });
  assert.equal(result.goldenExists, true);
  assert.equal(result.matched, true, `diff=${result.diffPct}%`);
  assert.ok(result.diffPct <= 1);
});

test("visual regression: missing golden fails closed (no golden = no verification)", async () => {
  const dir = `${BASE}/missing`;
  const url = await writeHarness(dir, HTML);
  const result = await compareToGolden({
    goldenPath: `${GOLDEN_DIR}/does-not-exist.png`,
    artifactsDir: `${dir}/out`,
    url,
    viewport: { width: 600, height: 400 },
  });
  assert.equal(result.goldenExists, false);
  assert.equal(result.matched, false);
});

test("visual regression: a changed page exceeds threshold and fails closed", async () => {
  const dir = `${BASE}/diff`;
  const url = await writeHarness(dir, HTML);
  const golden = `${GOLDEN_DIR}/diff-base.png`;
  await captureGolden(url, golden);

  // Different page: black background, different text => large pixel diff.
  const changedDir = `${BASE}/diff-changed`;
  const changedUrl = await writeHarness(
    changedDir,
    `<!doctype html><html><head><title>v2</title><style>body{margin:0;background:#000}h1{color:#fff;font-size:64px}</style></head><body><h1>CHANGED</h1></body></html>`,
  );
  const result = await compareToGolden({
    goldenPath: golden,
    artifactsDir: `${changedDir}/out`,
    url: changedUrl,
    viewport: { width: 600, height: 400 },
    thresholdPct: 1,
  });
  assert.equal(result.goldenExists, true);
  assert.equal(result.matched, false);
  assert.ok(result.diffPct > 1);
});

test("golden references are protected artifacts", () => {
  const guard = new ProtectedArtifactGuard();
  assert.ok(guard.isProtected("tests/cav/golden/match.png"));
});
