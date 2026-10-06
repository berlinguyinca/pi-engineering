/**
 * Run the planner/worker benchmark modes (A–D) against a gateway.
 *
 *   node scripts/planner-worker-benchmark.ts --base-url http://localhost:8081/v1 \
 *     [--api-key-env INFERWEAVE_API_KEY] [--modes A,B,C,D] [--repeat 1] \
 *     [--default-model <id>] [--out docs/evidence/planner-worker]
 *
 * Roles resolve through the gateway's aliases/capabilities (see
 * docs/specs/planner-worker-inferweave-contract.md); --default-model is only
 * used when the gateway advertises neither.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BENCHMARK_MODES,
  type BenchmarkMode,
  DEFAULT_BENCHMARK_TASKS,
  renderBenchmarkTable,
  runPlannerWorkerBenchmark,
} from "../src/benchmark/PlannerWorkerBenchmark.ts";
import { fetchCatalog } from "../src/plannerWorker/gateway.ts";
import { GatewayChatWorkerExecutor } from "../src/plannerWorker/gatewayWorker.ts";
import { RoleResolver } from "../src/plannerWorker/resolver.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const baseUrl = arg("base-url") ?? process.env.INFERWEAVE_BASE_URL;
  if (!baseUrl) {
    console.error("usage: planner-worker-benchmark --base-url <gateway /v1 url> [--modes A,B,C,D]");
    return 2;
  }
  const apiKeyEnv = arg("api-key-env");
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  const conn = { baseUrl, ...(apiKey ? { apiKey } : {}) };
  const catalog = await fetchCatalog(conn);
  const defaultModel = arg("default-model") ?? catalog[0]?.id;
  if (!defaultModel) {
    console.error(`no models reachable at ${baseUrl}`);
    return 1;
  }
  const modes = (arg("modes") ?? BENCHMARK_MODES.join(","))
    .split(",")
    .map((m) => m.trim().toUpperCase())
    .filter((m): m is BenchmarkMode => (BENCHMARK_MODES as readonly string[]).includes(m));
  const repeat = Math.max(1, Number(arg("repeat") ?? 1));
  const tasks = Array.from({ length: repeat }, (_, i) =>
    DEFAULT_BENCHMARK_TASKS.map((t) => ({ ...t, id: repeat > 1 ? `${t.id}-${i + 1}` : t.id })),
  ).flat();
  const result = await runPlannerWorkerBenchmark({
    worker: new GatewayChatWorkerExecutor({ ...conn, defaultModel }),
    resolver: () => new RoleResolver({ provider: "gateway", catalog }),
    tasks,
    modes,
  });
  const out = resolve(arg("out") ?? "docs/evidence/planner-worker");
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, "runs.jsonl"), `${result.runs.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const table = renderBenchmarkTable(result.summaries);
  await writeFile(resolve(out, "summary.txt"), `${table}\n`);
  console.log(table);
  console.log(`raw runs: ${resolve(out, "runs.jsonl")}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
