/**
 * Offline one-model mode for a REAL omp: a temp HOME whose `models.yml` points
 * a custom provider at a local scripted OpenAI-compatible server. Nothing is
 * installed, no upstream script runs, and the developer's own ~/.omp is never
 * read (HOME is overridden and cwd is the caller's).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ModelScript,
  type ScriptReply,
  type ScriptTurn,
  type ScriptedModelServer,
  startScriptedModel,
} from "./scriptedModelServer.ts";

export const OFFLINE_MODEL = "pelocal/scripted";

export interface OfflineOmp {
  readonly server: ScriptedModelServer;
  readonly home: string;
  /** Environment for PE's omp flags: worker + adapter on, real binary, isolated HOME, offline model. */
  readonly env: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

/** The real-omp launch pair from OMP_BIN / OMP_BIN_ARGS, or undefined when no real omp is available. */
export function realOmpEnv(): { bin: string; args: string } | undefined {
  const bin = process.env.OMP_BIN;
  if (!bin) return undefined;
  return { bin, args: process.env.OMP_BIN_ARGS ?? "" };
}

export function writeOfflineHome(home: string, baseUrl: string): void {
  const agent = join(home, ".omp", "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    join(agent, "models.yml"),
    `providers:
  pelocal:
    baseUrl: ${baseUrl}
    apiKey: sk-local-not-used
    api: openai-completions
    models:
      - id: scripted
        name: Scripted
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 128000
        maxTokens: 4096
        compat:
          supportsDeveloperRole: false
          supportsStore: false
`,
  );
}

export async function startOfflineOmp(script: ModelScript): Promise<OfflineOmp> {
  const real = realOmpEnv();
  if (!real) throw new Error("startOfflineOmp requires OMP_BIN");
  const server = await startScriptedModel(script);
  const home = mkdtempSync(join(tmpdir(), "pe-omp-home-"));
  writeOfflineHome(home, server.baseUrl);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_ENGINEERING_OMP_WORKER: "1",
    PI_ENGINEERING_OMP_ADAPTER: "1",
    PI_ENGINEERING_OMP_BIN: real.bin,
    PI_ENGINEERING_OMP_BIN_ARGS: real.args,
    PI_ENGINEERING_OMP_MODEL: OFFLINE_MODEL,
    PI_ENGINEERING_OMP_HOME: home,
    HOME: home,
    // omp reads its agent dir from these; the test runner points them at a Pi profile.
    PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
    PI_AGENT_DIR: join(home, ".omp", "agent"),
  };
  return {
    server,
    home,
    env,
    close: async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** What the scripted model does for the engineer scenarios (a declarative stand-in for FakeWorkerExecutor handlers). */
export interface EngineerScript {
  /** File content the implementer writes to src/add.js. */
  readonly implement: string;
  /** Reviewer verdict for review round `n` (1-based): findings, or "fail" for a review that does not complete. */
  readonly review: (n: number) => { findings: unknown[] } | "fail";
}

const roleOf = (turn: ScriptTurn): string => /# Role: (\w+)/.exec(turn.system)?.[1] ?? "unknown";

/** Role-aware script: scout/implementer/reviewer each end by calling the terminating host tool. */
export function engineerModelScript(spec: EngineerScript): ModelScript {
  let reviewRound = 0;
  const done = (turn: ScriptTurn): boolean =>
    turn.priorCalls.some((c) => c === "worker_result" || c === "review_result");
  return (turn): ScriptReply => {
    if (done(turn)) return { kind: "text", text: "done" };
    const role = roleOf(turn);
    if (role === "implementer" && !turn.priorCalls.includes("write")) {
      return { kind: "tool", name: "write", args: { path: "src/add.js", content: spec.implement } };
    }
    const terminating = turn.toolNames.includes("review_result") ? "review_result" : "worker_result";
    if (role === "implementer") {
      return { kind: "tool", name: terminating, args: base("completed", "implemented", {}) };
    }
    if (role === "reviewer") {
      reviewRound += 1;
      const verdict = spec.review(reviewRound);
      if (verdict === "fail") {
        return {
          kind: "tool",
          name: terminating,
          args: base("failed", "Worker exceeded the hard context-token budget.", {}),
        };
      }
      return {
        kind: "tool",
        name: terminating,
        args: base("completed", verdict.findings.length ? "material findings" : "clean", {
          findings: verdict.findings,
        }),
      };
    }
    return { kind: "tool", name: terminating, args: base("completed", "scouted", {}) };
  };
}

const base = (status: string, summary: string, details: Record<string, unknown>) => ({
  status,
  summary,
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
  details,
});
