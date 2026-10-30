/**
 * Child process for fake-model-handoff-e2e.test.ts: a REAL EngineeringRuntime and real worker processes against a local fake
 * OpenAI-compatible model (test/support/fakeModelServer.ts). The first worker session commits work, then reports a context
 * reading past the emergency level; the successor must continue on the same model from the verified checkpoint.
 * usage: node --experimental-strip-types fakeModelHandoffRun.ts <outJson> <normal|ghost> [capMs]
 * `ghost` makes the observer report a model that is not in the registry, so it cannot be pinned.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFake } from "./fakeModelServer.ts";
const exec = promisify(execFile);
const release = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [outArg, mode = "normal", capArg] = process.argv.slice(2);
const outPath = outArg ?? "";
if (!outPath) throw new Error("usage: fakeModelHandoffRun.ts <outJson> <normal|ghost> [capMs]");
const capMs = Number(capArg ?? 480_000);
const WINDOW = 131072;
const EMERGENCY = 0.7;
const fake = await startFake({ window: WINDOW, crossFraction: EMERGENCY });
const root = mkdtempSync(join(tmpdir(), "pi-fake-"));
process.env.PI_ENGINEERING_STATE_DIR = join(root, "state");
process.env.PI_ENGINEERING_HOME = join(root, "home");
process.env.HOME = join(root, "home");
mkdirSync(process.env.HOME, { recursive: true });
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        fakeprov: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${fake.port}/v1`,
          apiKey: "dummy-not-a-secret",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
          models: [
            {
              id: "smoke-model",
              name: "smoke-model",
              reasoning: false,
              input: ["text"],
              contextWindow: WINDOW,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ defaultProvider: "fakeprov", defaultModel: "smoke-model", enabledModels: ["fakeprov/smoke-model"] }),
);
const roles = ["planner", "implementer", "reviewer", "test_reviewer", "verifier", "orchestrator", "spec_verifier"];
writeFileSync(
  join(agentDir, "engineering.yaml"),
  `routing:\n  mode: auto\n  roles:\n${roles.map((r) => `    ${r}:\n      model: fakeprov/smoke-model\n      max_context_tokens: 100000\n`).join("")}context_thresholds:\n  soft: 0.5\n  preferred: 0.6\n  emergency: ${EMERGENCY}\n`,
);
const git = async (cwd: string, ...a: string[]) => (await exec("git", ["-C", cwd, ...a])).stdout.trim();
const repo = mkdtempSync(join(tmpdir(), "pi-fake-fixture-"));
await exec("git", ["init", "-q", "-b", "main", repo]);
await git(repo, "config", "user.email", "smoke@example.com");
await git(repo, "config", "user.name", "Smoke");
const w = (p: string, c: string) => {
  mkdirSync(dirname(join(repo, p)), { recursive: true });
  writeFileSync(join(repo, p), c);
};
w(
  "package.json",
  `${JSON.stringify(
    { name: "calc-fixture", version: "0.0.1", private: true, scripts: { test: "node --test test/*.test.js" } },
    null,
    2,
  )}\n`,
);
w(
  "src/calc.js",
  "function add(a, b) {\n  return a + b;\n}\n\nfunction subtract(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add, subtract };\n",
);
w("README.md", "# calc-fixture\n");
w(".gitignore", ".pi-eng/\nnode_modules/\n");
await git(repo, "add", "-A");
await git(repo, "commit", "-q", "-m", "baseline");
const base = await git(repo, "rev-parse", "HEAD");
const { EngineeringRuntime } = await import(join(release, "src/runtime/EngineeringRuntime.ts"));
const planner = async (mission: any) => [
  {
    kind: "agent",
    role: "implementer",
    objective: mission.goal,
    mutates_repo: true,
    write_domains: ["src/**"],
    isolation: "worktree",
    depends_on: [],
    priority: 0,
    execution_requirements: {},
    acceptance_ids: mission.acceptance_criteria.flatMap((c: any) => (c.acceptance_id ? [c.acceptance_id] : [])),
    deliverables: ["implementation"],
    max_attempts: 3,
    failure_policy: "retry",
  },
];
const rt = await EngineeringRuntime.open({ cwd: repo, agentDir, orchestrationPlanner: planner });
const orch = rt.orchestrator as any;
const reports: string[] = [];
const ctxLog: any[] = [];
const progress = orch.progress as Map<string, (l: string) => void>;
const og = progress.get.bind(progress);
progress.get = (k: string) => og(k) ?? ((l: string) => void reports.push(l));
const orig = orch.observeContinuitySignals.bind(orch);
orch.observeContinuitySignals = (event: any) => {
  let ev = event;
  if (ev.context) {
    ctxLog.push({
      exec: ev.executionId.slice(-6),
      tokens: ev.context.tokens,
      window: ev.context.window,
      model: ev.context.model,
      frac: +(ev.context.tokens / ev.context.window).toFixed(3),
    });
    if (mode === "ghost") ev = { ...ev, context: { ...ev.context, model: "fakeprov/ghost" } };
  }
  return orig(ev);
};
const ac = new AbortController();
const cap = setTimeout(() => ac.abort(), capMs);
const goal = "Add a multiply(a, b) function to src/calc.js and export it.";
const started = Date.now();
let err = "";
let missionId = "";
let doneWhy = "";
const run = orch
  .orchestrate(goal, {
    repository: repo,
    baseRef: base,
    mutationRequested: true,
    signal: ac.signal,
    interrupt: "pause",
  })
  .then((r: any) => {
    missionId = r.mission.mission_id;
    doneWhy = "orchestrate returned";
  })
  .catch((e: any) => {
    err = String(e?.stack ?? e);
  });
// watcher: stop once a handoff exists and >=2 agent executions are terminal (or the 'ghost' run has a finished successor)
const watch = setInterval(() => {
  try {
    const ms = rt.missionStore.listMissions?.() ?? [];
    for (const m of ms) {
      const hs = rt.missionStore.listHandoffRecords(m.mission_id);
      const ex = rt.missionStore.listExecutions(m.mission_id).filter((e: any) => e.backend === "agent");
      const term = ex.filter((e: any) => ["SUCCEEDED", "FAILED", "CANCELED"].includes(e.status));
      if (hs.length && term.length >= 2 && hs.every((h: any) => h.state !== "pending" && h.state !== "created")) {
        doneWhy = "handoff settled + successor terminal";
        missionId = m.mission_id;
        ac.abort();
      }
    }
  } catch (e) {
    /* ignore */
  }
}, 1000);
await Promise.race([run, new Promise((r) => ac.signal.addEventListener("abort", () => setTimeout(r, 3000)))]);
clearInterval(watch);
clearTimeout(cap);
try {
  await orch.settleHandoffs();
} catch (e) {
  err += `\nsettle:${e}`;
}
const store = rt.missionStore;
if (!missionId) missionId = store.listMissions?.()[0]?.mission_id ?? "";
const out: any = {
  mode,
  doneWhy,
  wallMs: Date.now() - started,
  err: err.slice(0, 1500),
  missionId,
  repo,
  window: WINDOW,
  emergency: EMERGENCY,
  emergencyTokens: Math.floor(WINDOW * EMERGENCY),
};
if (missionId) {
  out.executions = store
    .listExecutions(missionId)
    .filter((e: any) => e.backend === "agent")
    .map((e: any) => ({
      id: e.execution_id.slice(-6),
      model: e.model,
      session: e.session_id,
      status: e.status,
      exit: e.exit_status,
    }));
  out.missionStatus = store.getMission(missionId)?.status;
  out.handoffs = store.listHandoffRecords(missionId);
  out.tasks = store.listTasks(missionId).map((t: any) => ({
    role: t.role,
    kind: t.kind,
    status: t.status,
    attempt: t.attempt,
    max: t.max_attempts,
    reqModel: t.execution_requirements?.model,
    repair_base: t.repair_base_candidate_sha,
  }));
}
out.reports = reports.filter((l) => /handoff|pinned|switch|context|checkpoint|fenced/i.test(l));
out.allReportsCount = reports.length;
out.ctxLog = ctxLog;
out.fakeRequests = fake.log;
try {
  out.finalRepoLog = (await exec("git", ["-C", repo, "branch", "-a"])).stdout;
} catch {}
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(
  JSON.stringify({
    doneWhy,
    err: err.slice(0, 300),
    execs: out.executions?.length,
    handoffs: out.handoffs?.length,
    fakeReqs: fake.log.length,
  }),
);
await rt.close().catch(() => {});
await fake.close();
process.exit(0);
