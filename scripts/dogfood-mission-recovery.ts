#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  MISSION_SNAPSHOT_CONTRACT_VERSION,
  type MissionSnapshotFile,
  type MissionSnapshotMission,
} from "../src/orchestration/missionSnapshot.ts";

const exec = promisify(execFile);
const REQUIRED_MODEL = "local/local";
const STOPPED_STATES = new Set(["BLOCKED", "WAITING_FOR_USER", "PAUSED_INFRASTRUCTURE", "NEEDS_ATTENTION"]);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function configuredModel(): string {
  return argument("--model") ?? process.env.PI_MISSION_DOGFOOD_MODEL ?? REQUIRED_MODEL;
}

function assertLocalOnly(model: string): void {
  if (model !== REQUIRED_MODEL)
    throw new Error(`mission-recovery dogfood requires exactly ${REQUIRED_MODEL}; refused ${model}`);
  const disabledValues = new Set(["0", "false", "no", "off", "disabled"]);
  const enabledValues = new Set(["1", "true", "yes", "on", "enabled"]);
  const enabledMetabolomics = Object.entries(process.env).filter(([name, value]) => {
    if (!name.includes("METABOLOMICS") || typeof value !== "string" || value.trim() === "") return false;
    const normalized = value.trim().toLowerCase();
    if (name.includes("DISABLED") && enabledValues.has(normalized)) return false;
    if (name.includes("ENABLED") && disabledValues.has(normalized)) return false;
    return true;
  });
  if (enabledMetabolomics.length > 0) {
    throw new Error(
      `mission-recovery dogfood requires metabolomics absent/disabled; found ${enabledMetabolomics.map(([name]) => name).join(", ")}`,
    );
  }
}

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep));
}

async function gitValue(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await exec("git", ["-C", cwd, ...args])).stdout.trim() || null;
  } catch {
    return null;
  }
}

async function installedPackage(pi: string, expectedSha: string): Promise<string> {
  const listing = await exec(pi, ["--no-extensions", "list"], { maxBuffer: 4 * 1024 * 1024 });
  const candidates = [
    ...new Set(
      listing.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("/")),
    ),
  ];
  const matches: string[] = [];
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const manifest = JSON.parse(await readFile(join(canonical, "package.json"), "utf8")) as { name?: string };
      if (manifest.name === "pi-engineering-runtime") matches.push(canonical);
    } catch {
      // Only a valid installed package path qualifies.
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length !== 1)
    throw new Error(`expected exactly one installed pi-engineering-runtime package path; found ${unique.length}`);
  const installedSha = await gitValue(unique[0]!, ["rev-parse", "HEAD"]);
  if (!installedSha || installedSha !== expectedSha) {
    throw new Error(`installed package SHA mismatch: expected ${expectedSha}, found ${installedSha ?? "none"}`);
  }
  const [tracked, staged, status] = await Promise.all([
    exec("git", ["-C", unique[0]!, "diff", "--quiet"]).then(
      () => true,
      () => false,
    ),
    exec("git", ["-C", unique[0]!, "diff", "--cached", "--quiet"]).then(
      () => true,
      () => false,
    ),
    exec("git", ["-C", unique[0]!, "status", "--porcelain=v2", "--untracked-files=all", "-z"]),
  ]);
  if (!tracked || !staged || status.stdout.length > 0) {
    throw new Error(`installed package is not clean at ${unique[0]}`);
  }
  return unique[0]!;
}

async function safeTempParent(candidate: string, protectedPaths: string[]): Promise<string> {
  const canonical = await realpath(candidate);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`temporary parent is not a directory: ${canonical}`);
  const worktree = await gitValue(canonical, ["rev-parse", "--show-toplevel"]);
  if (worktree) throw new Error(`refusing temporary parent inside Git worktree ${worktree}: ${canonical}`);
  for (const protectedPath of protectedPaths) {
    const protectedCanonical = await realpath(protectedPath);
    if (isWithin(protectedCanonical, canonical) || isWithin(canonical, protectedCanonical)) {
      throw new Error(
        `refusing temporary parent overlapping protected project path ${protectedCanonical}: ${canonical}`,
      );
    }
  }
  return canonical;
}

