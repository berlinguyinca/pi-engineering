#!/usr/bin/env node
/**
 * pi-engineering CLI.
 *
 *   node scripts/pi-engineering.ts roadmap check [--json] [--no-refresh]
 *   node scripts/pi-engineering.ts roadmap status [--json]
 *
 * `roadmap check` exit codes:
 *   0  roadmap 1.0 complete (release gate passes)
 *   1  valid roadmap, not yet complete
 *   2  invalid roadmap definition
 *   3  infrastructure/check error
 */
import { resolve } from "node:path";
import { defaultCliPaths, runRoadmapCheck, runRoadmapStatus } from "../src/roadmap/cli.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd !== "roadmap") {
    console.error("usage: pi-engineering <roadmap check|roadmap status> [--json] [--no-refresh]");
    return 2;
  }
  const rest = args.slice(1);
  const json = rest.includes("--json");
  const refresh = !rest.includes("--no-refresh");
  const sub = rest.find((a) => !a.startsWith("--"));
  const paths = defaultCliPaths(REPO_ROOT);
  if (sub === "check") {
    const { exitCode, text } = await runRoadmapCheck({ ...paths, repoRoot: REPO_ROOT, json, refresh });
    console.log(text);
    return exitCode;
  }
  if (sub === "status") {
    const { exitCode, text } = await runRoadmapStatus({ ...paths, repoRoot: REPO_ROOT, json, refresh: false });
    console.log(text);
    return exitCode;
  }
  console.error("usage: pi-engineering <roadmap check|roadmap status> [--json] [--no-refresh]");
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(String(err));
    process.exitCode = 3;
  });
