#!/usr/bin/env node
/**
 * Nightly real-mission dogfood (issue #226).
 *
 * Runs two REAL missions through EngineeringRuntime against the real gateway,
 * each on a fresh green fixture repo, and writes a `dogfood_mission` record:
 *
 *   node scripts/dogfood-real-mission.ts --out dogfood/<sha>.json [--timeout-ms 1800000]
 *
 * Environment (all required; exit 2 when any is missing):
 *   PI_DOGFOOD_GATEWAY_BASE_URL   OpenAI-compatible gateway base URL (…/v1)
 *   PI_DOGFOOD_GATEWAY_API_KEY    gateway token
 *   PI_DOGFOOD_MODEL              model id, optionally `provider/` prefixed
 *
 * Exit 0 only when both missions reach COMPLETE within the timeout each; exit 1
 * otherwise, printing `missions why` for the failed mission. State is isolated
 * (PI_ENGINEERING_STATE_DIR / PI_ENGINEERING_HOME point at temp dirs).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const PROVIDER = "dogfood";

const GOALS = [
  "Add a Usage section to README.md describing the add and subtract functions.",
  "Add a multiply(a, b) function to src/calc.js, export it, and add a test for it in test/calc.test.js.",
] as const;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

const baseUrl = process.env.PI_DOGFOOD_GATEWAY_BASE_URL?.trim();
const apiKey = process.env.PI_DOGFOOD_GATEWAY_API_KEY?.trim();
const modelEnv = process.env.PI_DOGFOOD_MODEL?.trim();
const out = argument("--out");
const missing = [
  ["PI_DOGFOOD_GATEWAY_BASE_URL", baseUrl],
  ["PI_DOGFOOD_GATEWAY_API_KEY", apiKey],
  ["PI_DOGFOOD_MODEL", modelEnv],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length > 0 || !baseUrl || !apiKey || !modelEnv) {
  fail(
    `dogfood-real-mission needs the real gateway; set ${missing.join(", ")} (see docs/usage.md "Nightly dogfood")`,
    2,
  );
}
if (!out) fail("usage: node scripts/dogfood-real-mission.ts --out <file> [--timeout-ms N]", 2);
const timeoutMs = Number(argument("--timeout-ms") ?? DEFAULT_TIMEOUT_MS);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms must be a positive number", 2);
const modelId = modelEnv.includes("/") ? modelEnv.slice(modelEnv.indexOf("/") + 1) : modelEnv;

// Isolate state BEFORE the runtime modules read the environment.
const stateRoot = await mkdtemp(join(tmpdir(), "pi-dogfood-state-"));
process.env.PI_ENGINEERING_STATE_DIR = join(stateRoot, "state");
process.env.PI_ENGINEERING_HOME = join(stateRoot, "home");

const { EngineeringRuntime } = await import("../src/runtime/EngineeringRuntime.ts");
const { buildDogfoodRecord, allComplete, summariseMission } = await import("../src/orchestration/dogfoodRecord.ts");
const { explainMission, formatMissionWhy } = await import("../src/orchestration/missionWhy.ts");

async function write(path: string, contents: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { encoding: "utf8", mode });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

/** Green baseline: add/subtract with a passing node:test suite. */
async function makeFixture(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "pi-dogfood-fixture-"));
  await exec("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.email", "dogfood@example.com");
  await git(repo, "config", "user.name", "Dogfood");
  await write(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "calc-fixture", version: "0.0.1", private: true, scripts: { test: "node --test test/*.test.js" } }, null, 2)}\n`,
  );
  await write(
    join(repo, "src", "calc.js"),
    "function add(a, b) {\n  return a + b;\n}\n\nfunction subtract(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add, subtract };\n",
  );
  await write(
    join(repo, "test", "calc.test.js"),
    `const test = require("node:test");\nconst assert = require("node:assert");\nconst { add, subtract } = require("../src/calc.js");\n\ntest("add", () => assert.equal(add(2, 3), 5));\ntest("subtract", () => assert.equal(subtract(5, 3), 2));\n`,
  );
  await write(join(repo, "README.md"), "# calc-fixture\n\nTiny calculator used for dogfooding.\n");
  await write(join(repo, ".gitignore"), ".pi-eng/\nnode_modules/\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "green baseline");
  return repo;
}

async function writeAgentDir(): Promise<string> {
  const agentDir = join(stateRoot, "agent");
  await write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [PROVIDER]: {
          baseUrl,
          api: "openai-completions",
          apiKey,
          models: [{ id: modelId, contextWindow: 262_144, maxTokens: 32_768 }],
        },
      },
    }),
    0o600,
  );
  await write(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: PROVIDER, defaultModel: modelId, enabledModels: [`${PROVIDER}/*`] }),
    0o600,
  );
  return agentDir;
}

const agentDir = await writeAgentDir();
// The key now lives only in the 0600 agent dir; spawned workers inherit
// process.env, so drop it from there.
delete process.env.PI_DOGFOOD_GATEWAY_API_KEY;

const mainSha = await git(REPO_ROOT, "rev-parse", "HEAD");
const summaries: Awaited<ReturnType<typeof summariseMission>>[] = [];
let failedWhy: string | null = null;
type Runtime = Awaited<ReturnType<typeof EngineeringRuntime.open>>;
let liveRuntime: Runtime | null = null;
let liveRepo: string | null = null;

async function closeRuntime(): Promise<void> {
  const rt = liveRuntime;
  liveRuntime = null;
  if (rt) await rt.close().catch((error) => console.error(`runtime close failed: ${String(error)}`));
}

async function cleanup(): Promise<void> {
  await closeRuntime();
  if (liveRepo) await rm(liveRepo, { recursive: true, force: true });
  liveRepo = null;
  await rm(stateRoot, { recursive: true, force: true });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.error(`received ${signal}; cleaning up`);
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

async function writeRecord(): Promise<ReturnType<typeof buildDogfoodRecord>> {
  const record = buildDogfoodRecord(mainSha, summaries, new Date());
  await write(resolve(out as string), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

let exitCode = 1;
try {
  for (const goal of GOALS) {
    const repo = await makeFixture();
    liveRepo = repo;
    const baseSha = await git(repo, "rev-parse", "HEAD");
    const started = Date.now();
    const rt = await EngineeringRuntime.open({ cwd: repo, agentDir });
    liveRuntime = rt;
    if (!rt.orchestrator || !rt.missionStore) throw new Error("runtime opened without an orchestrator");
    const result = await rt.orchestrator.orchestrate(goal, {
      repository: repo,
      baseRef: baseSha,
      mutationRequested: true,
      signal: AbortSignal.timeout(timeoutMs),
      interrupt: "pause",
    });
    const missionId = result.mission.mission_id;
    const headNow = await git(repo, "rev-parse", "HEAD");
    const summary = summariseMission(rt.missionStore, missionId, {
      goal,
      wallMs: Date.now() - started,
      fallbackCandidateSha: headNow !== baseSha ? headNow : null,
      fallbackModel: modelEnv,
    });
    summaries.push(summary);
    console.log(
      `${summary.status} ${missionId} calls=${summary.calls} in=${summary.inputTokens} out=${summary.outputTokens} ${summary.wallMs}ms: ${goal}`,
    );
    if (summary.status !== "COMPLETE") failedWhy = formatMissionWhy(explainMission(rt.missionStore, missionId));
    await closeRuntime();
    await rm(repo, { recursive: true, force: true });
    liveRepo = null;
    if (failedWhy) break;
  }
} catch (error) {
  failedWhy = `dogfood run aborted: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
} finally {
  // The record is written on every path, failures included.
  const record = await writeRecord().catch((error) => {
    console.error(`could not write ${out}: ${String(error)}`);
    return null;
  });
  if (record && allComplete(record) && summaries.length === GOALS.length) exitCode = 0;
  await cleanup();
}

if (exitCode !== 0) console.error(failedWhy ?? "dogfood mission did not complete");
process.exit(exitCode);
