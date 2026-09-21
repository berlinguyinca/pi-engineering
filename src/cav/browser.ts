/**
 * CAV-04 Browser Instrumentation: capture console errors, page exceptions,
 * failed requests, traces and screenshots/videos via Playwright.
 *
 * This is the deterministic browser evidence layer (UI_VERIFICATION contract).
 * A browser run records machine evidence: page exceptions, console errors,
 * failed requests / 4xx / 5xx, interaction assertions, state transitions,
 * a trace, and a screenshot. The result fails closed if any captured
 * exception/console-error/failed-request is present and not allowlisted.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "playwright";

export interface BrowserEvidence {
  consoleErrors: string[];
  pageExceptions: string[];
  failedRequests: Array<{ url: string; status: number }>;
  screenshotPath: string;
  tracePath: string;
  passed: boolean;
  blockers: string[];
}

export interface InstrumentedRunOptions {
  /** URL to visit. */
  url: string;
  /** Assertions run against the page after load. */
  verify: (page: Page) => Promise<void>;
  /** Allowlisted console-error substrings (e.g. expected third-party noise). */
  allowConsoleErrors?: string[];
  /** Allowlisted failed-request substrings. */
  allowFailedRequests?: string[];
  /** Directory for artifacts (screenshots, traces). */
  artifactsDir: string;
  /** Launch a real browser (default true). */
  launch?: boolean;
  /** Injectable browser (deterministic in tests). */
  browser?: Browser;
  viewport?: { width: number; height: number };
}

/**
 * Instrument a browser session against a real page and return deterministic
 * evidence. Fails closed: any non-allowlisted console error, page exception, or
 * failed request is a blocker. Screenshot + trace are always written.
 */
export async function instrumentBrowserRun(opts: InstrumentedRunOptions): Promise<BrowserEvidence> {
  await mkdir(opts.artifactsDir, { recursive: true });
  const screenshotPath = join(opts.artifactsDir, "screenshot.png");
  const tracePath = join(opts.artifactsDir, "trace.zip");

  const consoleErrors: string[] = [];
  const pageExceptions: string[] = [];
  const failedRequests: Array<{ url: string; status: number }> = [];

  let browser = opts.browser;
  let owned = false;
  let context;
  let page: Page | undefined;
  let tracing = false;
  try {
    if (!browser && opts.launch !== false) {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      owned = true;
    }
    if (!browser) throw new Error("no browser available for instrumentation");
    context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
    page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageExceptions.push(String(err)));
    page.on("response", (res) => {
      if (res.status() >= 400) failedRequests.push({ url: res.url(), status: res.status() });
    });
    page.on("requestfailed", (req) => {
      failedRequests.push({ url: req.url(), status: 0 });
    });

    await context.tracing.start({ screenshots: true, snapshots: true });
    tracing = true;

    await page.goto(opts.url, { waitUntil: "load", timeout: 30000 });
    await opts.verify(page);
    await page.screenshot({ path: screenshotPath });

    await context.tracing.stop({ path: tracePath });
    tracing = false;

    const allowConsoleErrors = opts.allowConsoleErrors ?? [];
    const allowFailedRequests = opts.allowFailedRequests ?? [];
    const blockers: string[] = [];
    for (const e of consoleErrors)
      if (!allowConsoleErrors.some((a) => e.includes(a))) blockers.push(`console error: ${e}`);
    for (const e of pageExceptions) blockers.push(`page exception: ${e}`);
    for (const f of failedRequests) {
      if (!allowFailedRequests.some((a) => f.url.includes(a))) {
        blockers.push(`failed request: ${f.status} ${f.url}`);
      }
    }
    return {
      consoleErrors,
      pageExceptions,
      failedRequests,
      screenshotPath,
      tracePath,
      passed: blockers.length === 0,
      blockers,
    };
  } finally {
    if (tracing && context) await context.tracing.stop({ path: tracePath }).catch(() => {});
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    if (owned && browser) await browser.close().catch(() => {});
  }
}

/** Write a small HTML harness for browser tests when no real app URL exists. */
export async function writeHarness(dir: string, html: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "index.html");
  await writeFile(path, html, "utf-8");
  return `file://${path}`;
}
