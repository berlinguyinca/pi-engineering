/**
 * `pi-engineering task ...` — materialize plan tasks, and ask whether a finished task proved itself.
 *
 * `materialize` reads the plan the way the runtime reads it (manifest first, prose second) and answers the
 * questions that are expensive to discover after workers start: is this id used twice, does a task depend
 * on something that does not exist, is there a cycle, and would each task's Task Contract even validate.
 * Contract *drafts* are validated and hashed here; they are only ever written when `--write-dir` is passed,
 * because a contract file is authorization and authorization is an explicit, reviewed artifact.
 *
 * `handoff-check` runs the same verifier the bootstrapping audit uses, so "the trail is clean" means the same
 * thing in both places: one canonical record per planned task, schema-valid, hash-stamped, every declared
 * artifact present and committed, nothing of the run still alive.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkHandoffTrail, materializeTasks } from "./taskWorkflowService.ts";

const USAGE = `usage: pi-engineering task <materialize|handoff-check> [flags]

  materialize  (--plan <file> | --trail <dir> | --specs-dir <dir>) [--template <contract.json>]
               [--write-dir <dir>] [--json]
        Turns a plan into a checked task list: duplicates, unknown dependencies, cycles, and a validated
        Task Contract draft per task. Read-only unless --write-dir is given; a contract draft is not
        authorization until it is reviewed and written.

  handoff-check --trail <dir> [--rev <ref>] [--repo-root <dir>] [--no-committed] [--no-live] [--json]
        Verifies a handoff trail: one canonical record per planned task, schema-valid, hash-stamped,
        declared artifacts present (and committed at --rev, default HEAD), no live runner left behind.

Exit codes: 0 verified/known, 1 problems found, 2 usage, 3 the inputs could not be read.`;

function values(args: string[], flag: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1] !== undefined) {
      found.push(args[index + 1]!);
      index += 1;
    } else if (args[index]?.startsWith(`${flag}=`)) {
      found.push(args[index]!.slice(flag.length + 1));
    }
  }
  return found;
}

export async function runTaskWorkflowCli(
  args: string[],
  io: { write?: (value: string) => void; error?: (value: string) => void; cwd?: string; repoRoot?: string } = {},
): Promise<number> {
  const out = io.write ?? ((value: string) => process.stdout.write(value));
  const err = io.error ?? ((value: string) => process.stderr.write(value));
  const cwd = io.cwd ?? process.cwd();
  const verb = args[0];
  const rest = args.slice(1);
  const json = rest.includes("--json");

  if (verb === "materialize") {
    const plan = values(rest, "--plan")[0] ?? null;
    const trail = values(rest, "--trail")[0] ?? null;
    const specs = values(rest, "--specs-dir")[0] ?? null;
    if (plan === null && trail === null && specs === null) {
      err(`materialize needs one of --plan, --trail, --specs-dir\n${USAGE}\n`);
      return 2;
    }
    const templateFile = values(rest, "--template")[0] ?? null;
    let template: Record<string, unknown> | null = null;
    if (templateFile !== null) {
      try {
        template = JSON.parse(readFileSync(resolve(cwd, templateFile), "utf8")) as Record<string, unknown>;
      } catch (error) {
        err(`--template ${templateFile}: ${error instanceof Error ? error.message : String(error)}\n`);
        return 3;
      }
    }
    const report = materializeTasks({
      planFile: plan !== null ? resolve(cwd, plan) : null,
      trailDir: trail !== null ? resolve(cwd, trail) : null,
      specsDir: specs !== null ? resolve(cwd, specs) : null,
      repoRoot: io.repoRoot ?? cwd,
      template,
      writeDir: values(rest, "--write-dir")[0] !== undefined ? resolve(cwd, values(rest, "--write-dir")[0]!) : null,
    });
    const text = (): string =>
      [
        `${report.ok ? "MATERIALIZED" : "NOT MATERIALIZED"}: ${report.tasks.length} task(s) from ${report.inputs.length} input(s)`,
        ...report.tasks.map((task) => `  ${task.id} depends=[${task.dependsOn.join(", ")}] ${task.title}${task.sources.length > 1 ? ` (${task.sources.join(", ")})` : ""}`),
        ...report.duplicates.map((entry) => `  DUPLICATE ${entry.id}: ${entry.sources.join(", ")}`),
        ...report.unknownDependencies.map((entry) => `  UNKNOWN DEPENDENCY ${entry.taskId} -> ${entry.dependency}`),
        ...report.cycles.map((cycle) => `  CYCLE ${cycle}`),
        ...(report.contracts.length > 0
          ? report.contracts.map((draft) => `  contract ${draft.taskId}: ${draft.ok ? `valid hash=${draft.hash?.slice(0, 16)}…` : `INVALID ${draft.error}`}`)
          : [`  contracts: ${report.contractReason ?? "none"}`]),
        ...report.problems.map((problem) => `  problem: ${problem}`),
        ...(report.written !== undefined ? [`  wrote ${report.written.length} file(s) to ${report.written[0] ?? ""} (review before a worker runs under one)`] : []),
      ].join("\n");
    out(json ? `${JSON.stringify(report, null, 2)}\n` : `${text()}\n`);
    return report.ok ? 0 : 1;
  }

  if (verb === "handoff-check") {
    const trail = values(rest, "--trail")[0] ?? null;
    if (trail === null) {
      err(`handoff-check needs --trail <dir>\n${USAGE}\n`);
      return 2;
    }
    const report = checkHandoffTrail({
      trail: resolve(cwd, trail),
      repoRoot: values(rest, "--repo-root")[0] !== undefined ? resolve(cwd, values(rest, "--repo-root")[0]!) : io.repoRoot,
      rev: values(rest, "--rev")[0] ?? "HEAD",
      checkCommitted: !rest.includes("--no-committed"),
      checkLive: !rest.includes("--no-live"),
    });
    if (report.reason !== undefined && report.verdict === undefined) {
      err(`handoff-check ${report.trail}: ${report.reason}\n`);
      return 3;
    }
    const text = (): string =>
      [
        `trail=${report.trail} rev=${report.rev} planned=${report.planned} canonical=${report.canonical} superseded=${report.superseded} liveRunners=${report.liveRunners} unattributedRunners=${report.unattributedRunners} unreadGenerations=${report.unreadGenerations.length}`,
        ...report.unreadGenerations.map((entry) => `  unread-generation ${entry}`),
        ...report.issues.map((issue) => `  ${issue.kind} ${issue.taskId ?? "-"}: ${issue.detail}`),
        ...(report.reason !== undefined ? [`  note: ${report.reason}`] : []),
        `${report.ok ? "VERIFIED" : "NOT VERIFIED"}: ${report.issues.length} issue(s)`,
      ].join("\n");
    out(json ? `${JSON.stringify(report, null, 2)}\n` : `${text()}\n`);
    return report.ok ? 0 : 1;
  }

  err(`unknown task verb ${String(verb)}\n${USAGE}\n`);
  return 2;
}
