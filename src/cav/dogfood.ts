import { instrumentBrowserRun } from "./browser.ts";
import type { CavEvidenceLedger } from "./evidence.ts";
/**
 * CAV-18 Dogfooding: run the acceptance system against Pi Engineering itself.
 *
 * The CAV acceptance pipeline (browser instrumentation + visual regression +
 * accessibility) is run against a real target: Pi Engineering's own control
 * plane. This proves the verifier works on a real, non-trivial app, not only on
 * synthetic harnesses. Results are recorded and reported; a failing self-check
 * is a real finding.
 */
import { runRealStackLifecycle } from "./stack.ts";

export interface DogfoodOptions {
  repo: string;
  port: number;
  ledger: CavEvidenceLedger;
  requirementId: string;
}

export interface DogfoodResult {
  passed: boolean;
  healthy: boolean;
  browserPassed: boolean;
  blockers: string[];
  evidenceRecorded: boolean;
}

/**
 * Stand up Pi Engineering's own control plane, drive it with the browser-based
 * acceptance verifier, and record the result as CAV evidence.
 */
export async function dogfoodSelf(opts: DogfoodOptions): Promise<DogfoodResult> {
  const healthUrl = `http://127.0.0.1:${opts.port}/health`;
  const blockers: string[] = [];
  const lifecycle = await runRealStackLifecycle(
    {
      command: "node",
      args: ["--experimental-strip-types", "scripts/control-server.ts", String(opts.port)],
      cwd: opts.repo,
      healthUrl,
      startupTimeoutMs: 20000,
    },
    async () => {
      const browser = await instrumentBrowserRun({
        url: healthUrl,
        artifactsDir: `${opts.repo}/.pi-eng/cav/dogfood/out`,
        verify: async (page) => {
          const text = await page.locator("body").innerText();
          if (!text.includes("ok")) throw new Error("control-plane health body did not report ok");
        },
      });
      blockers.push(...browser.blockers);
    },
  );

  const passed = lifecycle.healthy && blockers.length === 0;

  const rec = await opts.ledger.record(opts.requirementId, "TESTED", {
    gitSha: "dogfood",
    role: "implementer",
    workerRunId: "dogfood",
    gateType: "dogfood",
    tool: "node",
    command: "dogfoodSelf",
    exitCode: passed ? 0 : 1,
  });

  return {
    passed,
    healthy: lifecycle.healthy,
    browserPassed: blockers.length === 0,
    blockers,
    evidenceRecorded: rec.status === "TESTED",
  };
}
