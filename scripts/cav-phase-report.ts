#!/usr/bin/env node
import { resolve } from "node:path";
import { CavEvidenceLedger, cavPaths, evaluatePhaseGate, groupPhases, loadCavSteps } from "../src/cav/index.ts";

/**
 * Produce a machine-readable phase-gate report for the CAV roadmap.
 *
 * This is the deterministic gate that prevents a later phase from starting
 * before the preceding phase's exit gate has real evidence. It reads the CAV
 * evidence ledger and reports, per phase, how many steps are VERIFIED and any
 * blockers. Exit code 0 iff the requested phase (or all phases) is PASS.
 *
 * Usage:
 *   node --experimental-strip-types scripts/cav-phase-report.ts [phase-id]
 *   node --experimental-strip-types scripts/cav-phase-report.ts --json
 */
const REPO_ROOT = resolve(import.meta.dirname, "..");

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const target = args.find((a) => !a.startsWith("--"));
  const { stepsDir, ledgerFile } = cavPaths(REPO_ROOT);
  const steps = loadCavSteps(stepsDir);
  const ledger = await CavEvidenceLedger.open(ledgerFile);
  const phases = groupPhases(steps);
  const gates = phases.map((p) => evaluatePhaseGate(p, ledger));

  const verified = steps.filter((s) => ledger.latestStatus(s.id) === "VERIFIED").length;

  if (json) {
    console.log(
      JSON.stringify(
        {
          total_steps: steps.length,
          verified_steps: verified,
          phases: gates.map((g) => ({
            id: g.phase.id,
            name: g.phase.name,
            state: g.state,
            verified: g.verifiedSteps,
            total: g.totalSteps,
            blockers: g.blockers,
            waivers: g.waivers,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    const lines: string[] = [`CAV phase gate report — ${verified}/${steps.length} steps VERIFIED`];
    for (const g of gates) {
      const marker = target && g.phase.id === target ? " >>" : "  ";
      lines.push(`${marker} ${g.phase.id} ${g.phase.name}: ${g.state} (${g.verifiedSteps}/${g.totalSteps})`);
      for (const b of g.blockers) lines.push(`      \u2022 ${b}`);
    }
    console.log(lines.join("\n"));
  }

  // Exit 0 only if every phase (or the requested phase) is PASS.
  const relevant = target ? gates.filter((g) => g.phase.id === target) : gates;
  const allPass = relevant.length > 0 && relevant.every((g) => g.state === "PASS");
  return allPass ? 0 : 1;
}

main()
  .then((c) => {
    process.exitCode = c;
  })
  .catch((err) => {
    console.error(String(err));
    process.exitCode = 3;
  });
