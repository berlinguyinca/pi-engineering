import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Evidence, EvidenceTrust } from "../core/types.ts";
import { ArtifactStore } from "../artifacts/ArtifactStore.ts";

const exec = promisify(execFile);

/** A verification stage from a profile (spec §15). */
export interface VerifyStage {
  name: string;
  command: string;
  args: string[];
  /** Stop the profile on hard failure. */
  required: boolean;
  cwd?: string;
  timeoutMs?: number;
}

/** Detected build/test/typecheck commands for a repository (spec §15.2). */
export interface VerificationProfile {
  name: string;
  stages: VerifyStage[];
}

export interface StageRun {
  stage: VerifyStage;
  exitCode: number;
  passed: boolean;
  summary: Record<string, unknown>;
  artifactUri: string;
}

export interface VerifyOutcome {
  passed: boolean;
  stages: StageRun[];
  evidence: Evidence[];
  failedStage: string | null;
}

/**
 * Verification provider abstraction (spec §15).
 *
 * Runs cheap, high-signal stages first and stops early on required hard
 * failures. Command output is stored as a lazy artifact; only a compact summary
 * enters evidence. Agent claims never substitute for captured tool output
 * (INV-006, AC-005).
 */
export interface VerificationProvider {
  detect(cwd: string): Promise<VerificationProfile>;
  run(cwd: string, profile: VerificationProfile, artifactStore: ArtifactStore): Promise<VerifyOutcome>;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
}

/**
 * Split an npm-style script into a command + args without invoking a shell.
 * Handles single/double quotes and backslash escapes so quoted and globbed args
 * are preserved (a naive whitespace split silently runs 0 tests, false-passing
 * the gate). Globs are left literal; tools like `node --test` expand their own.
 */
export function tokenizeCommand(script: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let escaping = false;
  for (let i = 0; i < script.length; i++) {
    const ch = script.charAt(i);
    if (escaping) {
      cur += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaping = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  if (tokens.length === 0) return { command: "echo", args: [] };
  return { command: tokens[0]!, args: tokens.slice(1) };
}

/**
 * Child-process env with the node test-runner IPC context stripped. When the
 * runtime itself runs under `node --test`, spawned `node` commands inherit
 * NODE_TEST_CONTEXT and would otherwise behave as test children (reporting
 * over a stale IPC fd) instead of running as real commands — a silent false
 * pass for verification. We never want that inheritance.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Deterministic verifier that runs detected shell commands. */
export class CommandVerifier implements VerificationProvider {
  async detect(cwd: string): Promise<VerificationProfile> {
    let pkg: { scripts?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
    } catch {
      pkg = {};
    }
    const scripts = pkg.scripts ?? {};
    const stages: VerifyStage[] = [];

    const push = (name: string, script?: string): void => {
      if (!script) return;
      const { command, args } = tokenizeCommand(script);
      stages.push({
        name,
        command,
        args,
        required: true,
        timeoutMs: 300_000,
      });
    };
    push("typecheck", scripts.typecheck ?? scripts.check);
    push("test", scripts.test);
    push("build", scripts.build);
    if (stages.length === 0) {
      stages.push({
        name: "node-syntax",
        command: "node",
        args: ["--check", "index.js"],
        required: false,
      });
    }
    return { name: "detected", stages };
  }

  async run(cwd: string, profile: VerificationProfile, store: ArtifactStore): Promise<VerifyOutcome> {
    const stageRuns: StageRun[] = [];
    const evidence: Evidence[] = [];
    let failedStage: string | null = null;

    for (const stage of profile.stages) {
      const startedAt = new Date().toISOString();
      let stdout = "";
      let stderr = "";
      let code = -1;
      try {
        const res = await exec(stage.command, stage.args, {
          cwd: stage.cwd ?? cwd,
          timeout: stage.timeoutMs ?? 300_000,
          maxBuffer: 16 * 1024 * 1024,
          env: cleanEnv(),
        });
        stdout = res.stdout;
        stderr = res.stderr;
        code = 0;
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
        code = typeof e.code === "number" ? e.code : 1;
        stdout = (e.stdout as string) ?? "";
        stderr = (e.stderr as string) ?? (e.message ?? String(e));
      }
      const finishedAt = new Date().toISOString();
      const passed = code === 0;
      const log = `$ ${stage.command} ${stage.args.join(" ")}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
      // Unique id so re-runs never overwrite content that prior Evidence records
      // still reference (artifact integrity).
      const artifactUri = (await store.put("verify", `${profile.name}-${stage.name}-${Date.now().toString(36)}`, log, truncate(log, 500))).uri;

      const summary: Record<string, unknown> = {
        stage: stage.name,
        passed,
        exitCode: code,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      };
      const evidenceId = `EVID-${Math.random().toString(36).slice(2, 8)}`;
      const ev: Evidence = {
        id: evidenceId,
        candidate_id: null,
        type: `verify.${stage.name}`,
        tool: stage.command,
        command: `${stage.command} ${stage.args.join(" ")}`.trim(),
        started_at: startedAt,
        finished_at: finishedAt,
        exit_code: code,
        status: passed ? "passed" : "failed",
        summary,
        artifacts: [artifactUri],
        trust: "deterministic",
      };
      stageRuns.push({ stage, exitCode: code, passed, summary, artifactUri });
      evidence.push(ev);

      // Stop early on a required hard failure (spec §15.3).
      if (!passed && stage.required) {
        failedStage = stage.name;
        break;
      }
    }

    // A run must produce at least one PASSING stage to count as a pass. A
    // profile with only non-required fallback stages that all fail (e.g. the
    // node-syntax fallback for a repo with no scripts) must NOT report a clean
    // pass with zero passing evidence. This keeps "evidence is machine output"
    // honest: passed=true implies at least one deterministic stage actually
    // succeeded.
    const passed = failedStage === null && stageRuns.length > 0 && stageRuns.some((s) => s.passed);
    return { passed, stages: stageRuns, evidence, failedStage };
  }
}
