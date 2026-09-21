/**
 * CAV-07 Visual Regression: golden screenshots, viewport matrix, pixel diffs,
 * and protected golden references.
 *
 * A golden screenshot is a protected reference (tests/cav/golden/**). Visual
 * verification captures a fresh screenshot at a specified viewport and compares
 * it to the golden; a pixel diff above the threshold fails closed. Golden
 * updates are a separate, protected path and are never written by an ordinary
 * verification run.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { PNG } from "pngjs";

export interface GoldenCompareOptions {
  goldenPath: string;
  artifactsDir: string;
  url: string;
  viewport?: { width: number; height: number };
  thresholdPct?: number;
  browser?: Browser;
  launch?: boolean;
}

export interface GoldenCompareResult {
  matched: boolean;
  diffPct: number;
  thresholdPct: number;
  goldenExists: boolean;
  goldenPath: string;
  capturePath: string;
  diffPath: string;
}

/** Decode a PNG buffer into raw RGBA pixels using pngjs. */
function decodePng(buf: Buffer): { width: number; height: number; data: Buffer } {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

function pixelDiff(a: Buffer, b: Buffer, w: number, h: number): { diff: number; total: number } {
  const len = w * h * 4;
  const n = Math.min(len, a.length, b.length);
  let diff = 0;
  for (let i = 0; i < n; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
  }
  return { diff, total: w * h };
}

/**
 * Capture a fresh screenshot at a viewport, compare it to the golden, and write
 * a diff marker. Fails closed when the golden is missing or the diff exceeds
 * the threshold. Never writes the golden.
 */
export async function compareToGolden(opts: GoldenCompareOptions): Promise<GoldenCompareResult> {
  await mkdir(opts.artifactsDir, { recursive: true });
  const capturePath = join(opts.artifactsDir, "capture.png");
  const diffPath = join(opts.artifactsDir, "diff.txt");
  const thresholdPct = opts.thresholdPct ?? 0.5;

  let golden: Buffer | null = null;
  try {
    golden = await readFile(opts.goldenPath);
  } catch {
    // golden missing
  }
  if (!golden) {
    await writeFile(diffPath, `GOLDEN MISSING: ${opts.goldenPath}\n`);
    return {
      matched: false,
      diffPct: 100,
      thresholdPct,
      goldenExists: false,
      goldenPath: opts.goldenPath,
      capturePath,
      diffPath,
    };
  }

  let browser = opts.browser;
  let owned = false;
  let context;
  let page;
  try {
    if (!browser && opts.launch !== false) {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      owned = true;
    }
    if (!browser) throw new Error("no browser available");
    context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
    page = await context.newPage();
    await page.goto(opts.url, { waitUntil: "load", timeout: 30000 });
    await page.screenshot({ path: capturePath });
    const fresh = await readFile(capturePath);
    const gd = decodePng(golden);
    const fd = decodePng(fresh);
    if (gd.width !== fd.width || gd.height !== fd.height) {
      await writeFile(diffPath, `SIZE MISMATCH: golden ${gd.width}x${gd.height} vs capture ${fd.width}x${fd.height}\n`);
      return {
        matched: false,
        diffPct: 100,
        thresholdPct,
        goldenExists: true,
        goldenPath: opts.goldenPath,
        capturePath,
        diffPath,
      };
    }
    const { diff, total } = pixelDiff(gd.data, fd.data, fd.width, fd.height);
    const diffPct = (diff / total) * 100;
    const matched = diffPct <= thresholdPct;
    await writeFile(diffPath, `diff=${diffPct.toFixed(2)}% threshold=${thresholdPct}% ${matched ? "PASS" : "FAIL"}\n`);
    return {
      matched,
      diffPct,
      thresholdPct,
      goldenExists: true,
      goldenPath: opts.goldenPath,
      capturePath,
      diffPath,
    };
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    if (owned && browser) await browser.close().catch(() => {});
  }
}
