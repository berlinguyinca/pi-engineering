import { execFileSync, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import type { Evidence, EvidenceTrust } from "../core/types.ts";

/**
 * Default hang guard for a verification command: killed only after this long
 * with NO output at all. A long suite that keeps printing runs to completion.
 */
export const DEFAULT_STAGE_INACTIVITY_MS = 15 * 60_000;

const MAX_STAGE_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Process groups of verification commands still running. `detached` gives each
 * command its own group so a kill reaches grandchildren (npm -> node), but it
 * also means the group is not taken down with this process. Best effort: when
 * this process exits — normally, or on an uncaught exception — every live group
 * is SIGKILLed. A SIGKILL of this process (or a signal without a handler)
 * skips 'exit' handlers, so a group can still outlive it in that case.
 */
const liveProcessGroups = new Set<number>();
let exitReaperInstalled = false;

function trackProcessGroup(pid: number): void {
  liveProcessGroups.add(pid);
  if (exitReaperInstalled) return;
  exitReaperInstalled = true;
  process.on("exit", () => {
    for (const group of liveProcessGroups) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
}

/** How long output may stay open after the command exits before a leftover counts as holding it. */
const PIPE_CLOSE_GRACE_MS = 250;
/** Grace between SIGTERM and SIGKILL for processes a command left behind. */
const LEFTOVER_GRACE_MS = 2_000;

interface GroupMember {
  pid: number;
  /** Process start time as `ps` reports it: with the pid, identifies this exact process. */
  started: string;
}

/**
 * Live (non-zombie) members of a process group, each with its start time.
 * Null when `ps` is unavailable.
 */
function processGroupMembers(pgid: number): GroupMember[] | null {
  try {
    const listing = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat=,lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    const members: GroupMember[] = [];
    for (const line of listing.split("\n")) {
      const [pid, group, stat, ...started] = line.trim().split(/\s+/);
      if (Number(group) !== pgid || stat?.startsWith("Z")) continue;
      members.push({ pid: Number(pid), started: started.join(" ") });
    }
    return members;
  } catch {
    return null;
  }
}

/**
 * Terminate what a finished command left in its process group: SIGTERM now,
 * then SIGKILL after a grace period to exactly the processes seen now (same
 * pid AND start time), so a reused pid or pgid is never hit. The escalation
 * timer is unref'd and outlives the stage, so a child that ignores SIGTERM is
 * still killed. Returns how many processes were left behind.
 */
function reapLeftovers(pgid: number): number {
  try {
    process.kill(-pgid, 0);
  } catch {
    return 0;
  }
  const members = processGroupMembers(pgid);
  if (members !== null && members.length === 0) return 0;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return 0;
  }
  const escalate = setTimeout(() => {
    if (members === null) {
      // No process listing: fall back to the group, if it still exists.
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Already gone.
      }
      return;
    }
    const current = processGroupMembers(pgid) ?? [];
    for (const member of current) {
      if (!members.some((seen) => seen.pid === member.pid && seen.started === member.started)) continue;
      try {
        process.kill(member.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, LEFTOVER_GRACE_MS);
  escalate.unref();
  return members?.length ?? 1;
}

/**
 * Run a command with an INACTIVITY guard instead of a total-duration timeout:
 * every chunk of stdout/stderr re-arms it, so only a silent (hung) command is
 * killed. Resolves with the exit code; never rejects for a non-zero exit.
 *
 * When the command itself exits, anything it left running in its process
 * group (`npm test &`, a dev server a test started, a watcher) is terminated
 * (SIGTERM, then SIGKILL after a short grace) and counted in
 * `leftoverProcesses`, so verification never leaves processes behind and a
 * background child holding the output pipes cannot stall the result.
 */
export function runWithInactivityGuard(
  command: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; inactivityMs: number },
): Promise<{ code: number; stdout: string; stderr: string; hung: boolean; leftoverProcesses: number }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      return;
    }
    let stdout = "";
    let stderr = "";
    let hung = false;
    let settled = false;
    let leftoverProcesses = 0;
    /** A process the command left behind kept stdout/stderr open after it exited. */
    let pipesHeld = false;
    let pipeGrace: ReturnType<typeof setTimeout> | undefined;
    // Own process group, so a kill reaches grandchildren (npm -> node) that
    // would otherwise hold the output pipes open forever.
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const groupPid = process.platform !== "win32" ? child.pid : undefined;
    if (groupPid) trackProcessGroup(groupPid);
    const killTree = (): void => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        hung = true;
        stderr += `\n[pi-engineering] killed: no output for ${opts.inactivityMs}ms (hung command)\n`;
        killTree();
      }, opts.inactivityMs);
    };
    const onAbort = (): void => {
      killTree();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const append = (current: string, chunk: Buffer): string =>
      current.length >= MAX_STAGE_OUTPUT_BYTES ? current : current + chunk.toString("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      arm();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
      arm();
    });
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (groupPid) liveProcessGroups.delete(groupPid);
      if (timer) clearTimeout(timer);
      if (pipeGrace) clearTimeout(pipeGrace);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.on("exit", () => {
      if (!groupPid) return;
      // The command is done. If its output does not close shortly, a process
      // it left behind holds the pipes: the output never completed, so the
      // group is reaped now and the stage fails (no waiting for the
      // inactivity guard). Otherwise leftovers are reaped on close.
      pipeGrace = setTimeout(() => {
        pipesHeld = true;
        stderr +=
          "\n[pi-engineering] a background process kept the command's output open after it exited; terminated\n";
        leftoverProcesses = reapLeftovers(groupPid);
      }, PIPE_CLOSE_GRACE_MS);
    });
    child.on("error", (error) =>
      finish(() =>
        resolve({ code: 1, stdout, stderr: `${stderr}${error.message}`, hung: false, leftoverProcesses: 0 }),
      ),
    );
    child.on("close", (code) =>
      finish(() => {
        if (groupPid && !pipesHeld) leftoverProcesses = reapLeftovers(groupPid);
        if (opts.signal?.aborted) {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          return;
        }
        const exitCode = typeof code === "number" ? code : 1;
        resolve({ code: pipesHeld && exitCode === 0 ? 1 : exitCode, stdout, stderr, hung, leftoverProcesses });
      }),
    );
    arm();
  });
}

