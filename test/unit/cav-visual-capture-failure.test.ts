/**
 * Screenshot capture is evidence, not a verdict.
 *
 * Playwright's `Page.captureScreenshot` fails intermittently under concurrent
 * resource pressure ("Protocol error (Page.captureScreenshot): Unable to
 * capture screenshot"), and some hosts cannot capture at all. Neither the
 * golden comparison nor the pilot's golden seeding may let that error escape:
 * the visual gate has to fail closed with the capture reason, so the rest of
 * the calibration (and its other gates' findings) survives.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Browser } from "playwright";
import { PNG } from "pngjs";

import { writeHarness } from "../../src/cav/browser.ts";
import { calibratePilot } from "../../src/cav/pilot.ts";
import { compareToGolden } from "../../src/cav/visual.ts";

const CAPTURE_ERROR = "Protocol error (Page.captureScreenshot): Unable to capture screenshot";

/** A browser whose pages always fail to screenshot, without launching anything. */
function browserWithFailingCapture(): Browser {
  const page = {
    goto: async () => {},
    screenshot: async () => {
      throw new Error(CAPTURE_ERROR);
    },
    close: async () => {},
  };
  const context = {
    newPage: async () => page,
    close: async () => {},
  };
  return {
    newContext: async () => context,
    close: async () => {},
  } as unknown as Browser;
}

test("compareToGolden reports a capture failure instead of throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cav-visual-capture-"));
  try {
    // A golden must exist, or the comparison short-circuits on "golden missing".
    const golden = new PNG({ width: 4, height: 4 });
    golden.data.fill(255);
    await writeFile(join(dir, "golden.png"), PNG.sync.write(golden));

    const result = await compareToGolden({
      goldenPath: join(dir, "golden.png"),
      artifactsDir: dir,
      url: "about:blank",
      browser: browserWithFailingCapture(),
      thresholdPct: 0.5,
    });

    assert.equal(result.matched, false, "a run with no capture must never pass the visual gate");
    assert.equal(result.diffPct, 100);
    assert.equal(result.goldenExists, true);
    assert.match(result.captureError ?? "", /Unable to capture screenshot/);
    assert.match(await readFile(result.diffPath, "utf8"), /CAPTURE FAILED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pilot calibration survives a host that cannot screenshot", async (t) => {
  const { chromium } = await import("playwright");
  let probe;
  try {
    probe = await chromium.launch({ headless: true });
  } catch (err) {
    t.skip(`playwright cannot launch here: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // Patch the page prototype Playwright actually instantiates (it is not an
  // exported value), then close the probe: every page the pilot launches from
  // here on shares that prototype and fails to capture.
  const probePage = await probe.newPage();
  let found: object | null = Object.getPrototypeOf(probePage);
  while (found && !Object.prototype.hasOwnProperty.call(found, "screenshot")) {
    found = Object.getPrototypeOf(found);
  }
  if (!found) {
    await probePage.close();
    await probe.close();
    t.skip("playwright page exposes no screenshot method to patch");
    return;
  }
  const proto = found as { screenshot: (opts: unknown) => Promise<unknown> };
  const original = proto.screenshot;
  await probePage.close();
  await probe.close();
  // Capture is unsupported for the whole run; launching still works.
  proto.screenshot = async () => {
    throw new Error(CAPTURE_ERROR);
  };
  try {
    const dir = await mkdtemp(join(tmpdir(), "cav-pilot-capture-"));
    const url = await writeHarness(
      dir,
      "<!doctype html><html lang='en'><head><title>p</title></head><body><main><h1>P</h1><button id='action-new'>New</button></main></body></html>",
    );
    try {
      const result = await calibratePilot({
        name: "no-capture",
        url,
        artifactsDir: join(dir, "out"),
        expectedSelectors: ["#action-new"],
        maxExploreSteps: 2,
      });

      const visual = result.gates.find((g) => g.gate === "visual");
      assert.ok(visual, "visual gate must still report a result");
      assert.equal(visual.passed, false, "a visual gate with no capture cannot pass");
      assert.ok(
        visual.blockers.some((b) => /capture failed/i.test(b)),
        JSON.stringify(visual.blockers),
      );
      assert.ok(
        result.blockers.some((b) => b.startsWith("visual:")),
        JSON.stringify(result.blockers),
      );
      // The other gates keep reporting: the run is not lost to a capture error.
      assert.ok(
        result.gates.some((g) => g.gate === "ui"),
        JSON.stringify(result.gates),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    proto.screenshot = original;
  }
});
