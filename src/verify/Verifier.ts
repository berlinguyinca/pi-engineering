import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import type { Evidence, EvidenceTrust } from "../core/types.ts";

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
  /** Detect the repo's verification profile. `full` adds a broader suite (lint + test:full). */
  detect(cwd: string, opts?: { full?: boolean }): Promise<VerificationProfile>;
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
/**
 * Resolve the nearest `node_modules/.bin` directory by walking up from `cwd`.
 * The verifier spawns commands via execFile with bare binary names (e.g. `tsc`,
 * `biome`, `eslint`) parsed out of npm scripts. Those binaries live in a
 * repository's local `node_modules/.bin`, which is NOT on the ambient PATH when
 * the runtime itself is launched directly with `node` (rather than via `npm`).
 * Without this, every deterministic gate would spuriously fail with ENOENT even
 * when the underlying tool works — silently blocking integration/validation for
 * correctly-landed work.
 */
async function localBinDir(cwd: string): Promise<string | null> {
  let dir = cwd;
  for (;;) {
    const bin = join(dir, "node_modules", ".bin");
    try {
      await access(bin);
      return bin;
    } catch {
      /* continue walking up */
    }
    const parent = dir.split("/").slice(0, -1).join("/");
    if (parent === dir || parent.length === 0) return null;
    dir = parent;
  }
}

/**
 * Child-process env with the node test-runner IPC context stripped, plus the
 * nearest `node_modules/.bin` (resolved from `cwd`) prepended to PATH so bare
 * local tool binaries resolve. When the runtime itself runs under `node --test`,
 * spawned `node` commands inherit NODE_TEST_CONTEXT and would otherwise behave
 * as test children (reporting over a stale IPC fd) instead of running as real
 * commands — a silent false pass for verification. We never want that inheritance.
 */
async function cleanEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const bin = await localBinDir(cwd);
  if (bin) {
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const existing = (env[pathKey] as string | undefined) ?? "";
    env[pathKey] = existing ? `${bin}${process.platform === "win32" ? ";" : ":"}${existing}` : bin;
  }
  return env;
}

/** Deterministic verifier that runs detected shell commands. */
export class CommandVerifier implements VerificationProvider {
  /**
   * Per-repo profile cache, keyed on cwd + package.json CONTENT (not just
   * cwd), so a profile is re-derived only when its inputs change. The key must
   * read package.json to detect content changes, but once derived the JSON
   * parse + profile build (stage/tool selection) are skipped on cache hits.
   */
  private readonly profileCache = new Map<string, VerificationProfile>();

  private async cacheKey(
    cwd: string,
    full: boolean,
  ): Promise<{ key: string; pkg: { scripts?: Record<string, string> } }> {
    let pkg: { scripts?: Record<string, string> } = {};
    let content = "__missing__";
    try {
      content = await readFile(join(cwd, "package.json"), "utf-8");
      pkg = JSON.parse(content) as { scripts?: Record<string, string> };
    } catch {
      pkg = {};
    }
    return { key: `${cwd}\u0000${content}\u0000full:${full ? 1 : 0}`, pkg };
  }

  /** Invalidate the cache (e.g. after package.json changes). Primarily for tests. */
  clearCache(): void {
    this.profileCache.clear();
  }

  /**
   * Detect a verification profile. With `full`, additionally include the repo's
   * declared `lint` and `test:full` stages (a broader verification suite) so
   * `/verify full` records more evidence than the default gate.
   */
  async detect(cwd: string, opts?: { full?: boolean }): Promise<VerificationProfile> {
    const full = opts?.full ?? false;
    const { key, pkg } = await this.cacheKey(cwd, full);
    const cached = this.profileCache.get(key);
    if (cached) return cached;
    const profile = this.buildProfile(pkg, full);
    this.profileCache.set(key, profile);
    return profile;
  }

  private buildProfile(pkg: { scripts?: Record<string, string> }, full: boolean): VerificationProfile {
    const scripts = pkg.scripts ?? {};
    const stages: VerifyStage[] = [];

    const push = (name: string, script?: string, required = true): void => {
      if (!script) return;
      const { command, args } = tokenizeCommand(script);
      stages.push({
        name,
        command,
        args,
        required,
        timeoutMs: 300_000,
      });
    };
    push("typecheck", scripts.typecheck ?? scripts.check);
    push("test", scripts.test);
    push("build", scripts.build);
    if (full) {
      // Broader suite: lint + an explicit full-test script, when declared.
      // Both are required so /verify full cannot report PASSED while the
      // declared full suite or linter is failing.
      push("lint", scripts.lint);
      push("test:full", scripts["test:full"] ?? scripts["test:all"]);
    }
    if (stages.length === 0) {
      stages.push({
        name: "node-syntax",
        command: "node",
        args: ["--check", "index.js"],
        required: false,
      });
    }
    return { name: full ? "detected-full" : "detected", stages };
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
          env: await cleanEnv(stage.cwd ?? cwd),
        });
        stdout = res.stdout;
        stderr = res.stderr;
        code = 0;
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
        code = typeof e.code === "number" ? e.code : 1;
        stdout = (e.stdout as string) ?? "";
        stderr = (e.stderr as string) ?? e.message ?? String(e);
      }
      const finishedAt = new Date().toISOString();
      const passed = code === 0;
      const log = `$ ${stage.command} ${stage.args.join(" ")}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
      // Unique id so re-runs never overwrite content that prior Evidence records
      // still reference (artifact integrity).
      const artifactUri = (
        await store.put(
          "verify",
          `${profile.name}-${stage.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          log,
          truncate(log, 500),
        )
      ).uri;

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