function assertActionableOutcome(mission: MissionSnapshotMission, repository: string): void {
  if (mission.status === "COMPLETE") {
    const observability = mission.observability;
    if (
      !observability ||
      !observability.progress.verifiedComplete ||
      observability.completionStatus !== "verified_complete" ||
      observability.acceptanceCoverage.total === 0 ||
      observability.acceptanceCoverage.completed !== observability.acceptanceCoverage.total
    ) {
      throw new Error(`mission ${mission.id} is COMPLETE without current verified acceptance evidence`);
    }
    return;
  }
  if (mission.status === "FAILED" || mission.status === "CANCELED") {
    throw new Error(
      `mission ${mission.id} ended ${mission.status}; inspect preserved temporary repository ${repository}`,
    );
  }
  const stop = mission.stop;
  if (
    !STOPPED_STATES.has(mission.status) ||
    !stop?.reason.trim() ||
    !stop.resumeCondition.trim() ||
    stop.preservedWork.length === 0 ||
    stop.attemptedRecoveries.length === 0
  ) {
    throw new Error(`mission ${mission.id} has neither verified completion nor a complete actionable stop`);
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "string") throw new Error(`${path} must be a string${nullable ? " or null" : ""}`);
}

function nonempty(value: unknown, path: string): asserts value is string {
  stringValue(value, path);
  if (!(value as string).trim()) throw new Error(`${path} must be nonempty`);
}

function count(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0)
    throw new Error(`${path} must be a finite nonnegative integer`);
}

function stringArray(value: unknown, path: string, requireNonempty = false): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || (requireNonempty && !entry.trim())))
    throw new Error(`${path} must be an array of ${requireNonempty ? "nonempty " : ""}strings`);
  if (requireNonempty && value.length === 0) throw new Error(`${path} must not be empty`);
}

function optionalString(container: Record<string, unknown>, field: string, path: string, nullable = false): void {
  if (container[field] !== undefined) stringValue(container[field], `${path}.${field}`, nullable);
}

