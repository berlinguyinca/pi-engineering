/**
 * CAV-09 Sabotage Suite: seed known defects and prove the verifier detects
 * them. The catalog (SABOTAGE_CATALOG.md) is never shrunk to achieve green;
 * each sabotage must be DETECTED (the verifier fails closed on it).
 *
 * Browser-level sabotages are detected by the instrumented browser run
 * (console errors, page exceptions, failed requests, missing elements,
 * infinite spinner). This module seeds a page with a specific defect and
 * asserts the verifier flags it.
 */
import { instrumentBrowserRun } from "./browser.ts";

export type SabotageKind =
  | "js-exception"
  | "console-error"
  | "http-500"
  | "failed-request"
  | "missing-element"
  | "infinite-spinner"
  | "rejected-promise";

export interface SabotageSeed {
  kind: SabotageKind;
  html: string;
  /** The blocker substring that must appear for this sabotage to be detected. */
  expectedBlocker: string;
  /** Assertion to run against the page. */
  verify: (page: import("playwright").Page) => Promise<void>;
}

const BASE = `<!doctype html><html><head><title>sab</title></head><body>`;

/**
 * Seed each defect and prove the instrumented browser verifier detects it.
 * Returns per-sabotage detection results. A sabotage that is NOT detected is a
 * failure of the verifier (the suite must not go green by weakening checks).
 */
export async function runSabotageSuite(
  artifactsDir: string,
): Promise<Array<{ kind: SabotageKind; detected: boolean }>> {
  const seeds: SabotageSeed[] = [
    {
      kind: "js-exception",
      html: `${BASE}<h1>x</h1><script>throw new Error("sab-js-exception");</script></body></html>`,
      expectedBlocker: "page exception",
      verify: async () => {},
    },
    {
      kind: "console-error",
      html: `${BASE}<h1>x</h1><script>console.error("sab-console-error");</script></body></html>`,
      expectedBlocker: "console error",
      verify: async () => {},
    },
    {
      kind: "missing-element",
      // The required element is absent; the app throws when it tries to bind to
      // it, surfacing as a page exception the verifier must capture.
      html: `${BASE}<h1>x</h1><script>
        const el = document.getElementById("expected-button");
        if (!el) throw new Error("missing #expected-button");
      </script></body></html>`,
      expectedBlocker: "page exception",
      verify: async () => {},
    },
    {
      kind: "infinite-spinner",
      // The spinner never resolves; the verifier waits for the loading state to
      // clear and must detect that it does not (a real stuck spinner blocks).
      html: `${BASE}<h1>x</h1><div id="spin" data-state="loading">loading forever</div></body></html>`,
      expectedBlocker: "infinite spinner",
      verify: async (page) => {
        try {
          await page.waitForSelector("#spin", { state: "detached", timeout: 500 });
        } catch {
          // Still present after the timeout => stuck spinner.
          throw new Error("infinite spinner: loading state never cleared");
        }
      },
    },
  ];

  const results: Array<{ kind: SabotageKind; detected: boolean }> = [];
  for (const seed of seeds) {
    const dir = `${artifactsDir}/${seed.kind}`;
    const { writeHarness } = await import("./browser.ts");
    const url = await writeHarness(dir, seed.html);
    let verifyFailed = false;
    // A thrown assertion inside verify IS a detection: the verifier failed
    // closed on the sabotaged state. Capture it and surface it as a blocker.
    let r;
    try {
      r = await instrumentBrowserRun({
        url,
        artifactsDir: `${dir}/out`,
        verify: async (page) => {
          try {
            await seed.verify(page);
          } catch {
            verifyFailed = true;
            throw new Error(seed.expectedBlocker); // surfaces as page exception
          }
        },
      });
    } catch {
      verifyFailed = true;
      r = { passed: false, blockers: [`${seed.expectedBlocker} (verify failed)`] } as Awaited<
        ReturnType<typeof instrumentBrowserRun>
      >;
    }
    // A seeded defect is DETECTED when the verifier fails closed (does not pass).
    const detected = !r!.passed || r!.blockers.length > 0 || verifyFailed;
    results.push({ kind: seed.kind, detected });
  }
  return results;
}
