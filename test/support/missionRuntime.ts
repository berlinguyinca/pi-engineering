/**
 * A runtime generation built on the REAL EngineeringRuntime: real mission
 * store, orchestrator, supervisor, git worktrees and CommandVerifier. The
 * worker reaches "inference" over real HTTP to a local gateway server that
 * the test controls, per role, so capacity can be taken away and returned.
 *
 * Imported from a fresh snapshot directory per generation, like any
 * generation. It imports the engineering code base by absolute URL.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const url = (rel: string) => pathToFileURL(join(repoRoot, rel)).href;

export interface MissionBag {
  values: string[];
  resumes: Array<{ generation: number; id: string }>;
  workerCalls: Array<{ generation: number; role: string; ok: boolean }>;
  missionId?: string;
  missionStatus?: string;
  config: { repo: string; gateway: string; goal: string };
}

export function missionBag(key: string, config: MissionBag["config"]): MissionBag {
  const g = globalThis as Record<string, unknown>;
  g[key] ??= { values: [], workerCalls: [], resumes: [], config } satisfies MissionBag;
  return g[key] as MissionBag;
}

export function writeMissionRuntime(dir: string, key: string, value: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "mission-runtime", version: "0.0.1", type: "module", piEngineering: { runtimeApi: 1, entry: "runtime.ts" } })}\n`,
  );
  writeFileSync(
    join(dir, "runtime.ts"),
    `import { EngineeringRuntime } from ${JSON.stringify(url("src/runtime/EngineeringRuntime.ts"))};
import { CommandVerifier } from ${JSON.stringify(url("src/verify/Verifier.ts"))};
import { orchestrationFile, readMissionFacts } from ${JSON.stringify(url("src/runtime/host/missionHandover.ts"))};
import { writeFile, mkdir } from "node:fs/promises";

const KEY = ${JSON.stringify(key)};
const VALUE = ${JSON.stringify(value)};
export const runtimeApi = 1;

function acceptanceResults(task: string) {
  return [...task.matchAll(/Acceptance criterion ([^:]+):/g)].map((m) => ({
    acceptanceId: m[1], status: "passed", detail: "checked",
  }));
}

export async function createRuntime(ctx: any) {
  const b: any = (globalThis as any)[KEY];
  const cfg = b.config;
  let rt: any;
  const worker = {
    async run(req: any) {
      const role = req.role ?? "";
      const res = await fetch(cfg.gateway + "/infer?role=" + encodeURIComponent(role)).catch(() => null);
      const ok = !!res && res.status === 200;
      b.workerCalls.push({ generation: ctx.generation, role, ok });
      if (!ok) {
        return {
          result: { status: "failed", summary: "capacity_unavailable", claims: [], evidence_refs: [],
            new_hypotheses: [], proposed_tasks: [], details: {}, error: "transient:server_unavailable" },
          usage: null, toolCalls: 0,
        };
      }
      if (role === "implementer") {
        await mkdir((req.cwd ?? cfg.repo) + "/src", { recursive: true });
        await writeFile((req.cwd ?? cfg.repo) + "/src/handover.js", "export const handover = true;\\n", "utf8");
      }
      return {
        result: { status: "completed", summary: role + " done", claims: [], evidence_refs: [],
          new_hypotheses: [], proposed_tasks: [], details: {} },
        usage: null, toolCalls: 1,
        structured: req.resultTool === "review_result"
          ? { verdict: "approve", findings: [], missingTests: [], specGaps: [],
              acceptanceResults: acceptanceResults(req.task), summary: "approved" }
          : undefined,
      };
    },
  };
  const facts = () => readMissionFacts(orchestrationFile(cfg.repo));
  return {
    async start() {
      rt = await EngineeringRuntime.open({ cwd: cfg.repo, worker, verifier: new CommandVerifier() });
      ctx.pi.registerCommand("start-mission", {
        description: "start the test mission (args: investigate | implement)",
        handler: async (args: string) => {
          const implement = args.trim() !== "investigate";
          const r = await rt.orchestrator.orchestrate(implement ? cfg.goal : "Find out why login fails", {
            repository: rt.cwd, baseRef: await rt.git.headCommit(), mutationRequested: implement,
          });
          b.missionId = r.mission.mission_id;
          b.missionStatus = r.mission.status;
        },
      });
      // The generation's recovery watcher: a background worker owned by this
      // generation (disposed with it). Missions parked on inference capacity
      // are durable; whichever generation is active resumes them once the
      // gateway is healthy again (spec §41, §43).
      let resuming = false;
      ctx.resources.setInterval(() => {
        if (resuming || !ctx.isActive()) return;
        resuming = true;
        void (async () => {
          try {
            const f = await facts();
            if (f.inferenceWaits.length === 0) return;
            const health = await fetch(cfg.gateway + "/health").catch(() => null);
            if (!health || health.status !== 200 || !ctx.isActive()) return;
            for (const id of f.inferenceWaits) {
              b.resumes.push({ generation: ctx.generation, id });
              const op = ctx.operations.begin("inference", "resume " + id);
              try {
                const m = await rt.orchestrator.resume(id, { force: true });
                b.missionStatus = m.status;
              } finally {
                op.end();
              }
            }
          } catch (error) {
            b.values.push("watcher-error:" + String(error));
          } finally {
            resuming = false;
          }
        })();
      }, 25);
      b.values.push("start:" + VALUE + ":g" + ctx.generation);
    },
    async quiesce() {},
    async waitForSafePoint() { return { reached: true, waitedMs: 0 }; },
    async snapshot() {
      const f = await facts();
      return { generation: ctx.generation, activeMissionIds: f.active, pendingMissionIds: f.pending,
        inferenceWaitMissionIds: f.inferenceWaits, createdAt: new Date().toISOString() };
    },
    async stop() { await rt?.close(); },
    async health() {
      const f = await facts();
      const lost = (ctx.restore?.inferenceWaitMissionIds ?? []).filter((id: string) =>
        ["FAILED", "CANCELED"].includes(f.statuses[id]));
      return { healthy: !!rt?.missionStore && lost.length === 0, checks: [
        { name: "engineering runtime open", ok: !!rt?.missionStore },
        { name: "inference-wait missions preserved", ok: lost.length === 0, detail: lost.join(",") },
      ] };
    },
  };
}
`,
  );
}
