/**
 * Production {@link PlannotatorTransport}: a thin adapter over Herdr's existing
 * host CLI (`herdr-plannotator plan --plan-file <file> ...`, see Herdr
 * docs/plannotator-integration.md). No protocol is invented here.
 *
 * The CLI registers the review with the control plane (instance_id + revision +
 * plan_digest, sha256 of the exact plan bytes), launches the upstream
 * Plannotator, posts the receipt, and prints the upstream JSON result
 * ({decision: approved|annotated|denied|dismissed, feedback}) on stdout. This
 * adapter:
 *   - writes the exact plan text to a private file, so the digest Herdr
 *     computes is the digest Pi holds (verified here before launch);
 *   - spawns the CLI with an argument vector (never a shell string), a scrubbed
 *     environment, a hard timeout and bounded output;
 *   - maps approved -> approved, annotated|denied -> annotated (changes
 *     requested), and treats dismissed, a crash, a timeout, a non-zero exit,
 *     malformed output or a mismatching echoed digest as "no decision", which
 *     the gate resolves by its require/offer rules (fail closed).
 *
 * Restart note: the CLI has no lookup call, so a resumed pending plan is
 * resubmitted as a fresh review of the same digest.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, accessSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { PlanProposal, PlannotatorDecision, PlannotatorTransport } from "./Plannotator.ts";

export interface HerdrPlannotatorConfig {
  /** Executable name (looked up on `searchPath`) or absolute path. Default `herdr-plannotator`. */
  command?: string;
  /** Extra flags placed after the subcommand, e.g. ["--control-plane", "https://..."]. */
  args?: string[];
  /** Working directory for the review (the project workspace). */
  cwd?: string;
  /** Hard limit for the whole review; default 10 minutes. */
  timeoutMs?: number;
  /** Cap on captured stdout bytes; default 256 KiB. */
  maxOutputBytes?: number;
  /**
   * PATH a bare command is resolved against. Default {@link TRUSTED_COMMAND_PATH},
   * never the caller's PATH.
   */
  searchPath?: string;
  /** Extra environment variable NAMES passed through (on top of the fixed allowlist). */
  envAllow?: string[];
}

/** Fixed, documented lookup path for a bare command name. */
export const TRUSTED_COMMAND_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * The only environment the bridge receives: basics, locale/tmp/XDG state (it
 * reads host.json and its key file from there) and the variables Herdr's docs
 * name for the bridge. Everything else (SSH_AUTH_SOCK, *_PAT, DATABASE_URL, AWS_*,
 * ...) is left out by construction, not by pattern.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "HERDR_ENGINEERING_CONTROL_PLANE_URL",
  "HERDR_ENGINEERING_CONTROL_PLANE_KEY",
  "PLANNOTATOR_URL_HOST",
];

/** A command is a bare name or an absolute path; './x', '../x' and 'dir/x' are refused. */
export function assertTrustedCommand(command: string): void {
  if (!command || command.includes("\0")) throw new Error("plannotator command is empty");
  if (command.includes("/") && !isAbsolute(command)) {
    throw new Error(`plannotator command "${command}" must be an absolute path or a bare name`);
  }
}

export const DEFAULT_HERDR_PLANNOTATOR_COMMAND = "herdr-plannotator";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;
/** Mirrors the bridge's plan limit (MAX_TEXT); larger plans are refused up front. */
const MAX_PLAN_BYTES = 200_000;
function resolveCommand(command: string, searchPath: string): string {
  assertTrustedCommand(command);
  if (isAbsolute(command)) return command;
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error(`${command} is not installed or is not on PATH`);
}

function childEnv(extra: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...CHILD_ENV_ALLOWLIST, ...extra]) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return env;
}

/** Last JSON object in stdout (the bridge prints exactly one; upstream noise goes to stderr). */
function parseResult(stdout: string): Record<string, unknown> {
  const text = stdout.trim();
  const candidates = [
    text,
    ...text
      .split("\n")
      .reverse()
      .filter((l) => l.trim()),
  ];
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("Plannotator bridge printed no JSON object");
}

