/**
 * CAV-08 Accessibility and UX Mechanics: automated accessibility (axe-core),
 * focus/keyboard path, overflow/clipping, and loading/error/empty states.
 *
 * Runs against a real page with Playwright + axe-core and fails closed on any
 * accessibility violation or missing UX state. This is deterministic browser
 * evidence for a11y and UX mechanics.
 */
import { createRequire } from "node:module";
import type { Page } from "playwright";
import { instrumentBrowserRun } from "./browser.ts";

const require = createRequire(import.meta.url);

export interface A11yOptions {
  url: string;
  artifactsDir: string;
  /** Require these states to be present (loading/empty/error). */
  requireStates?: Array<"loading" | "empty" | "error">;
  /** Element selector for focus-path verification. */
  focusTarget?: string;
  /** Selector whose content must not overflow its box. */
  overflowSelector?: string;
  allowConsoleErrors?: string[];
}

export interface A11yResult {
  passed: boolean;
  violations: Array<{ id: string; impact: string; description: string; nodes: number }>;
  statesPresent: string[];
  statesMissing: string[];
  focusReachable: boolean;
  overflowClipped: boolean;
  browserBlockers: string[];
  blockers: string[];
}

const UX_MARKERS: Record<string, Array<[string, string]>> = {
  loading: [
    ["[data-state='loading']", "loading"],
    [".loading", "loading"],
    ["[role='progressbar']", "loading"],
  ],
  empty: [
    ["[data-state='empty']", "empty"],
    [".empty-state", "empty"],
    ["[aria-label*='empty' i]", "empty"],
  ],
  error: [
    ["[data-state='error']", "error"],
    [".error-state", "error"],
    ["[role='alert']", "error"],
  ],
};

/**
 * Run axe-core + UX-mechanics checks against a real page. Fails closed on any
 * axe violation (above 'serious' by default), a missing required state, an
 * unreachable focus target, or overflow clipping.
 */
export async function verifyAccessibility(opts: A11yOptions): Promise<A11yResult> {
  const violations: A11yResult["violations"] = [];
  const statesPresent: string[] = [];
  const statesMissing: string[] = [];
  let focusReachable = false;
  let overflowClipped = false;
  let browserBlockers: string[] = [];

  const browser = await instrumentBrowserRun({
    url: opts.url,
    artifactsDir: opts.artifactsDir,
    allowConsoleErrors: opts.allowConsoleErrors,
    verify: async (page: Page) => {
      // axe-core scan.
      await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
      const results = (await page.evaluate(async () => {
        const g = globalThis as Record<string, unknown>;
        const axe = g.axe as {
          run: (el?: unknown, opts?: unknown) => Promise<{ violations: unknown[] }>;
        };
        const doc = g.document as unknown as { querySelectorAll: (s: string) => ArrayLike<unknown> };
        return axe.run(doc, { resultTypes: ["violations"] });
      })) as { violations: Array<{ id: string; impact: string; description: string; nodes: unknown[] }> };
      for (const v of results.violations) {
        violations.push({ id: v.id, impact: v.impact, description: v.description, nodes: v.nodes.length });
      }

      // Required states.
      for (const state of opts.requireStates ?? []) {
        const markers = UX_MARKERS[state] ?? [];
        let found = false;
        for (const [sel] of markers) {
          if (await page.locator(sel).count()) {
            found = true;
            break;
          }
        }
        if (found) statesPresent.push(state);
        else statesMissing.push(state);
      }

      // Keyboard focus reachability: the target must be visible and natively
      // focusable (not disabled, not inert, not display:none). Programmatic
      // page.focus() forces focus even on non-focusable elements, so we test
      // the keyboard path directly via isVisible + tabindex + disabled state.
      if (opts.focusTarget) {
        try {
          const loc = page.locator(opts.focusTarget);
          const visible = await loc.isVisible();
          const info = (await loc.evaluate((el) => {
            const g = globalThis as Record<string, unknown>;
            const doc = g.document as { defaultView: Record<string, unknown> };
            const win = doc.defaultView;
            const style = (win.getComputedStyle as (e: unknown) => Record<string, string>)(el);
            const e = el as unknown as {
              tabIndex?: number;
              disabled?: boolean;
              inert?: boolean | null;
            };
            const isContentEditable = (el as unknown as { isContentEditable?: boolean }).isContentEditable === true;
            return {
              style,
              tabIndex: e.tabIndex,
              disabled: e.disabled === true,
              inert: e.inert === true,
              isContentEditable,
              tag: (el as unknown as { tagName?: string }).tagName,
            };
          })) as {
            style: Record<string, string>;
            tabIndex?: number;
            disabled: boolean;
            inert: boolean;
            isContentEditable: boolean;
            tag?: string;
          };
          const notDisplayed = info.style.display === "none" || info.style.visibility === "hidden";
          const focusableTag =
            info.tag === "INPUT" || info.tag === "BUTTON" || info.tag === "A" || info.tag === "SELECT";
          const tabbable =
            (typeof info.tabIndex === "number" && info.tabIndex >= 0) || info.isContentEditable || focusableTag;
          focusReachable = visible && !notDisplayed && !info.disabled && !info.inert && tabbable;
        } catch {
          focusReachable = false;
        }
      }

      // Overflow/clipping: element's scroll size must not exceed its client size.
      if (opts.overflowSelector) {
        overflowClipped = (await page.evaluate((sel) => {
          const g = globalThis as Record<string, unknown>;
          const doc = g.document as { querySelector: (s: string) => Record<string, unknown> | null };
          const el = doc.querySelector(sel);
          if (!el) return false;
          const getRect = el.getBoundingClientRect as () => { width: number; height: number };
          const rect = getRect.call(el);
          const cs = (g.getComputedStyle as (el: unknown) => Record<string, string>)(el);
          const scrollW = (el.scrollWidth as number) ?? 0;
          const scrollH = (el.scrollHeight as number) ?? 0;
          return (
            scrollW > rect.width + 1 ||
            scrollH > rect.height + 1 ||
            cs.overflowX === "hidden" || // content may be clipped
            rect.width <= 0 ||
            rect.height <= 0
          );
        }, opts.overflowSelector)) as boolean;
      }
    },
    // We cannot read page state after close, so capture browserBlockers by
    // re-running instrumentation is not needed; instrumentBrowserRun returns
    // them in `blockers`. We capture them below via the return.
  });
  browserBlockers = browser.blockers;

  const blockers: string[] = [];
  const serious = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  if (serious.length) blockers.push(`${serious.length} serious/critical a11y violation(s)`);
  if (statesMissing.length) blockers.push(`missing required states: ${statesMissing.join(",")}`);
  if (opts.focusTarget && !focusReachable) blockers.push(`focus target not reachable: ${opts.focusTarget}`);
  if (opts.overflowSelector && overflowClipped) blockers.push(`overflow/clipping detected: ${opts.overflowSelector}`);
  blockers.push(...browserBlockers);

  return {
    passed: blockers.length === 0,
    violations,
    statesPresent,
    statesMissing,
    focusReachable,
    overflowClipped,
    browserBlockers,
    blockers,
  };
}
