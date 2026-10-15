import { execFile, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import type { Evidence, EvidenceTrust } from "../core/types.ts";
import { withRustBuildEnv } from "../git/rustBuildCache.ts";
import { type MissionBuildOptions, admitMissionBuild } from "../resources/buildBudget.ts";
import {
  type BaselineVerdict,
  type FailureBaseline,
  compareToBaseline,
  hashProfile,
  parseFailingTests,
} from "./failureBaseline.ts";
import {
  DEFAULT_SAMPLE_MS,
  DEFAULT_TEST_WATCHDOG,
  type StallEvidence,
  type TestWatchdogConfig,
  type WatchdogLevel,
  type WatchdogSettings,
  captureEvidenceSync,
  classify,
  countTestEvents,
  initialWatchdogState,
  listProcessGroup,
  observe,
  resolveStageWatchdog,
  sampleGroup,
} from "./testWatchdog.ts";

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
  const members = listProcessGroup(pgid);
  if (members === null) return null;
  return members.filter((m) => !m.state.startsWith("Z")).map((m) => ({ pid: m.pid, started: m.started }));
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

/** Why and how the progress watchdog ended a stage. */
export interface StageStall {
  level: "stalled";
  /** Milliseconds without progress when it fired. */
  silentMs: number;
  /** Process tree and output tail captured BEFORE the signal. */
  evidence: StallEvidence;
}

const WATCHDOG_RECENT_BYTES = 32 * 1024;

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
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    inactivityMs: number;
    /** Progress watchdog (#146): classifies the stage by real progress, not just output. */
    watchdog?: WatchdogSettings;
  },
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  hung: boolean;
  leftoverProcesses: number;
  spawnFailed?: boolean;
  /** Set when the progress watchdog (not the no-output guard) ended the command. */
  stalled?: StageStall;
}> {
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
    let stalled: StageStall | undefined;
    let outputBytes = 0;
    let testEvents = 0;
    let recent = "";
    let sampler: ReturnType<typeof setInterval> | undefined;
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
    const noteOutput = (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (!opts.watchdog) return;
      const text = chunk.toString("utf8");
      testEvents += countTestEvents(text) + countNextestEvents(text);
      recent = (recent + text).slice(-WATCHDOG_RECENT_BYTES);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      noteOutput(chunk);
      arm();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
      noteOutput(chunk);
      arm();
    });
    if (opts.watchdog && groupPid) {
      const cfg: TestWatchdogConfig & { sampleMs: number } = {
        warnMs: opts.watchdog.warnMs ?? DEFAULT_TEST_WATCHDOG.warnMs,
        investigateMs: opts.watchdog.investigateMs ?? DEFAULT_TEST_WATCHDOG.investigateMs,
        stallMs: opts.watchdog.stallMs ?? DEFAULT_TEST_WATCHDOG.stallMs,
        sampleMs: opts.watchdog.sampleMs ?? DEFAULT_SAMPLE_MS,
      };
      let state = initialWatchdogState(Date.now());
      state = observe(state, sampleGroup(groupPid, 0, 0), Date.now());
      let announced: WatchdogLevel = "progressing";
      const end = (level: StageStall["level"], now: number): void => {
        if (stalled) return;
        // Evidence first, then the signal: the tree must still be alive to be captured.
        const evidence = captureEvidenceSync(groupPid, recent);
        const silentMs = now - state.lastProgressAtMs;
        stalled = { level, silentMs, evidence };
        hung = true;
        stderr += `\n[pi-engineering] killed: test stage stalled, no progress for ${silentMs}ms (last progress: ${state.lastProgressKind ?? "none"})\n${JSON.stringify(evidence)}\n`;
        killTree();
      };
      sampler = setInterval(() => {
        if (settled || stalled) return;
        const now = Date.now();
        state = observe(state, sampleGroup(groupPid, outputBytes, testEvents), now);
        const level = classify(state, now, cfg);
        if (level === "stalled") return end("stalled", now);
        if (level !== announced) {
          announced = level;
          if (level !== "progressing") {
            stderr += `\n[pi-engineering] test stage ${level}: no progress for ${now - state.lastProgressAtMs}ms\n`;
          }
        }
      }, cfg.sampleMs);
      sampler.unref();
    }
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (groupPid) liveProcessGroups.delete(groupPid);
      if (timer) clearTimeout(timer);
      if (pipeGrace) clearTimeout(pipeGrace);
      if (sampler) clearInterval(sampler);
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
        resolve({
          code: 1,
          stdout,
          stderr: `${stderr}${error.message}`,
          hung: false,
          leftoverProcesses: 0,
          spawnFailed: true,
        }),
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
        resolve({
          code: pipesHeld && exitCode === 0 ? 1 : exitCode,
          stdout,
          stderr,
          hung,
          leftoverProcesses,
          ...(stalled ? { stalled } : {}),
        });
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
  /**
   * Progress watchdog (#146). Test stages (`test`, `test:*`) get the defaults;
   * `false` turns it off; an object overrides thresholds. There is no
   * total-duration limit: a stage that keeps making progress is never cut off.
   */
  watchdog?: false | WatchdogSettings;
}

