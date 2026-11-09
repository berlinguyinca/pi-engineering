/**
 * V04 harness-role benchmark: the (task x harness-role) replay matrix for the quantization protocol. A dry run
 * is the DEFAULT — no endpoint, network, fs write or model call. Live replay needs BOTH opt-ins (env
 * BENCH_HARNESS_ROLES=1 AND `enabled: true`) and runs SERIALLY through the caller-injected `replay` callback
 * (this module imports no provider or client: a live call from here is impossible by construction), recording
 * the requestId it returns; a callback that throws marks its entry failed and the serial loop continues. Only
 * Flash/Lite-class ids are eligible and availability is an offline StaticModelSource fact, never a network
 * source. No clock, randomness or env-derived input: same inputs in, byte-identical JSON line out, exit 0.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { type StaticModelDefinition, StaticModelSource } from "../src/capability/discovery.ts";
import type { QuantRunRecord } from "../src/capability/quantBenchmark.ts";
import { loadTasks } from "./bench-task-drift.ts";
export type HarnessRole = "minimal" | "full";
export type EntryStatus = "planned" | "skipped" | "replayed" | "failed";
export type Replay = (entry: ReplayEntry) => { requestId: string } | Promise<{ requestId: string }>;
/** One matrix cell: taskId, role, status plus every QuantRunRecord field provable offline. weightsHash, baseSha, outcome and latencyMs stay unset — they are measured or checkout-specific, never invented here — and `unknown` is V03's declared gap value for the statically contracted conditions. */
export interface ReplayEntry extends Partial<Omit<QuantRunRecord, "harness" | "modelId">> {
  taskId: string;
  role: HarnessRole;
  harness: HarnessRole;
  status: EntryStatus;
  modelId: string;
  reason?: string;
  requestId?: string;
}
export interface ReplanOptions {
  available: readonly string[];
  requested?: readonly string[];
  roles?: readonly HarnessRole[];
  tasks?: readonly { id: string }[];
  dryRun?: boolean;
  enabled?: boolean;
  replay?: Replay;
  env?: NodeJS.ProcessEnv;
}
/** Tasks are the frozen V01 traces and promptSha256 is that frozen task contract, serialized and hashed — never a placeholder. Each task is pinned to one requested model, so its two harness roles stay in one model family: the only pair compareRuns can compare. */
export function buildPlan(
  models: readonly string[],
  roles: readonly HarnessRole[],
  tasks: readonly { id: string }[] = loadTasks(),
): ReplayEntry[] {
  const contract = {
    quantMethod: "unknown",
    kvCache: "unknown",
    contextTokens: 0,
    sampling: { seed: 0, temperature: 0 },
  } as const;
  return tasks.flatMap((task, i) =>
    roles.map(
      (role): ReplayEntry => ({
        taskId: task.id,
        role,
        harness: role,
        status: "planned",
        modelId: models[i % Math.max(models.length, 1)] ?? "",
        promptSha256: `sha256:${createHash("sha256").update(JSON.stringify(task)).digest("hex")}`,
        ...contract,
      }),
    ),
  );
}
/** Class gate first, then availability, both decided offline; every skip reason names what was asked for. */
export function resolveModel(
  requested: string,
  available: readonly string[],
): { ok: true; modelId: string } | { ok: false; reason: string } {
  if (!/(?:flash|lite)/i.test(requested)) return { ok: false, reason: "not a Flash/Lite class model" };
  const id = available.find((m) => m === requested || m.endsWith(`/${requested}`));
  return id === undefined
    ? { ok: false, reason: `${requested} is not among the available model ids [${available.join(", ")}]` }
    : { ok: true, modelId: id };
}
/** The matrix, resolved. Without BOTH opt-ins this only resolves the plan and returns 'planned'/'skipped'. Entries are walked in plan order and awaited one at a time: serial by construction, never Promise.all. */
export async function runReplan(opts: ReplanOptions): Promise<{ dryRun: boolean; entries: ReplayEntry[] }> {
  const {
    available,
    requested = [],
    roles = ["minimal", "full"],
    dryRun = true,
    enabled = false,
    replay,
    env = process.env,
  } = opts;
  const live = !dryRun && enabled === true && env.BENCH_HARNESS_ROLES === "1";
  const entries = buildPlan(requested, roles, opts.tasks);
  for (const entry of entries) {
    const resolved = resolveModel(entry.modelId, available);
    if (!resolved.ok) {
      entry.status = "skipped";
      entry.reason = resolved.reason;
      continue;
    }
    entry.modelId = resolved.modelId;
    if (!live) continue;
    if (replay === undefined) {
      entry.status = "skipped";
      entry.reason = `${entry.modelId} is eligible, but no replay callback is injected: this script never calls a model itself`;
      continue;
    }
    try {
      entry.status = "replayed";
      entry.requestId = (await replay(entry)).requestId;
    } catch (error) {
      entry.status = "failed";
      entry.reason = (error as Error).message;
    }
  }
  return { dryRun: !live, entries };
}
/** Offline inventory (operator-declared aliases) and the requested lineup; the spec's Qwen/27B review preference is listed on purpose, so the class gate is seen rejecting it. */
const MODELS: StaticModelDefinition[] = [
  { provider: "google", id: "gemini-3-flash" },
  { provider: "google", id: "gemini-3.1-flash-lite" },
  { provider: "openai", id: "gpt-5-mini" },
  { provider: "operator", id: "qwen3.6-27b" },
];
const ROSTER = ["gemini-3-flash", "gpt-5-mini", "qwen3.6-27b", "gemini-3.1-flash-lite", "openrouter/gemini-3-flash"];
/** Exactly one machine-readable JSON line on stdout; exit 0 for a dry run even when every entry is skipped. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const available = (await new StaticModelSource(MODELS).discover()).map((m) => `${m.provider}/${m.id}`);
  const { dryRun, entries } = await runReplan({
    available,
    requested: ROSTER,
    dryRun: !argv.includes("--live"),
    enabled: argv.includes("--enable"),
    env: process.env,
  });
  const count = (status: EntryStatus) => entries.filter((e) => e.status === status).length;
  console.log(
    JSON.stringify({
      dryRun,
      planned: count("planned"),
      skipped: count("skipped"),
      replayed: count("replayed"),
      skippedEntries: entries
        .filter((e) => e.status === "skipped")
        .map((e) => ({ taskId: e.taskId, role: e.role, reason: e.reason })),
    }),
  );
  return 0;
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
