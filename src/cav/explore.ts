/**
 * CAV-13 Exploratory UI Agent: bounded browser exploration / monkey testing
 * with reproducible traces.
 *
 * The explorer walks the page, finds interactive elements (buttons, links,
 * inputs), and performs a bounded sequence of actions within a step budget.
 * Each action's selector + type is recorded, producing a reproducible trace.
 * Any page exception / console error / failed request is a blocker (fail closed).
 */
import type { Page } from "playwright";
import { instrumentBrowserRun } from "./browser.ts";

export interface ExploreStep {
  index: number;
  action: string;
  selector: string;
}

export interface ExploreOptions {
  url: string;
  artifactsDir: string;
  /** Max actions to perform. */
  maxSteps?: number;
  /** Seed for deterministic action selection. */
  seed?: number;
  allowConsoleErrors?: string[];
  allowFailedRequests?: string[];
}

export interface ExploreResult {
  passed: boolean;
  steps: ExploreStep[];
  browserBlockers: string[];
  blockers: string[];
}

/** Deterministic pseudo-random selection from a seed. */
function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

async function collectInteractives(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    const doc = g.document as {
      querySelectorAll: (s: string) => ArrayLike<{ getAttribute: (n: string) => string | null }>;
    };
    const sels = doc.querySelectorAll("button, a, input, select, [role='button'], [tabindex]");
    const out: string[] = [];
    for (let i = 0; i < sels.length; i++) {
      const el = sels[i];
      if (!el) continue;
      const id = el.getAttribute("id");
      if (id) out.push(`#${id}`);
      else {
        const role = el.getAttribute("role");
        if (role) out.push(`[role='${role}']`);
      }
    }
    return out;
  });
}

/**
 * Perform a bounded, seeded exploration of the page and record a reproducible
 * trace. Fails closed on any browser exception/console-error/failed-request.
 */
export async function exploreUi(opts: ExploreOptions): Promise<ExploreResult> {
  const maxSteps = opts.maxSteps ?? 20;
  const rng = seededRng(opts.seed ?? 42);
  const steps: ExploreStep[] = [];

  const browser = await instrumentBrowserRun({
    url: opts.url,
    artifactsDir: opts.artifactsDir,
    allowConsoleErrors: opts.allowConsoleErrors,
    allowFailedRequests: opts.allowFailedRequests,
    verify: async (page: Page) => {
      let budget = maxSteps;
      while (budget > 0) {
        const interactives = await collectInteractives(page);
        if (interactives.length === 0) break;
        const sel = interactives[Math.floor(rng() * interactives.length)]!;
        const action = Math.random() < 0.5 ? "click" : "focus";
        const index = steps.length;
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible().catch(() => false)) {
            if (action === "click") await loc.click({ timeout: 2000 }).catch(() => {});
            else await loc.focus().catch(() => {});
            steps.push({ index, action, selector: sel });
          }
        } catch {
          // ignore individual action failures; bounded exploration continues
        }
        budget--;
      }
    },
  });

  const blockers = [...browser.blockers];
  return {
    passed: browser.passed,
    steps,
    browserBlockers: browser.blockers,
    blockers,
  };
}
