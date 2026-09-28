#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { MissionSnapshotFile } from "../src/orchestration/missionSnapshot.ts";

const exec = promisify(execFile);
const REQUIRED_MODEL = "local/local";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function configuredModel(): string {
  return argument("--model") ?? process.env.PI_MISSION_DOGFOOD_MODEL ?? REQUIRED_MODEL;
}

function assertLocalOnly(model: string): void {
  if (model !== REQUIRED_MODEL) {
    throw new Error(`mission-recovery dogfood requires exactly ${REQUIRED_MODEL}; refused ${model}`);
  }
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
      `mission-recovery dogfood requires metabolomics absent/disabled; found ${enabledMetabolomics
        .map(([name]) => name)
        .join(", ")}`,
    );
  }
}

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function main(): Promise<void> {
  const model = configuredModel();
  assertLocalOnly(model);

  const pi = process.env.PI_CLI_BIN?.trim() || "pi";
  const catalog = await exec(pi, ["--list-models"], { maxBuffer: 4 * 1024 * 1024 });
  const catalogLines = catalog.stdout.split(/\r?\n/).map((line) => line.trim());
  if (!catalogLines.some((line) => /^local\s+local\s/.test(line))) {
    throw new Error("installed Pi CLI does not advertise the required local/local model");
  }
  if (catalogLines.some((line) => /^metabolomics\s+/i.test(line))) {
    throw new Error("installed Pi CLI still advertises metabolomics; disable/remove it before dogfood");
  }

  // Guards above intentionally run before this point. A refused configuration
  // cannot create a repository or start a Pi session.
  const parent = process.env.PI_MISSION_DOGFOOD_TEMP_PARENT ?? tmpdir();
  const repository = await mkdtemp(join(parent, "pi-mission-recovery-dogfood-"));
  await exec("git", ["init", "-q", repository]);
  await exec("git", ["-C", repository, "config", "user.email", "mission-dogfood@example.invalid"]);
  await exec("git", ["-C", repository, "config", "user.name", "Mission Recovery Dogfood"]);
  await write(
    join(repository, "package.json"),
    `${JSON.stringify(
      {
        name: "mission-recovery-dogfood",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
  );
  await write(join(repository, "src", "counter.js"), "export const next = (value) => value + 1;\n");
  await write(
    join(repository, "test", "counter.test.js"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { next } from "../src/counter.js";\ntest("increments", () => assert.equal(next(1), 2));\n',
  );
  await exec("git", ["-C", repository, "add", "-A"]);
  await exec("git", ["-C", repository, "commit", "-q", "-m", "dogfood baseline"]);

  const extension = resolve(import.meta.dirname, "..", "extensions", "index.ts");
  const prompt = [
    "Work only in this temporary repository.",
    "Add a decrement helper beside next(), add a focused test, run the tests, and finish the durable engineering mission.",
    "Do not access or modify any parent or unrelated project.",
  ].join(" ");
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
        "--extension",
        extension,
        "--approve",
        "--",
        prompt,
      ],
      {
        cwd: repository,
        timeout: 15 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          PI_MISSION_DOGFOOD_MODEL: REQUIRED_MODEL,
        },
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
      `local/local Pi mission failed in preserved temporary repository ${repository} ` +
        `(code=${failure.code ?? "unknown"}, signal=${failure.signal ?? "none"}, killed=${failure.killed ?? false}): ` +
        `${failure.message ?? "unknown error"}`,
    );
  }

  const snapshotPath = join(repository, ".pi-eng", "orchestration-snapshot.json");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as MissionSnapshotFile;
  const mission = snapshot.missions.at(-1);
  if (!mission) throw new Error(`Pi produced no durable mission in ${snapshotPath}`);
  const terminal = ["COMPLETE", "FAILED", "CANCELED"].includes(mission.status);
  if (!terminal && !mission.stop) {
    throw new Error(`mission ${mission.missionId} has neither a terminal state nor a typed actionable stop`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        dogfood: "mission-recovery",
        cli: pi,
        model: REQUIRED_MODEL,
        metabolomics: "absent/disabled",
        temporaryRepository: repository,
        realProjectMutated: false,
        durableEvidence: {
          missionId: mission.missionId,
          status: mission.status,
          revision: mission.revision,
          snapshotPath,
          acceptanceCoverage: mission.acceptanceCoverage,
          preservedWork: mission.preservedWork,
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
