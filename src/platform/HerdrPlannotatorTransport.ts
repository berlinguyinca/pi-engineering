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
  /** PATH to resolve a bare command against; default the process PATH. */
  searchPath?: string;
}

export const DEFAULT_HERDR_PLANNOTATOR_COMMAND = "herdr-plannotator";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;
/** Mirrors the bridge's plan limit (MAX_TEXT); larger plans are refused up front. */
const MAX_PLAN_BYTES = 200_000;
const SECRETISH = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTHORIZATION|CREDENTIAL|_KEY$/i;
/** The one secret-shaped name the bridge itself documents as its credential source. */
const BRIDGE_KEY = "HERDR_ENGINEERING_CONTROL_PLANE_KEY";

function resolveCommand(command: string, searchPath: string): string {
  if (isAbsolute(command) || command.includes("/")) return command;
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

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.toUpperCase().startsWith("GIT_")) continue;
    if (SECRETISH.test(k) && k !== BRIDGE_KEY) continue;
    env[k] = v;
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
        config.searchPath ?? process.env.PATH ?? "",
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
        const { stdout } = await run(executable, argv, config.cwd ?? process.cwd(), timeoutMs, maxOutput);
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

function run(
  file: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxOutput: number,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, argv, { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (err) {
      reject(err);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const kill = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new Error(`Plannotator bridge timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      size += d.length;
      if (size > maxOutput) {
        kill();
        finish(() => reject(new Error("Plannotator bridge output exceeded the limit")));
        return;
      }
      chunks.push(d);
    });
    child.stderr?.resume(); // diagnostics are not captured: they may carry plan text
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code, signal) =>
      finish(() => {
        if (code === 0) resolve({ stdout: Buffer.concat(chunks).toString("utf8") });
        else reject(new Error(`Plannotator bridge exited with ${signal ?? `status ${code}`}`));
      }),
    );
  });
}