function validateSnapshot(value: unknown): MissionSnapshotFile {
  const snapshot = record(value, "snapshot");
  if (snapshot.contractVersion !== MISSION_SNAPSHOT_CONTRACT_VERSION)
    throw new Error(
      `unsupported mission snapshot contract ${String(snapshot.contractVersion)}; expected ${MISSION_SNAPSHOT_CONTRACT_VERSION}`,
    );
  nonempty(snapshot.generatedAt, "snapshot.generatedAt");
  if (!Array.isArray(snapshot.missions)) throw new Error("snapshot.missions must be an array");
  for (const [index, rawMission] of snapshot.missions.entries()) {
    const path = `snapshot.missions[${index}]`;
    const mission = record(rawMission, path);
    for (const field of ["id", "title", "goal", "workflowClass", "status", "riskProfile"])
      nonempty(mission[field], `${path}.${field}`);
    count(mission.revision, `${path}.revision`);
    for (const field of ["constraints", "requiredGates"]) stringArray(mission[field], `${path}.${field}`);
    for (const field of ["acceptanceCriteria", "tasks", "findings"])
      if (!Array.isArray(mission[field])) throw new Error(`${path}.${field} must be an array`);
    for (const [criterionIndex, rawCriterion] of (mission.acceptanceCriteria as unknown[]).entries()) {
      const criterion = record(rawCriterion, `${path}.acceptanceCriteria[${criterionIndex}]`);
      if (criterion.id !== undefined) nonempty(criterion.id, `${path}.acceptanceCriteria[${criterionIndex}].id`);
      nonempty(criterion.criterion, `${path}.acceptanceCriteria[${criterionIndex}].criterion`);
      nonempty(criterion.status, `${path}.acceptanceCriteria[${criterionIndex}].status`);
    }
    for (const [taskIndex, rawTask] of (mission.tasks as unknown[]).entries()) {
      const task = record(rawTask, `${path}.tasks[${taskIndex}]`);
      for (const field of ["id", "kind", "role", "status", "objective", "isolation"])
        nonempty(task[field], `${path}.tasks[${taskIndex}].${field}`);
      if (typeof task.mutatesRepo !== "boolean")
        throw new Error(`${path}.tasks[${taskIndex}].mutatesRepo must be boolean`);
      stringArray(task.dependsOn, `${path}.tasks[${taskIndex}].dependsOn`);
      if (task.reliability !== undefined) {
        const reliability = record(task.reliability, `${path}.tasks[${taskIndex}].reliability`);
        optionalString(reliability, "repoId", `${path}.tasks[${taskIndex}].reliability`);
        stringArray(reliability.acceptanceIds, `${path}.tasks[${taskIndex}].reliability.acceptanceIds`);
        for (const field of ["candidateGeneration", "missionGeneration", "fencingToken"])
          count(reliability[field], `${path}.tasks[${taskIndex}].reliability.${field}`);
      }
    }
    for (const [findingIndex, rawFinding] of (mission.findings as unknown[]).entries()) {
      const finding = record(rawFinding, `${path}.findings[${findingIndex}]`);
      for (const field of ["id", "severity", "status", "summary"])
        nonempty(finding[field], `${path}.findings[${findingIndex}].${field}`);
      stringValue(finding.taskId, `${path}.findings[${findingIndex}].taskId`, true);
    }
    const observability = record(mission.observability, `${path}.observability`);
    const progress = record(observability.progress, `${path}.observability.progress`);
    count(progress.approximatePercent, `${path}.observability.progress.approximatePercent`);
    if (typeof progress.verifiedComplete !== "boolean")
      throw new Error(`${path}.observability.progress.verifiedComplete must be boolean`);
    nonempty(progress.basis, `${path}.observability.progress.basis`);
    const coverage = record(observability.acceptanceCoverage, `${path}.observability.acceptanceCoverage`);
    for (const field of ["completed", "total", "approximatePercent"])
      count(coverage[field], `${path}.observability.acceptanceCoverage.${field}`);
    for (const section of ["workflowProgress", "workers", "tests", "review", "recoveryAttempt", "changes"])
      record(observability[section], `${path}.observability.${section}`);
    const workflow = record(observability.workflowProgress, `${path}.observability.workflowProgress`);
    for (const field of ["completed", "total", "approximatePercent"])
      count(workflow[field], `${path}.observability.workflowProgress.${field}`);
    nonempty(workflow.basis, `${path}.observability.workflowProgress.basis`);
    const workers = record(observability.workers, `${path}.observability.workers`);
    for (const field of ["active", "waiting", "failed"])
      count(workers[field], `${path}.observability.workers.${field}`);
    const tests = record(observability.tests, `${path}.observability.tests`);
    if (typeof tests.running !== "boolean") throw new Error(`${path}.observability.tests.running must be boolean`);
    for (const field of ["completed", "total", "passed", "failed", "skipped"])
      count(tests[field], `${path}.observability.tests.${field}`);
    stringArray(tests.failures, `${path}.observability.tests.failures`);
    const review = record(observability.review, `${path}.observability.review`);
    nonempty(review.status, `${path}.observability.review.status`);
    count(review.blockingOpen, `${path}.observability.review.blockingOpen`);
    if (!Array.isArray(review.findings)) throw new Error(`${path}.observability.review.findings must be an array`);
    const recoveryAttempt = record(observability.recoveryAttempt, `${path}.observability.recoveryAttempt`);
    count(recoveryAttempt.attempt, `${path}.observability.recoveryAttempt.attempt`);
    count(recoveryAttempt.maxAttempts, `${path}.observability.recoveryAttempt.maxAttempts`);
    for (const field of ["health", "completionStatus", "action", "reason", "nextAction"])
      stringValue(observability[field], `${path}.observability.${field}`);
    for (const field of ["progressHistory", "workerDetails", "activity", "errors", "recovery", "artifacts"])
      if (!Array.isArray(observability[field])) throw new Error(`${path}.observability.${field} must be an array`);
    stringArray(observability.preservedWork, `${path}.observability.preservedWork`);
    optionalString(observability, "currentObjective", `${path}.observability`);
    optionalString(observability, "lastHeartbeatAt", `${path}.observability`);
    optionalString(observability, "waitingReason", `${path}.observability`);
    if (observability.currentActivity !== undefined && observability.currentActivity !== null) {
      const activity = record(observability.currentActivity, `${path}.observability.currentActivity`);
      nonempty(activity.type, `${path}.observability.currentActivity.type`);
      nonempty(activity.summary, `${path}.observability.currentActivity.summary`);
      optionalString(activity, "workerId", `${path}.observability.currentActivity`);
    }
    for (const [historyIndex, rawHistory] of (observability.progressHistory as unknown[]).entries()) {
      const history = record(rawHistory, `${path}.observability.progressHistory[${historyIndex}]`);
      nonempty(history.at, `${path}.observability.progressHistory[${historyIndex}].at`);
      count(history.approximatePercent, `${path}.observability.progressHistory[${historyIndex}].approximatePercent`);
      optionalString(history, "label", `${path}.observability.progressHistory[${historyIndex}]`);
    }
    for (const [findingIndex, rawFinding] of (review.findings as unknown[]).entries()) {
      const finding = record(rawFinding, `${path}.observability.review.findings[${findingIndex}]`);
      for (const field of ["id", "severity", "status", "summary"])
        nonempty(finding[field], `${path}.observability.review.findings[${findingIndex}].${field}`);
      if (typeof finding.repaired !== "boolean")
        throw new Error(`${path}.observability.review.findings[${findingIndex}].repaired must be boolean`);
    }
    const changes = record(observability.changes, `${path}.observability.changes`);
    optionalString(changes, "branch", `${path}.observability.changes`);
    optionalString(changes, "worktree", `${path}.observability.changes`);
    stringArray(changes.changedFiles, `${path}.observability.changes.changedFiles`);
    stringArray(changes.commits, `${path}.observability.changes.commits`);
    nonempty(changes.integrationState, `${path}.observability.changes.integrationState`);
    stringArray(observability.artifacts, `${path}.observability.artifacts`);
    stringValue(observability.lastMeaningfulProgressAt, `${path}.observability.lastMeaningfulProgressAt`, true);
    stringValue(observability.nextActionAt, `${path}.observability.nextActionAt`, true);
    stringValue(observability.owner, `${path}.observability.owner`, true);
    stringValue(observability.repository, `${path}.observability.repository`, true);
    stringValue(observability.task, `${path}.observability.task`, true);
    if (mission.status === "COMPLETE") {
      if (
        coverage.total === 0 ||
        coverage.completed !== coverage.total ||
        coverage.approximatePercent !== 100 ||
        progress.verifiedComplete !== true ||
        observability.completionStatus !== "verified_complete"
      )
        throw new Error(`${path} is COMPLETE without current verified acceptance evidence`);
      if (review.status !== "approved" || review.blockingOpen !== 0)
        throw new Error(`${path} is COMPLETE without current approved review evidence`);
      if (tests.running !== false || tests.total === 0 || tests.completed !== tests.total || tests.failed !== 0)
        throw new Error(`${path} is COMPLETE without current successful validation evidence`);
      if (
        (mission.acceptanceCriteria as unknown[]).length === 0 ||
        coverage.total !== (mission.acceptanceCriteria as unknown[]).length
      )
        throw new Error(`${path} is COMPLETE without acceptance coverage for the declared criteria`);
    } else if (STOPPED_STATES.has(mission.status as string)) {
      const stop = record(mission.stop, `${path}.stop`);
      nonempty(stop.reason, `${path}.stop.reason`);
      nonempty(stop.resumeCondition, `${path}.stop.resumeCondition`);
      nonempty(stop.stoppedAt, `${path}.stop.stoppedAt`);
      stringArray(stop.attemptedRecoveries, `${path}.stop.attemptedRecoveries`, true);
      stringArray(stop.preservedWork, `${path}.stop.preservedWork`, true);
      stringArray(observability.preservedWork, `${path}.observability.preservedWork`, true);
    }
  }
  return value as MissionSnapshotFile;
}

