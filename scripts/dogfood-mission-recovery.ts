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
  const listing = await exec(pi, ["list"], { maxBuffer: 4 * 1024 * 1024 });
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

async function main(): Promise<void> {
  const model = configuredModel();
  assertLocalOnly(model);
  const pi = argument("--pi") ?? process.env.PI_CLI_BIN?.trim() ?? "pi";
  const catalog = await exec(pi, ["--list-models"], { maxBuffer: 4 * 1024 * 1024 });
  const catalogLines = catalog.stdout.split(/\r?\n/).map((line) => line.trim());
  if (!catalogLines.some((line) => /^local\s+local(?:\s|$)/.test(line)))
    throw new Error("installed Pi CLI does not advertise the required local/local model");
  if (catalogLines.some((line) => /^metabolomics\s+/i.test(line)))
    throw new Error("installed Pi CLI still advertises metabolomics; disable/remove it before dogfood");

  const sourceOnly = process.argv.includes("--source-only");
  const sourceRoot = await realpath(resolve(import.meta.dirname, ".."));
  const extension = join(sourceRoot, "extensions", "index.ts");
  const expectedSha = argument("--expected-sha") ?? (await gitValue(sourceRoot, ["rev-parse", "HEAD"]));
  if (!expectedSha) throw new Error("cannot determine expected pi-engineering package SHA");
  const installed = sourceOnly ? null : await installedPackage(pi, expectedSha);
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
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as MissionSnapshotFile;
  if (snapshot.contractVersion !== MISSION_SNAPSHOT_CONTRACT_VERSION)
    throw new Error(
      `unsupported mission snapshot contract ${snapshot.contractVersion}; expected ${MISSION_SNAPSHOT_CONTRACT_VERSION}`,
    );
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
