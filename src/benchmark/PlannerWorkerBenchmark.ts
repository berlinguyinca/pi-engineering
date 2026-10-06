/**
 * Planner/worker benchmark modes (spec §24, Phase 5).
 *
 *   A  implementer model alone          (e.g. "27B alone")
 *   B  planner model alone              (e.g. "Flash alone")
 *   C  plan → implement → review        (sequential contracts)
 *   D  plan → parallel workers → review (concurrent contracts)
 *
 * Models come from role resolution (aliases/capabilities/families), never
 * from names in this file, so the same benchmark compares whatever the
 * gateway serves. Every run uses a fresh real git repository, real
 * verification commands and the configured WorkerExecutor; nothing is
 * simulated. Raw per-run metrics are kept for re-analysis — this only
 * collects evidence, it does not learn routing.
 *
 * Headline metric: successful engineering work per (GPU time + wall time).
 * GPU time is approximated by the summed inference wall time of all role
 * invocations (the gateway's busy time on our behalf).
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { PlannerWorkerExecutor, runVerification } from "../plannerWorker/executor.ts";
import { estimateTokens } from "../plannerWorker/handoff.ts";
import { IMPLEMENTER_PROMPT } from "../plannerWorker/prompts.ts";
import type { RoleResolver } from "../plannerWorker/resolver.ts";
import { servedIdentity } from "../plannerWorker/roles.ts";
import { RoleModelTelemetry } from "../plannerWorker/telemetry.ts";
import type { MissionBrief, PlannerWorkerRole } from "../plannerWorker/types.ts";
import type { WorkerExecutor } from "../workers/WorkerExecutor.ts";

const exec = promisify(execFile);

export const BENCHMARK_MODES = ["A", "B", "C", "D"] as const;
export type BenchmarkMode = (typeof BENCHMARK_MODES)[number];

export const MODE_LABEL: Readonly<Record<BenchmarkMode, string>> = {
  A: "implementer model alone",
  B: "planner model alone",
  C: "plan -> implement -> review",
  D: "plan -> parallel workers -> review",
};

/** One benchmark task: a repository to build and checks that define success. */
export interface BenchmarkTask {
  id: string;
  kind: string;
  mission: string;
  /** Files of the starting repository (path → content). */
  files: Record<string, string>;
  /** Hidden acceptance checks; all must exit 0 for success. */
  acceptance: string[];
  /** Checks that pass before the change and must still pass after (regressions). */
  regression?: string[];
}

export interface BenchmarkRun {
  task: string;
  kind: string;
  mode: BenchmarkMode;
  success: boolean;
  wall_ms: number;
  /** Summed inference time of all role invocations (GPU-time proxy). */
  inference_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  tool_calls: number;
  invocations: number;
  tests_passed: number;
  tests_total: number;
  retries: number;
  regressions: number;
  reviewer_findings: number;
  /** Largest single prompt (tokens) — context consumption. */
  max_prompt_tokens: number;
  escalations: number;
  models: Partial<Record<PlannerWorkerRole, string>>;
  error: string | null;
}

export interface ModeSummary {
  mode: BenchmarkMode;
  label: string;
  runs: number;
  successes: number;
  success_rate: number;
  mean_wall_ms: number;
  total_tokens: number;
  tool_calls: number;
  retries: number;
  regressions: number;
  reviewer_findings: number;
  escalation_rate: number;
  /** Successful tasks per second of (inference + wall) time. */
  success_per_time: number;
}

export interface BenchmarkOptions {
  worker: WorkerExecutor;
  /** Fresh resolver per run (each run excludes/merges models independently). */
  resolver: () => RoleResolver;
  tasks: BenchmarkTask[];
  modes?: BenchmarkMode[];
  /** Attempts the single-model modes get (with verification feedback). Default 2. */
  soloAttempts?: number;
  /** Parallel workers in mode D. Default 3. */
  parallelism?: number;
  workDir?: string;
}