function mapDecision(value: unknown): PlannotatorDecision {
  if (value === "approved") return "approved";
  if (value === "annotated" || value === "denied") return "annotated";
  if (value === "dismissed") throw new Error("review was dismissed without a decision");
  throw new Error("unsupported Plannotator decision");
}

export function createHerdrPlannotatorTransport(config: HerdrPlannotatorConfig = {}): PlannotatorTransport {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return {
    async submitPlan(plan: PlanProposal) {
      if (typeof plan.planText !== "string" || !plan.planDigest) {
        throw new Error("plan text and digest are required for a digest-bound review");
      }
      const bytes = Buffer.from(plan.planText, "utf8");
      if (bytes.length > MAX_PLAN_BYTES) throw new Error("plan exceeds the review size limit");
      // The bridge hashes the file bytes: refuse to launch if that would not be Pi's digest.
      if (createHash("sha256").update(bytes).digest("hex") !== plan.planDigest) {
        throw new Error("plan text does not match its digest");
      }
      const executable = resolveCommand(
        config.command ?? DEFAULT_HERDR_PLANNOTATOR_COMMAND,
        config.searchPath ?? TRUSTED_COMMAND_PATH,
      );
      const dir = mkdtempSync(join(tmpdir(), "pi-plan-review-"));
      try {
        const planFile = join(dir, "plan.md");
        writeFileSync(planFile, bytes, { mode: 0o600 });
        const argv = [
          "plan",
          "--plan-file",
          planFile,
          "--mission-id",
          plan.runId,
          "--title",
          `Plan ${plan.runId} revision ${plan.revision ?? 1}`,
          ...(config.args ?? []),
        ];
        const { stdout } = await run(
          executable,
          argv,
          config.cwd ?? process.cwd(),
          timeoutMs,
          maxOutput,
          config.envAllow ?? [],
        );
        const result = parseResult(stdout);
        const echoed = result.plan_digest;
        const feedback =
          typeof result.feedback === "string"
            ? result.feedback
            : typeof result.message === "string"
              ? result.message
              : "";
        return {
          decision: mapDecision(result.decision),
          externalDecisionId: typeof result.review_id === "string" ? result.review_id : null,
          approvedBy: null,
          annotations: feedback ? [feedback] : [],
          planDigest: typeof echoed === "string" ? echoed : null,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM then SIGKILL the child's whole process group, and wait until it is gone. */
async function terminateGroup(pid: number): Promise<void> {
  for (const [signal, waitMs] of [
    ["SIGTERM", 2_000],
    ["SIGKILL", 3_000],
  ] as const) {
    try {
      process.kill(-pid, signal);
    } catch {
      return; // already gone
    }
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      if (!groupAlive(pid)) return;
      await sleep(25);
    }
  }
}

function run(
  file: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxOutput: number,
  envAllow: readonly string[],
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      // detached: the child leads its own process group, so a timeout reaches
      // the upstream Plannotator it launches too.
      child = spawn(file, argv, {
        cwd,
        env: childEnv(envAllow),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Reject only once the whole group is gone, so the caller may delete the plan dir.
      const pid = child.pid;
      (pid ? terminateGroup(pid) : Promise.resolve()).then(() => reject(error));
    };
    const timer = setTimeout(() => fail(new Error(`Plannotator bridge timed out after ${timeoutMs}ms`)), timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      size += d.length;
      if (size > maxOutput) fail(new Error("Plannotator bridge output exceeded the limit"));
      else chunks.push(d);
    });
    child.stderr?.resume(); // diagnostics are not captured: they may carry plan text
    child.on("error", (err) => fail(err));
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const pid = child.pid;
      const done = (pid && groupAlive(pid) ? terminateGroup(pid) : Promise.resolve()).then(() => {
        if (code === 0) resolve({ stdout: Buffer.concat(chunks).toString("utf8") });
        else reject(new Error(`Plannotator bridge exited with ${signal ?? `status ${code}`}`));
      });
      void done;
    });
  });
}
