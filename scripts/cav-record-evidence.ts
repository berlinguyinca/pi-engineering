#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { CavEvidenceLedger, cavPaths } from "../src/cav/index.ts";

/**
 * Record deterministic verification evidence for the current CAV step into the
 * CAV evidence ledger.
 *
 * ROLE MODEL: this recorder runs as the IMPLEMENTER and therefore can record
 * SPECIFIED/IMPLEMENTED/TESTED evidence but CANNOT write VERIFIED. Promotion to
 * VERIFIED is a separate, role-gated action performed by an independent
 * reviewer (see promote). This enforces the MASTER.md rule that the implementer
 * may not mark its own requirement VERIFIED.
 *
 * Usage:
 *   node --experimental-strip-types scripts/cav-record-evidence.ts <requirement-id> --gate <name> --cmd "<command>"
 *   e.g. node --experimental-strip-types scripts/cav-record-evidence.ts CAV-00-01 --gate typecheck --cmd "npx tsc --noEmit"
 */
const REPO_ROOT = resolve(import.meta.dirname, "..");

function run(cmd: string): { exitCode: number; status: "passed" | "failed" } {
  try {
    execFileSync(cmd, { shell: true, cwd: REPO_ROOT, stdio: "pipe" });
    return { exitCode: 0, status: "passed" };
  } catch (err) {
    const e = err as { status?: number };
    return { exitCode: e.status ?? 1, status: "failed" };
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const requirementId = args.find((a) => !a.startsWith("--"));
  if (!requirementId) {
    console.error("usage: cav-record-evidence.ts <requirement-id> --gate <name> --cmd <command>");
    return 2;
  }
  const gateIdx = args.indexOf("--gate");
  const cmdIdx = args.indexOf("--cmd");
  const gate = gateIdx >= 0 ? args[gateIdx + 1] : "unit";
  const command = cmdIdx >= 0 ? args[cmdIdx + 1] : "";

  const { stepsDir, ledgerFile } = cavPaths(REPO_ROOT);
  const { loadCavSteps } = await import("../src/cav/index.ts");
  const steps = loadCavSteps(stepsDir);
  const step = steps.find((s) => s.id === requirementId);
  if (!step) {
    console.error(`unknown CAV step: ${requirementId}`);
    return 2;
  }

  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  const { exitCode, status } = run(command);

  const ledger = await CavEvidenceLedger.open(ledgerFile);
  const ev = await ledger.record(requirementId, status === "passed" ? "TESTED" : "SPECIFIED", {
    gitSha,
    role: "implementer",
    workerRunId: process.env.PI_RUN_ID ?? `run-${Date.now().toString(36)}`,
    gateType: gate,
    tool: command.split(" ")[0] ?? "node",
    command,
    exitCode,
    environment: `node ${process.version}`,
    failureReason: status === "failed" ? `gate '${gate}' exited ${exitCode}` : null,
  });
  console.log(
    JSON.stringify(
      {
        recorded: ev.id,
        requirement: requirementId,
        status: ev.status,
        role: ev.role,
        exitCode,
        gitSha,
        gate,
        // NOTE: not VERIFIED — promotion requires an independent reviewer role.
        verified: false,
      },
      null,
      2,
    ),
  );
  return status === "passed" ? 0 : 1;
}

main()
  .then((c) => {
    process.exitCode = c;
  })
  .catch((err) => {
    console.error(String(err));
    process.exitCode = 3;
  });
