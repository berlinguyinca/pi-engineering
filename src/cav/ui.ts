/**
 * CAV-06 UI Interaction Verification: verify clicks, forms, tables, navigation,
 * state transitions and keyboard behavior against a real browser.
 *
 * Each interaction is a named check with a Playwright action and a post-state
 * assertion. The verifier runs against a real page and fails closed on the
 * first failing check. This is the deterministic UI behavior evidence layer.
 */
import type { Page } from "playwright";
import { instrumentBrowserRun } from "./browser.ts";

export interface UiCheck {
  id: string;
  description: string;
  /** Perform the interaction. */
  act: (page: Page) => Promise<void>;
  /** Assert the resulting state. */
  assert: (page: Page) => Promise<boolean>;
}

export interface UiVerificationOptions {
  url: string;
  checks: UiCheck[];
  artifactsDir: string;
  allowConsoleErrors?: string[];
  allowFailedRequests?: string[];
}

export interface UiVerificationResult {
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; error: string | null }>;
  browserBlockers: string[];
  blockers: string[];
}

/**
 * Run a set of UI interaction checks against a real page under full browser
 * instrumentation. Fails closed on any failing interaction or any browser
 * exception/console-error/failed-request not allowlisted.
 */
export async function verifyUiInteractions(opts: UiVerificationOptions): Promise<UiVerificationResult> {
  const checkResults: UiVerificationResult["checks"] = [];
  const uiBlockers: string[] = [];

  const browser = await instrumentBrowserRun(
    {
      url: opts.url,
      artifactsDir: opts.artifactsDir,
      allowConsoleErrors: opts.allowConsoleErrors,
      allowFailedRequests: opts.allowFailedRequests,
      verify: async (page) => {
        for (const check of opts.checks) {
          let passed = false;
          let error: string | null = null;
          try {
            await check.act(page);
            passed = (await check.assert(page)) === true;
          } catch (e) {
            error = String(e);
          }
          checkResults.push({ id: check.id, passed, error });
          if (!passed) {
            uiBlockers.push(`${check.id}: ${error ?? "assertion failed"} (${check.description})`);
            break;
          }
        }
      },
    },
    // instrumentBrowserRun runs verify synchronously inside; this wrapper keeps
    // the same signature. We cannot await page state after close, so all checks
    // must run inside the verify callback (they do, above).
  );

  const blockers = [...uiBlockers, ...browser.blockers];
  return {
    passed: browser.passed && uiBlockers.length === 0,
    checks: checkResults,
    browserBlockers: browser.blockers,
    blockers,
  };
}