/** Detected build/test/typecheck commands for a repository (spec §15.2). */
export interface VerificationProfile {
  name: string;
  stages: VerifyStage[];
}

/** Warning reported when target detection finds nothing to run. */
export const NO_TARGETS_WARNING = "no verification targets detected; nothing to run";

export interface StageRun {
  stage: VerifyStage;
  exitCode: number;
  passed: boolean;
  summary: Record<string, unknown>;
  artifactUri: string;
  /** Wall time of this stage's command. */
  durationMs?: number;
  /** Failing test names parsed from node:test output, when the stage reported any. */
  failingTests?: string[];
}

export interface VerifyOutcome {
  passed: boolean;
  stages: StageRun[];
  evidence: Evidence[];
  failedStage: string | null;
  /**
   * True when the repo declared no verification targets at all (no scripts and
   * no resolvable JS entry file). The run passes with a warning (nothing ran,
   * so nothing failed); `noTargets` lets callers that require tests (an
   * acceptance criterion demanding them) still reject the absence.
   */
  noTargets: boolean;
  /** Non-blocking notes, e.g. that no verification targets were detected. */
  warnings?: string[];
  /** Hash of the profile this outcome ran (see failureBaseline.hashProfile). */
  profileHash?: string;
  /** Present only when the run was given a failure baseline: introduced failures block, pre-existing ones do not. */
  baselineVerdict?: BaselineVerdict;
}