/** A verification stage from a profile (spec §15). */
export interface VerifyStage {
  name: string;
  command: string;
  args: string[];
  /** Stop the profile on hard failure. */
  required: boolean;
  cwd?: string;
  /** Hang guard: kill the command after this long with no output (not a total-duration limit). */
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
  /**
   * True when the repo declared no verification targets at all (no scripts and
   * no resolvable JS entry file). This is NOT a pass: it means nothing was
   * actually verified, so the completion gate must not treat it as passing
   * evidence. It exists so the verifier can report an honest, distinct outcome
   * instead of a doomed `node --check index.js` stage that hard-fails every
   * scriptless repo.
   */
  noTargets: boolean;
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
  run(
    cwd: string,
    profile: VerificationProfile,
    artifactStore: ArtifactStore,
    opts?: { signal?: AbortSignal },
  ): Promise<VerifyOutcome>;
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
 * True when an npm-style script needs a shell to mean what it says: command
 * chaining (`&&`, `||`, `;`), pipes, redirection, substitution, or a leading
 * `VAR=value` assignment. npm itself runs scripts through `sh -c`; splitting
 * such a script into words and exec'ing it passes `&&` as a literal argument,
 * so every chained script fails.
 */
export function needsShell(script: string): boolean {
  return /&&|\|\||[;|<>`$]/.test(script) || /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(script);
}

/** Command + args for a declared script: direct exec when safe, otherwise `sh -c` like npm. */
export function scriptCommand(script: string): { command: string; args: string[] } {
  if (needsShell(script)) return { command: "sh", args: ["-c", script] };
  return tokenizeCommand(script);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** The test script `npm init` writes: it declares no tests and always fails. */
const NPM_PLACEHOLDER_TEST = /^echo "Error: no test specified" && exit 1$/;

/** True when a Makefile declares `target:` (not `target :=` assignments). */
function makefileHasTarget(makefile: string, target: string): boolean {
  return new RegExp(`^${target}\\s*:(?!=)`, "m").test(makefile);
}

/**
 * Checks for repositories that are not driven by package.json scripts. Each
 * ecosystem is detected from its own manifest, so a Rust/Go/Python/Make repo
 * gets real evidence instead of a zero-check run.
 */
async function nonNodeStages(cwd: string): Promise<VerifyStage[]> {
  const stages: VerifyStage[] = [];
  const stage = (name: string, command: string, args: string[]): VerifyStage => ({
    name,
    command,
    args,
    required: true,
    timeoutMs: DEFAULT_STAGE_INACTIVITY_MS,
  });
  if (await exists(join(cwd, "Cargo.toml"))) {
    stages.push(stage("typecheck", "cargo", ["check", "--all-targets"]));
    stages.push(stage("test", "cargo", ["test"]));
  }
  if (await exists(join(cwd, "go.mod"))) {
    stages.push(stage("build", "go", ["build", "./..."]));
    stages.push(stage("test", "go", ["test", "./..."]));
  }
  const pyproject = (await readText(join(cwd, "pyproject.toml"))) ?? "";
  const setupCfg = (await readText(join(cwd, "setup.cfg"))) ?? "";
  if (
    (await exists(join(cwd, "pytest.ini"))) ||
    (await exists(join(cwd, "conftest.py"))) ||
    /\[tool\.pytest/.test(pyproject) ||
    /\[tool:pytest\]/.test(setupCfg)
  ) {
    stages.push(stage("test", "python3", ["-m", "pytest", "-q"]));
  }
  const makefile = (await readText(join(cwd, "Makefile"))) ?? (await readText(join(cwd, "makefile")));
  if (makefile && !stages.some((s) => s.name === "test")) {
    for (const target of ["check", "test"]) {
      if (makefileHasTarget(makefile, target)) stages.push(stage(target, "make", [target]));
    }
  }
  return stages;
}

/** Manifest fingerprint for the profile cache: detection depends on more than package.json. */
async function manifestFingerprint(cwd: string): Promise<string> {
  const parts: string[] = [];
  for (const file of ["Cargo.toml", "go.mod", "pytest.ini", "conftest.py", "pyproject.toml", "setup.cfg", "Makefile"]) {
    const text = await readText(join(cwd, file));
    if (text !== null) parts.push(`${file}:${text.length}:${text.slice(0, 2048)}`);
  }
  return parts.join("\u0001");
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
 * Resolve a real JS entry file to syntax-check when a repo declares no scripts.
 * Prefers package.json `main`/`exports["."]`/`bin`, then conventional
 * `index.js`/`src/index.js`. Returns a path relative to the repo root (or an
 * absolute path), or null when no such file exists. Never returns a path that
 * does not exist, so the caller cannot emit a doomed syntax-check stage.
 */
async function resolveJsEntry(
  cwd: string,
  pkg: { main?: string; exports?: unknown; bin?: unknown },
): Promise<string | null> {
  const candidates: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === "string" && v && !v.endsWith(".json")) candidates.push(v);
  };
  add(pkg.main);
  const exportsObj = pkg.exports;
  if (exportsObj && typeof exportsObj === "object" && !Array.isArray(exportsObj)) {
    const dot = (exportsObj as Record<string, unknown>)["."];
    if (typeof dot === "string") add(dot);
    else if (dot && typeof dot === "object") {
      const imp = (dot as Record<string, unknown>).import;
      const req = (dot as Record<string, unknown>).require;
      add(imp);
      add(req);
    }
  }
  const bin = pkg.bin;
  if (bin && typeof bin === "object") for (const v of Object.values(bin)) add(v);
  else add(bin);
  candidates.push("index.js", "src/index.js", "lib/index.js");

  for (const cand of candidates) {
    const abs = join(cwd, cand);
    try {
      await access(abs);
      return basename(cand) === "index.js" ? cand : cand;
    } catch {
      /* keep looking */
    }
  }
  return null;
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
    return { key: `${cwd}\u0000${content}\u0000${await manifestFingerprint(cwd)}\u0000full:${full ? 1 : 0}`, pkg };
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
    const profile = await this.buildProfile(pkg, full, cwd);
    this.profileCache.set(key, profile);
    return profile;
  }

  private async buildProfile(
    pkg: { scripts?: Record<string, string>; main?: string; exports?: unknown; bin?: unknown },
    full: boolean,
    cwd: string,
  ): Promise<VerificationProfile> {
    const scripts = pkg.scripts ?? {};
    const stages: VerifyStage[] = [];

    const push = (name: string, script?: string, required = true): void => {
      if (!script) return;
      const { command, args } = scriptCommand(script);
      stages.push({
        name,
        command,
        args,
        required,
        timeoutMs: DEFAULT_STAGE_INACTIVITY_MS,
      });
    };
    push("typecheck", scripts.typecheck ?? scripts.check);
    push("test", NPM_PLACEHOLDER_TEST.test(scripts.test ?? "") ? undefined : scripts.test);
    push("build", scripts.build);
    // npm scripts win whenever they declare a typecheck/test/build. Otherwise
    // (no package.json, or one carrying only lint/format/dev scripts in a
    // mixed repository) the root's own ecosystem manifests decide.
    if (stages.length === 0) stages.push(...(await nonNodeStages(cwd)));
    if (full) {
      // Broader suite: lint + an explicit full-test script, when declared.
      // Both are required so /verify full cannot report PASSED while the
      // declared full suite or linter is failing.
      push("lint", scripts.lint);
      push("test:full", scripts["test:full"] ?? scripts["test:all"]);
    }
    if (stages.length === 0) {
      // No declared scripts. Only fall back to a syntax check if a real JS
      // entry file exists — otherwise the stage is doomed to ENOENT and would
      // hard-fail every scriptless repo (finding FINDING-2CcenM). Prefer the
      // package.json entry points, then conventional index files.
      const entry = await resolveJsEntry(cwd, pkg);
      if (entry) {
        stages.push({
          name: "node-syntax",
          command: "node",
          args: ["--check", entry],
          required: false,
          cwd,
        });
      }
    }
    return { name: full ? "detected-full" : "detected", stages };
  }

  async run(
    cwd: string,
    profile: VerificationProfile,
    store: ArtifactStore,
    opts?: { signal?: AbortSignal },
  ): Promise<VerifyOutcome> {
    const stageRuns: StageRun[] = [];
    const evidence: Evidence[] = [];
    let failedStage: string | null = null;

    for (const stage of profile.stages) {
      opts?.signal?.throwIfAborted();
      const startedAt = new Date().toISOString();
      let stdout = "";
      let stderr = "";
      let code = -1;
      const res = await runWithInactivityGuard(stage.command, stage.args, {
        cwd: stage.cwd ?? cwd,
        inactivityMs: stage.timeoutMs ?? DEFAULT_STAGE_INACTIVITY_MS,
        env: await cleanEnv(stage.cwd ?? cwd),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      stdout = res.stdout;
      stderr = res.stderr;
      code = res.hung && res.code === 0 ? 1 : res.code;
      const leftoverProcesses = res.leftoverProcesses;
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
        ...(leftoverProcesses > 0
          ? {
              leftoverProcesses,
              warning: `the command left ${leftoverProcesses} background process${leftoverProcesses === 1 ? "" : "es"} running; terminated after the stage`,
            }
          : {}),
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
    const noTargets = stageRuns.length === 0;
    // A repo with no declared verification targets is NOT a pass (nothing was
    // actually verified) and NOT a doomed hard-fail. Report it as a distinct
    // honest outcome so callers can decide how to gate (finding FINDING-2CcenM).
    const passed = !noTargets && failedStage === null && stageRuns.length > 0 && stageRuns.some((s) => s.passed);
    return { passed, stages: stageRuns, evidence, failedStage, noTargets };
  }
}