async function main(): Promise<void> {
  const model = configuredModel();
  assertLocalOnly(model);
  const pi = argument("--pi") ?? process.env.PI_CLI_BIN?.trim() ?? "pi";
  const sourceOnly = process.argv.includes("--source-only");
  const sourceRoot = await realpath(resolve(import.meta.dirname, ".."));
  const extension = join(sourceRoot, "extensions", "index.ts");
  const expectedSha = argument("--expected-sha") ?? (await gitValue(sourceRoot, ["rev-parse", "HEAD"]));
  if (!expectedSha) throw new Error("cannot determine expected pi-engineering package SHA");
  const installed = sourceOnly ? null : await installedPackage(pi, expectedSha);
  const catalog = await exec(pi, sourceOnly ? ["--no-extensions", "--list-models"] : ["--list-models"], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const catalogLines = catalog.stdout.split(/\r?\n/).map((line) => line.trim());
  if (!catalogLines.some((line) => /^local\s+local(?:\s|$)/.test(line)))
    throw new Error("installed Pi CLI does not advertise the required local/local model");
  if (catalogLines.some((line) => /^metabolomics\s+/i.test(line)))
    throw new Error("installed Pi CLI still advertises metabolomics; disable/remove it before dogfood");

  const parent = await safeTempParent(argument("--temp-parent") ?? tmpdir(), [
    sourceRoot,
    dirname(extension),
    ...(installed ? [installed] : []),
  ]);

  // Every guard above intentionally runs before repository creation.
  const repository = await mkdtemp(join(parent, "pi-mission-recovery-dogfood-"));
  await exec("git", ["init", "-q", repository]);
  await exec("git", ["-C", repository, "config", "user.email", "mission-dogfood@example.invalid"]);
  await exec("git", ["-C", repository, "config", "user.name", "Mission Recovery Dogfood"]);
  await write(
    join(repository, "package.json"),
    `${JSON.stringify({ name: "mission-recovery-dogfood", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  );
  await write(join(repository, "src", "counter.js"), "export const next = (value) => value + 1;\n");
  await write(
    join(repository, "test", "counter.test.js"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { next } from "../src/counter.js";\ntest("increments", () => assert.equal(next(1), 2));\n',
  );
  await exec("git", ["-C", repository, "add", "-A"]);
  await exec("git", ["-C", repository, "commit", "-q", "-m", "dogfood baseline"]);

  const prompt = [
    "Work only in this temporary repository.",
    "Add a decrement helper beside next(), add a focused test, run the tests, and finish the durable engineering mission.",
    "Do not access or modify any parent or unrelated project.",
  ].join(" ");
  const extensionArgs = sourceOnly ? ["--no-extensions", "--extension", extension] : [];
  try {
    await exec(
      pi,
      [
        "--model",
        REQUIRED_MODEL,
        "--print",
        "--no-session",
        "--no-context-files",
        "--no-skills",
        ...extensionArgs,
        "--approve",
        "--",
        prompt,
      ],
      {
        cwd: repository,
        timeout: 15 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PI_MISSION_DOGFOOD_MODEL: REQUIRED_MODEL },
      },
    );
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number | string;
      signal?: NodeJS.Signals;
      killed?: boolean;
    };
    process.stderr.write(failure.stdout ?? "");
    process.stderr.write(failure.stderr ?? "");
    throw new Error(
      `local/local Pi mission failed in preserved temporary repository ${repository} (code=${failure.code ?? "unknown"}, signal=${failure.signal ?? "none"}, killed=${failure.killed ?? false}): ${failure.message ?? "unknown error"}`,
    );
  }

  const snapshotPath = join(repository, ".pi-eng", "orchestration-snapshot.json");
  const snapshot = validateSnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
  const mission = snapshot.missions.at(-1);
  if (!mission?.id) throw new Error(`Pi produced no durable mission in ${snapshotPath}`);
  assertActionableOutcome(mission, repository);

  process.stdout.write(
    `${JSON.stringify(
      {
        dogfood: "mission-recovery",
        verificationMode: sourceOnly ? "source-only (--no-extensions + explicit extension)" : "installed-package",
        cli: pi,
        installedPackage: installed,
        installedSha: sourceOnly ? null : expectedSha,
        model: REQUIRED_MODEL,
        metabolomics: "absent/disabled",
        temporaryRepository: repository,
        realProjectMutated: false,
        durableEvidence: {
          missionId: mission.id,
          status: mission.status,
          revision: mission.revision,
          contractVersion: snapshot.contractVersion,
          snapshotPath,
          acceptanceCoverage: mission.observability?.acceptanceCoverage ?? null,
          preservedWork: mission.observability?.preservedWork ?? [],
          stop: mission.stop ?? null,
        },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
