/**
 * CAV-02 Deterministic Test Execution: normalize build/unit/integration
 * execution with machine-readable evidence.
 *
 * Reconciles with the existing CommandVerifier (src/verify/Verifier.ts), which
 * already detects a repo's verification profile and runs stages with captured
 * machine evidence. This CAV facade binds a deterministic run to the CAV
 * evidence ledger so a step's PASS/FAIL is explainable from evidence, not
 * model prose, and fails closed on a hard failure.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CavEvidenceLedger } from "./evidence.ts";

const exec = promisify(execFile);

export interface CavTestRunOptions {
  requirementId: string;
  command: string;
  args: string[];
  role: string;
  workerRunId: string;
  gitSha: string;
  cwd: string;
  gateType?: string;
  environment?: string;
}

export interface CavTestRunResult {
  exitCode: number;
  passed: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
}

/**
 * Run a deterministic command and record its result into the CAV evidence
 * ledger. The implementer records TESTED on success (never VERIFIED); a
 * failure records SPECIFIED with a failure reason so the gate fails closed.
 */
export async function runDeterministicTest(
  ledger: CavEvidenceLedger,
  opts: CavTestRunOptions,
): Promise<CavTestRunResult> {
  const startedAt = Date.now();
  let exitCode = -1;
  let stdout = "";
  let stderr = "";
  try {
    const res = await exec(opts.command, opts.args, {
      cwd: opts.cwd,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NODE_TEST_CONTEXT: "" },
    });
    stdout = res.stdout;
    stderr = res.stderr;
    exitCode = 0;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    exitCode = typeof e.code === "number" ? e.code : 1;
    stdout = (e.stdout as string) ?? "";
    stderr = (e.stderr as string) ?? e.message ?? String(e);
  }
  const durationMs = Date.now() - startedAt;
  const passed = exitCode === 0;
  const commandLine = `${opts.command} ${opts.args.join(" ")}`.trim();

  await ledger.record(opts.requirementId, passed ? "TESTED" : "SPECIFIED", {
    gitSha: opts.gitSha,
    role: opts.role,
    workerRunId: opts.workerRunId,
    gateType: opts.gateType ?? "deterministic-test",
    tool: opts.command,
    command: commandLine,
    exitCode,
    environment: opts.environment ?? `node ${process.version}`,
    failureReason: passed ? null : `command exited ${exitCode}: ${(stderr || stdout).slice(0, 200)}`,
  });
  return {
    exitCode,
    passed,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    durationMs,
  };
}
