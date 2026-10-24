/**
 * `pi-engineering plan --store <dir> --from-autospec <file|dir>` (T04).
 *
 * The production caller of DAG ingestion. Reached only through a dynamic import
 * from the standalone plan entry when `--from-autospec` is given, and refused
 * unless `autospec.dag.enabled: true` is set in Pi's own engineering.yaml.
 *
 * Input is a file `{mission, tasks}` or a directory holding `mission.json` and
 * `tasks.json` (an array of autospec.protocol.task.v1 records). It stops before
 * any worker is spawned, exactly like the standalone plan: the output says
 * whether implementation may start, under the configured plan-review policy.
 * Exit codes: 0 may proceed, 1 blocked, 2 invalid request or not enabled,
 * 3 store error.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MissionStore } from "../../orchestration/missionStore.ts";
import { loadPlanReviewSettings } from "../../orchestration/planReviewConfig.ts";
import type { StandalonePlanDeps, StandalonePlanIo } from "../../orchestration/standaloneEntry.ts";
import { JsonlEventStore } from "../../platform/eventstore/jsonl.ts";
import { ingestAutoSpecDag } from "./dagIngest.ts";
import { bindAutoSpecPlan } from "./planBinding.ts";
import { loadAutoSpecConfig } from "./provider.ts";

const MAX_BYTES = 4 * 1_048_576;

function readJsonFile(path: string): unknown {
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (st.size > MAX_BYTES) throw new Error(`${path} is larger than ${MAX_BYTES} bytes`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadAutoSpecInput(path: string): { mission: unknown; tasks: unknown[] } {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`${abs} does not exist`);
  if (lstatSync(abs).isDirectory()) {
    const tasks = readJsonFile(join(abs, "tasks.json"));
    if (!Array.isArray(tasks)) throw new Error("tasks.json must be an array of task records");
    return { mission: readJsonFile(join(abs, "mission.json")), tasks };
  }
  const doc = readJsonFile(abs) as { mission?: unknown; tasks?: unknown };
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.tasks) || doc.mission === undefined) {
    throw new Error("the file must be a JSON object {mission, tasks: [...]}");
  }
  return { mission: doc.mission, tasks: doc.tasks };
}

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  const v = i < 0 ? undefined : args[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
};

export async function runAutoSpecPlan(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: StandalonePlanIo = {},
  deps: StandalonePlanDeps = {},
): Promise<number> {
  const out = io.write ?? ((t: string) => process.stdout.write(t));
  const err = io.error ?? ((t: string) => process.stderr.write(t));
  const usage = "usage: pi-engineering plan --store <dir> --from-autospec <file|dir>\n";
  const storeDir = flag(argv, "--store");
  const from = flag(argv, "--from-autospec");
  if (!storeDir || !from) {
    err(`--store and --from-autospec need values\n${usage}`);
    return 2;
  }
  const cwd = deps.cwd ?? process.cwd();
  const config = await loadAutoSpecConfig(cwd, { env });
  if (config.kind === "invalid") {
    err(`autospec configuration is invalid: ${config.notes.join("; ")}\n`);
    return 2;
  }
  if (config.kind !== "on" || !config.config.dag.enabled) {
    err("AutoSpec DAG ingestion is off: set autospec.dag.enabled: true in ~/.pi/agent/engineering.yaml\n");
    return 2;
  }
  let input: { mission: unknown; tasks: unknown[] };
  try {
    input = loadAutoSpecInput(from);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
    return 2;
  }
  const ingest = ingestAutoSpecDag(input);
  if (!ingest.ok) {
    out(`${JSON.stringify({ result: "rejected", code: ingest.code, reason: ingest.message })}\n`);
    return 2;
  }

  const dir = resolve(storeDir);
  let backend: JsonlEventStore;
  try {
    await mkdir(dir, { recursive: true });
    backend = await JsonlEventStore.open(join(dir, "orchestration.jsonl"));
  } catch (error) {
    err(`cannot open the store in ${dir}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
  try {
    const store = MissionStore.open(backend);
    if (!store.getMission(ingest.missionId)) {
      store.createMission({
        mission_id: ingest.missionId,
        title: ingest.goal.slice(0, 80),
        goal: ingest.goal,
        user_request: ingest.goal,
        repository: ".",
        base_ref: "HEAD",
        constraints: [],
        risk_profile: "medium",
        workflow_class: "engineering",
      });
    }
    const settings =
      deps.adapter === undefined && deps.policy === undefined ? await loadPlanReviewSettings(cwd, { env }) : null;
    const outcome = await bindAutoSpecPlan(ingest, {
      ledger: store,
      dagEnabled: true,
      planReviewConfigured: settings !== null || deps.policy !== undefined || deps.adapter !== undefined,
      ...((deps.adapter ?? settings?.adapter) ? { adapter: deps.adapter ?? settings?.adapter ?? null } : {}),
      ...((deps.policy ?? settings?.policy) ? { policy: deps.policy ?? settings?.policy } : {}),
      ...(settings?.maxRevisions ? { maxRevisions: settings.maxRevisions } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    await store.flush();
    if (outcome.status === "rejected") {
      out(`${JSON.stringify({ result: "rejected", code: outcome.code, reason: outcome.message })}\n`);
      return 2;
    }
    const issueRefs = Object.fromEntries(ingest.issueRefs);
    const base = {
      missionId: ingest.missionId,
      source: "autospec",
      tasks: ingest.tasks.map((t) => ({ taskId: t.task_id, dependsOn: t.depends_on, writeDomains: t.write_domains })),
      issueRefs,
      ignoredExtensions: ingest.ignoredExtensions,
    };
    if (outcome.status === "unreviewed") {
      out(
        `${JSON.stringify({ result: "may_proceed", reviewed: false, planDigest: outcome.planDigest, reason: outcome.reason, ...base })}\n`,
      );
      return 0;
    }
    const g = outcome.gate;
    out(
      `${JSON.stringify({
        result: g.status === "proceed" ? "may_proceed" : "blocked",
        reviewed: true,
        revision: g.revision,
        planDigest: g.planDigest,
        riskClass: g.riskClass,
        mode: g.mode,
        ...(g.status === "blocked" ? { code: g.code } : { outcome: g.outcome }),
        reason: g.reason,
        ...base,
      })}\n`,
    );
    return g.status === "proceed" ? 0 : 1;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  } finally {
    backend.close();
  }
}