async function makeRepo(task: BenchmarkTask, workDir: string): Promise<string> {
  const root = await mkdtemp(join(workDir, `pwbench-${task.id}-`));
  await exec("git", ["init", "-q", root]);
  for (const [path, content] of Object.entries(task.files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", [
    "-C",
    root,
    "-c",
    "user.name=bench",
    "-c",
    "user.email=bench@localhost",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
  return root;
}

async function removeRepo(root: string): Promise<void> {
  const list = await exec("git", ["-C", root, "worktree", "list", "--porcelain"]).catch(() => ({ stdout: "" }));
  for (const line of list.stdout.split("\n")) {
    const path = line.startsWith("worktree ") ? line.slice(9) : "";
    if (path && path !== root) await rm(path, { recursive: true, force: true });
  }
  await rm(root, { recursive: true, force: true });
}

async function check(commands: string[], cwd: string): Promise<{ passed: number; total: number }> {
  let passed = 0;
  for (const c of commands) if ((await runVerification(c, cwd, { inactivityMs: 120_000 })).passed) passed++;
  return { passed, total: commands.length };
}

function brief(task: BenchmarkTask, mode: BenchmarkMode): MissionBrief {
  return {
    mission_id: `bench-${task.id}-${mode}-${Date.now().toString(36)}`,
    summary: task.mission,
    architectural_context: [],
    acceptance_criteria: [],
    constraints: [],
  };
}

/** Modes A/B: one model does everything, with verification feedback between attempts. */
async function runSolo(
  opts: BenchmarkOptions,
  task: BenchmarkTask,
  mode: "A" | "B",
  root: string,
  telemetry: RoleModelTelemetry,
): Promise<{ retries: number; maxPrompt: number; model: string }> {
  const role: PlannerWorkerRole = mode === "A" ? "implementer" : "planner";
  const resolved = await opts.resolver().resolve(role);
  const model = resolved ? servedIdentity(resolved) : "default";
  let feedback = "";
  let retries = 0;
  let maxPrompt = 0;
  const attempts = Math.max(1, opts.soloAttempts ?? 2);
  for (let i = 0; i < attempts; i++) {
    const taskText = `mission: ${task.mission}${feedback ? `\n\nPrevious attempt failed verification:\n${feedback}` : ""}`;
    maxPrompt = Math.max(maxPrompt, estimateTokens(IMPLEMENTER_PROMPT + taskText));
    const t0 = Date.now();
    const run = await opts.worker.run({
      role: "implementer",
      task: taskText,
      tools: ["read", "grep", "find", "ls", "write", "edit", "bash"],
      cwd: root,
      systemPromptOverride: IMPLEMENTER_PROMPT,
      ...(resolved ? { modelOverride: resolved.model } : {}),
    });
    telemetry.invocation(role, model, run, Date.now() - t0);
    maxPrompt = Math.max(maxPrompt, run.usage?.input ?? 0);
    const results = [];
    for (const c of task.acceptance) results.push(await runVerification(c, root, { inactivityMs: 120_000 }));
    const failed = results.filter((r) => !r.passed);
    if (failed.length === 0) break;
    feedback = failed.map((f) => `$ ${f.command}\n${f.output_tail.slice(-800)}`).join("\n");
    if (i < attempts - 1) {
      retries++;
      telemetry.count(role, model, "retry");
    }
  }
  return { retries, maxPrompt, model };
}

export async function runPlannerWorkerBenchmark(opts: BenchmarkOptions): Promise<{
  runs: BenchmarkRun[];
  summaries: ModeSummary[];
}> {
  const workDir = opts.workDir ?? tmpdir();
  const modes = opts.modes ?? [...BENCHMARK_MODES];
  const runs: BenchmarkRun[] = [];
  for (const task of opts.tasks) {
    for (const mode of modes) {
      const root = await makeRepo(task, workDir);
      const started = Date.now();
      const telemetry = new RoleModelTelemetry();
      const run: BenchmarkRun = {
        task: task.id,
        kind: task.kind,
        mode,
        success: false,
        wall_ms: 0,
        inference_ms: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
        tool_calls: 0,
        invocations: 0,
        tests_passed: 0,
        tests_total: task.acceptance.length,
        retries: 0,
        regressions: 0,
        reviewer_findings: 0,
        max_prompt_tokens: 0,
        escalations: 0,
        models: {},
        error: null,
      };
      try {
        const before = await check(task.regression ?? [], root);
        let metrics = telemetry.list();
        if (mode === "A" || mode === "B") {
          const solo = await runSolo(opts, task, mode, root, telemetry);
          run.retries = solo.retries;
          run.max_prompt_tokens = solo.maxPrompt;
          run.models[mode === "A" ? "implementer" : "planner"] = solo.model;
          metrics = telemetry.list();
        } else {
          const executor = new PlannerWorkerExecutor({
            repoRoot: root,
            worker: opts.worker,
            resolver: opts.resolver(),
            stateDir: join(root, ".pi-eng", "planner-worker", "bench"),
            concurrency: mode === "D" ? Math.max(2, opts.parallelism ?? 3) : 1,
          });
          const report = await executor.run(brief(task, mode));
          metrics = report.metrics;
          run.retries = metrics.reduce((n, m) => n + m.retries, 0);
          run.reviewer_findings = metrics.reduce((n, m) => n + m.review_failures, 0);
          run.escalations = report.contracts.filter((c) => c.rung === "escalated").length;
          for (const t of report.transitions) run.models[t.role] ??= t.to;
          if (report.status !== "completed") run.error = report.failure_reason ?? report.status;
        }
        for (const m of metrics) {
          run.prompt_tokens += m.prompt_tokens;
          run.completion_tokens += m.completion_tokens;
          run.cached_tokens += m.cached_tokens;
          run.tool_calls += m.tool_calls;
          run.invocations += m.invocations;
          run.inference_ms += m.wall_time_ms;
          if (m.invocations > 0)
            run.max_prompt_tokens = Math.max(run.max_prompt_tokens, Math.round(m.prompt_tokens / m.invocations));
        }
        const accepted = await check(task.acceptance, root);
        run.tests_passed = accepted.passed;
        const after = await check(task.regression ?? [], root);
        run.regressions = Math.max(0, before.passed - after.passed);
        run.success = accepted.passed === accepted.total && run.regressions === 0;
      } catch (err) {
        run.error = err instanceof Error ? err.message : String(err);
      } finally {
        run.wall_ms = Date.now() - started;
        await removeRepo(root);
      }
      runs.push(run);
    }
  }
  return {
    runs,
    summaries: modes.map((m) =>
      summarizeMode(
        m,
        runs.filter((r) => r.mode === m),
      ),
    ),
  };
}

export function summarizeMode(mode: BenchmarkMode, runs: BenchmarkRun[]): ModeSummary {
  const successes = runs.filter((r) => r.success).length;
  const timeS = runs.reduce((s, r) => s + (r.inference_ms + r.wall_ms) / 1000, 0);
  return {
    mode,
    label: MODE_LABEL[mode],
    runs: runs.length,
    successes,
    success_rate: runs.length ? successes / runs.length : 0,
    mean_wall_ms: runs.length ? runs.reduce((s, r) => s + r.wall_ms, 0) / runs.length : 0,
    total_tokens: runs.reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0),
    tool_calls: runs.reduce((s, r) => s + r.tool_calls, 0),
    retries: runs.reduce((s, r) => s + r.retries, 0),
    regressions: runs.reduce((s, r) => s + r.regressions, 0),
    reviewer_findings: runs.reduce((s, r) => s + r.reviewer_findings, 0),
    escalation_rate: runs.length ? runs.filter((r) => r.escalations > 0).length / runs.length : 0,
    success_per_time: timeS > 0 ? successes / timeS : 0,
  };
}

export function renderBenchmarkTable(summaries: ModeSummary[]): string {
  const head =
    "mode  label                                success  wall(s)   tokens  tools retries regr findings esc%  success/(gpu+wall)s";
  const rows = summaries.map(
    (s) =>
      `${s.mode.padEnd(5)} ${s.label.padEnd(36)} ${`${s.successes}/${s.runs}`.padStart(7)} ${(s.mean_wall_ms / 1000).toFixed(1).padStart(8)} ${String(s.total_tokens).padStart(8)} ${String(s.tool_calls).padStart(6)} ${String(s.retries).padStart(7)} ${String(s.regressions).padStart(4)} ${String(s.reviewer_findings).padStart(8)} ${(s.escalation_rate * 100).toFixed(0).padStart(4)}  ${s.success_per_time.toFixed(4)}`,
  );
  return [head, ...rows].join("\n");
}

/** A small built-in task set (Node, no dependencies) for gateway runs. */
export const DEFAULT_BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    id: "math-utils",
    kind: "multi-file",
    mission:
      "Implement src/add.mjs exporting add(a, b) and src/mul.mjs exporting mul(a, b), each with a node:test file under test/ (test/add.test.mjs, test/mul.test.mjs). Keep src/version.mjs unchanged.",
    files: {
      "package.json": '{ "name": "bench", "type": "module", "private": true }\n',
      "src/version.mjs": 'export const version = "1.0.0";\n',
    },
    acceptance: [
      `node -e "import('./src/add.mjs').then(m => process.exit(m.add(2, 3) === 5 ? 0 : 1))"`,
      `node -e "import('./src/mul.mjs').then(m => process.exit(m.mul(2, 3) === 6 ? 0 : 1))"`,
      "node --test test/",
    ],
    regression: [`node -e "import('./src/version.mjs').then(m => process.exit(m.version === '1.0.0' ? 0 : 1))"`],
  },
];
