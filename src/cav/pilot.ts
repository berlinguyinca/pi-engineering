/**
 * CAV-19/20/21 Pilot Calibration: adopt the acceptance verifiers (UI, visual,
 * a11y) on a target pilot console and calibrate them.
 *
 * This is the reusable pilot mechanism. A PilotConfig points the existing
 * deterministic verifiers at a target URL (the pilot console) with an expected
 * interactive surface and an a11y threshold. The run FAILS CLOSED on any failed
 * gate. Adopting CAV on a specific external console (AIMS / InferWeave /
 * WeaveForge) additionally requires that console to be present; when it is
 * absent the console-specific step is BLOCKED, and this mechanism is verified
 * against a real local stand-in (Pi Engineering's own control plane).
 */
import { mkdir, readFile } from "node:fs/promises";
import { verifyAccessibility } from "./a11y.ts";
import { instrumentBrowserRun } from "./browser.ts";
import { exploreUi } from "./explore.ts";
import { compareToGolden } from "./visual.ts";

export interface PilotConfig {
  /** Pilot name, e.g. "aims" | "inferweave" | "weaveforge". */
  name: string;
  url: string;
  artifactsDir: string;
  /** Expected interactive selectors the pilot surface must expose. */
  expectedSelectors: string[];
  /** Maximum allowed axe serious/critical violations. */
  maxA11yViolations?: number;
  /** Maximum exploration steps (bounded monkey testing). */
  maxExploreSteps?: number;
  /** Self-baseline visual threshold (default 0.5%) for render variance. */
  visualThresholdPct?: number;
}

export interface PilotGateResult {
  gate: "ui" | "visual" | "a11y" | "explore";
  passed: boolean;
  blockers: string[];
}

export interface PilotCalibrationResult {
  pilot: string;
  passed: boolean;
  gates: PilotGateResult[];
  blockers: string[];
  /** False: calibration never overrides a hard gate. */
  overrideHardGate: false;
}

/**
 * Run the deterministic pilot calibration: verify the expected interactive
 * surface, bounded exploration, a11y scan, and a golden-visual self-baseline.
 * Fails closed.
 */
export async function calibratePilot(cfg: PilotConfig): Promise<PilotCalibrationResult> {
  const gates: PilotGateResult[] = [];
  const blockers: string[] = [];

  // UI presence gate: every expected selector must be reachable.
  let uiGate;
  try {
    uiGate = await instrumentBrowserRun({
      url: cfg.url,
      artifactsDir: `${cfg.artifactsDir}/ui`,
      verify: async (page) => {
        for (const sel of cfg.expectedSelectors) {
          const count = await page.locator(sel).count();
          if (count === 0) throw new Error(`pilot surface missing expected selector: ${sel}`);
        }
      },
    });
  } catch (err) {
    // A thrown verify IS a failed gate: fail closed, never pass.
    uiGate = {
      consoleErrors: [],
      pageExceptions: [],
      failedRequests: [],
      screenshotPath: "",
      tracePath: "",
      passed: false,
      blockers: [err instanceof Error ? err.message : String(err)],
    };
  }
  gates.push({ gate: "ui", passed: uiGate.passed, blockers: uiGate.blockers });
  if (!uiGate.passed) blockers.push(...uiGate.blockers.map((b) => `ui: ${b}`));

  // Bounded exploration gate (monkey testing) against the pilot.
  const explore = await exploreUi({
    url: cfg.url,
    artifactsDir: `${cfg.artifactsDir}/explore`,
    maxSteps: cfg.maxExploreSteps ?? 10,
  });
  gates.push({ gate: "explore", passed: explore.passed, blockers: explore.blockers });
  if (!explore.passed) blockers.push(...explore.blockers.map((b) => `explore: ${b}`));

  // A11y gate with a threshold (serious/critical violations allowed up to cap).
  const a11y = await verifyAccessibility({ url: cfg.url, artifactsDir: `${cfg.artifactsDir}/a11y` });
  const serious = a11y.blockers.filter((b) => b.includes("serious/critical a11y violation"));
  const max = cfg.maxA11yViolations ?? 0;
  const seriousCount = serious.length ? Number.parseInt(serious[0]!, 10) : 0;
  const a11yBlockers =
    seriousCount > max ? serious : a11y.blockers.filter((b) => !b.includes("serious/critical a11y violation"));
  gates.push({ gate: "a11y", passed: a11yBlockers.length === 0, blockers: a11yBlockers });
  if (a11yBlockers.length) blockers.push(...a11yBlockers.map((b) => `a11y: ${b}`));

  // Visual gate: golden screenshot + pixel diff against itself (self-baseline).
  // First capture seeds the golden (never overwritten on mismatch), second
  // capture must match it. If the golden is missing, capture it fresh.
  await mkdir(`${cfg.artifactsDir}/visual`, { recursive: true });
  const golden = `${cfg.artifactsDir}/visual/golden.png`;
  let goldenExists = true;
  try {
    await readFile(golden);
  } catch {
    goldenExists = false;
  }
  if (!goldenExists) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(cfg.url, { waitUntil: "load", timeout: 30000 });
      await page.screenshot({ path: golden });
    } finally {
      await browser.close();
    }
  }
  const visualThreshold = cfg.visualThresholdPct ?? 0.5;
  const second = await compareToGolden({
    goldenPath: golden,
    artifactsDir: `${cfg.artifactsDir}/visual`,
    url: cfg.url,
    thresholdPct: visualThreshold,
  });
  const visualBlockers = second.matched ? [] : [`visual diff ${second.diffPct}% > ${visualThreshold}%`];
  gates.push({ gate: "visual", passed: visualBlockers.length === 0, blockers: visualBlockers });
  if (visualBlockers.length) blockers.push(...visualBlockers.map((b) => `visual: ${b}`));

  return {
    pilot: cfg.name,
    passed: blockers.length === 0,
    gates,
    blockers,
    overrideHardGate: false,
  };
}