/** Options for a verification run. */
export interface VerifyRunOptions {
  signal?: AbortSignal;
  /** Failures already present at the base; see failureBaseline.captureBaseline. */
  baseline?: FailureBaseline;
  /** The base SHA the candidate is bound to. A baseline for any other SHA is stale. */
  boundBaseSha?: string;
  /** Mission this run belongs to; with {@link build} its Rust stages get a per-mission `CARGO_TARGET_DIR`. */
  missionId?: string;
  /** Build directory and disk admission for the mission (see src/resources/buildBudget.ts). */
  build?: MissionBuildOptions;
  /** Run every stage even after a required stage fails (a baseline must see the whole profile). */
  exhaustive?: boolean;
  /** Keep going after a required failure in these stages (their failure is inherited from the base). */
  continueThrough?: ReadonlySet<string>;
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
    opts?: VerifyRunOptions,
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
async function nonNodeStages(cwd: string, hasNextest: () => Promise<boolean>): Promise<VerifyStage[]> {
  const stages: VerifyStage[] = [];
  const stage = (name: string, command: string, args: string[]): VerifyStage => ({
    name,
    command,
    args,
    required: true,
    timeoutMs: DEFAULT_STAGE_INACTIVITY_MS,
  });
  if (await exists(join(cwd, "Cargo.toml"))) {
    stages.push(...rustProfile(await hasNextest()).stages);
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
 * Rust stages are pointed at the shared build cache (src/git/rustBuildCache.ts)
 * so candidate worktrees reuse compiled dependencies instead of each growing
 * their own `target/`.
 */
async function cleanEnv(cwd: string, extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await withRustBuildEnv(env, cwd);
  // The mission's own target dir (issue #144) replaces the shared per-worktree one.
  Object.assign(env, extra);
  const bin = await localBinDir(cwd);
  if (bin) {
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const existing = (env[pathKey] as string | undefined) ?? "";
    env[pathKey] = existing ? `${bin}${process.platform === "win32" ? ";" : ":"}${existing}` : bin;
  }
  return env;
}

// --- Rust: cargo-nextest (autospec R-WATCH, issue #148) ----------------------

/** One test start/finish reported by `cargo nextest run`. */
export interface NextestEvent {
  kind: "start" | "finish";
  /** Set for finish events. */
  status?: "pass" | "fail" | "skip";
  /** `<binary> <test path>` as nextest prints it. */
  test: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
const ANSI = /\u001b\[[0-9;]*m/g;
const NEXTEST_LINE = /^\s*(?:TRY \d+ )?(PASS|FAIL|SKIP|START)\b(?:\s+\[[^\]]*\])?\s*(.*)$/;

/**
 * A test start/finish line of `cargo nextest run`, or null for anything else
 * (headers, SLOW notices, the summary, compiler output). Nextest's lines are
 * indented, so the generic {@link countTestEvents} patterns do not see them.
 */
export function parseNextestLine(line: string): NextestEvent | null {
  const m = NEXTEST_LINE.exec(line.replace(ANSI, ""));
  if (!m) return null;
  const test = (m[2] ?? "").trim();
  if (test.length === 0) return null;
  if (m[1] === "START") return { kind: "start", test };
  return { kind: "finish", status: m[1] === "PASS" ? "pass" : m[1] === "FAIL" ? "fail" : "skip", test };
}

/** Nextest test events in a chunk of output: the watchdog's `test_event` progress. */
export function countNextestEvents(chunk: string): number {
  let count = 0;
  for (const line of chunk.split("\n")) if (parseNextestLine(line)) count++;
  return count;
}

/**
 * The Rust verification stages. With nextest: `cargo nextest run` plus an
 * explicit `cargo test --doc` (nextest does not run doctests). Without it,
 * `cargo test` over the lib, bins and integration tests plus the same doctest
 * stage, so doctests run exactly once either way. Both test stages run under
 * the progress watchdog.
 */
export function rustProfile(hasNextest: boolean): VerificationProfile {
  const stage = (name: string, args: string[], watchdog?: WatchdogSettings): VerifyStage => ({
    name,
    command: "cargo",
    args,
    required: true,
    timeoutMs: DEFAULT_STAGE_INACTIVITY_MS,
    ...(watchdog ? { watchdog } : {}),
  });
  return {
    name: hasNextest ? "rust-nextest" : "rust",
    stages: [
      stage("typecheck", ["check", "--all-targets"]),
      hasNextest ? stage("nextest", ["nextest", "run"], {}) : stage("test", ["test", "--lib", "--bins", "--tests"], {}),
      stage("doctest", ["test", "--doc"], {}),
    ],
  };
}

/** True when `cargo nextest --version` exits 0 in `cwd`. */
export function probeNextest(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("cargo", ["nextest", "--version"], { cwd, timeout: 15_000 }, (error) => resolve(error === null));
  });
}

export interface CommandVerifierOptions {
  /** Whether cargo-nextest is installed; injectable for tests. */
  probeNextest?: (cwd: string) => Promise<boolean>;
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
  private readonly probeNextest: (cwd: string) => Promise<boolean>;

  constructor(opts: CommandVerifierOptions = {}) {
    this.probeNextest = opts.probeNextest ?? probeNextest;
  }

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
    if (stages.length === 0) stages.push(...(await nonNodeStages(cwd, () => this.probeNextest(cwd))));
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
    opts?: VerifyRunOptions,
  ): Promise<VerifyOutcome> {
    const stageRuns: StageRun[] = [];
    const evidence: Evidence[] = [];
    let failedStage: string | null = null;

    for (const stage of profile.stages) {
      opts?.signal?.throwIfAborted();
      const startedAt = new Date().toISOString();
      const stageStart = Date.now();
      let stdout = "";
      let stderr = "";
      let code = -1;
      // Per-mission build dir and disk admission (R-BUILD): a stage that would
      // start a build on a full disk fails before it runs.
      const admission =
        opts?.missionId && opts.build
          ? await admitMissionBuild(stage.cwd ?? cwd, opts.missionId, opts.build)
          : { env: {} as Record<string, string> };
      const res = admission.refused
        ? { code: 1, stdout: "", stderr: admission.refused, hung: false, leftoverProcesses: 0, spawnFailed: true }
        : await runWithInactivityGuard(stage.command, stage.args, {
            cwd: stage.cwd ?? cwd,
            inactivityMs: stage.timeoutMs ?? DEFAULT_STAGE_INACTIVITY_MS,
            ...(resolveStageWatchdog(stage) ? { watchdog: resolveStageWatchdog(stage) } : {}),
            env: await cleanEnv(stage.cwd ?? cwd, admission.env),
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
        // The command died of the environment (hang guard, spawn error), not of its own verdict.
        ...(res.hung || res.spawnFailed ? { infrastructureFailure: true } : {}),
        ...(admission.pressure && admission.pressure.level !== "ok"
          ? { buildPressure: admission.pressure.level, buildPressureReason: admission.pressure.reason }
          : {}),
        ...(res.stalled
          ? { stalled: res.stalled.level, stallSilentMs: res.stalled.silentMs, stallEvidence: res.stalled.evidence }
          : {}),
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
      const failingTests = passed ? [] : parseFailingTests(`${stdout}\n${stderr}`, stage.cwd ?? cwd);
      stageRuns.push({
        stage,
        exitCode: code,
        passed,
        summary,
        artifactUri,
        durationMs: Date.now() - stageStart,
        ...(failingTests.length > 0 ? { failingTests } : {}),
      });
      evidence.push(ev);

      // Stop early on a required hard failure (spec §15.3).
      if (!passed && stage.required) {
        failedStage ??= stage.name;
        if (!opts?.exhaustive && !opts?.continueThrough?.has(stage.name)) break;
      }
    }

    // A run must produce at least one PASSING stage to count as a pass. A
    // profile with only non-required fallback stages that all fail (e.g. the
    // node-syntax fallback for a repo with no scripts) must NOT report a clean
    // pass with zero passing evidence. This keeps "evidence is machine output"
    // honest: passed=true implies at least one deterministic stage actually
    // succeeded.
    const noTargets = stageRuns.length === 0;
    // No targets: nothing ran, nothing failed. Pass with a warning instead of a
    // futile failure that spawns repair rounds no worker can satisfy.
    const passed = noTargets || (failedStage === null && stageRuns.some((s) => s.passed));
    const outcome: VerifyOutcome = {
      passed,
      stages: stageRuns,
      evidence,
      failedStage,
      noTargets,
      warnings: noTargets ? [NO_TARGETS_WARNING] : [],
      profileHash: hashProfile(profile),
    };
    if (opts?.baseline) outcome.baselineVerdict = compareToBaseline(opts.baseline, outcome, opts.boundBaseSha);
    return outcome;
  }
}
