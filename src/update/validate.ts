/**
 * Candidate validation (spec §16-§18, §47). All of it runs BEFORE the active
 * runtime is touched. A failure here has zero effect on the running runtime.
 *
 * Commands run with fixed argv and no shell. Nothing from the candidate's
 * metadata is executed or used as an argument except validated relative paths.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readdir, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CandidateMetadata, piCompatible } from "./metadata.ts";
import type { ProbeReport } from "./probe.ts";
import { type MigrationDecision, prepareMigration } from "./transaction.ts";

export type ValidationMode = "quick" | "default" | "full";

export interface ValidationStep {
  name: string;
  status: "passed" | "failed" | "skipped";
  detail?: string;
}

export interface ValidationResult {
  ok: boolean;
  steps: ValidationStep[];
  /** Set when the candidate cannot run in THIS Pi process (§17, §55). */
  piIncompatible?: string;
  migration?: MigrationDecision;
}

/** Fast tests that guard the runtime contract itself, run when the candidate ships them. */
export const CRITICAL_TESTS = [
  "test/unit/runtime-host-resources.test.ts",
  "test/unit/runtime-update-persistence.test.ts",
];

export function nodeBinary(): string {
  const exec = basename(process.execPath).toLowerCase();
  return exec.startsWith("node") ? process.execPath : "node";
}

function run(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error
        ? typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1
        : 0;
      resolveRun({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function lockDigest(dir: string): string | null {
  try {
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as { packages?: unknown };
    return createHash("sha256")
      .update(JSON.stringify(lock.packages ?? {}))
      .digest("hex");
  } catch {
    return null;
  }
}

/**
 * Copy a dependency tree as hard links (`cp -al` semantics): no bytes are
 * duplicated, yet the copy owns its directory entries, so removing the source
 * tree (retention, rollback cleanup) never takes the copy's files with it.
 * Files that cannot be linked (another filesystem, no hard-link support) are
 * copied. Symlinks are recreated verbatim (npm's `.bin` links are relative).
 */
export async function linkTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isSymbolicLink()) {
      await symlink(await readlink(from), to);
    } else if (entry.isDirectory()) {
      await linkTree(from, to);
    } else if (entry.isFile()) {
      await link(from, to).catch(async (error: NodeJS.ErrnoException) => {
        if (!["EXDEV", "EPERM", "ENOTSUP", "EMLINK", "EOPNOTSUPP"].includes(error.code ?? "")) throw error;
        await copyFile(from, to);
      });
    }
  }
}

/**
 * Give the staged candidate its dependencies. An unchanged lockfile reuses the
 * running runtime's tree as a hard-linked copy (nothing downloaded, and the
 * candidate never depends on another installed version's directory: retention
 * may delete that one). A changed one needs `npm ci --ignore-scripts` in the
 * staging directory, never in the running one.
 */
export async function provisionDependencies(
  stagedDir: string,
  runningRoot: string | null,
  opts: { allowInstall: boolean },
): Promise<ValidationStep> {
  const name = "dependency installation";
  if (existsSync(join(stagedDir, "node_modules"))) return { name, status: "passed", detail: "present" };
  const same = runningRoot !== null && lockDigest(stagedDir) === lockDigest(runningRoot);
  const runningModules = runningRoot ? join(runningRoot, "node_modules") : null;
  if (same && runningModules && existsSync(runningModules)) {
    const target = join(stagedDir, "node_modules");
    try {
      await linkTree(realpathSync(runningModules), target);
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
      return {
        name,
        status: "failed",
        detail: `copying the running dependency tree failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { name, status: "passed", detail: "lockfile unchanged; hard-linked copy of the running dependency tree" };
  }
  if (same) return { name, status: "skipped", detail: "no dependency tree to reuse and none required" };
  if (!opts.allowInstall) {
    return { name, status: "failed", detail: "dependencies changed and installation is disabled" };
  }
  const r = await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], stagedDir, 600_000);
  return r.code === 0
    ? { name, status: "passed", detail: "npm ci --ignore-scripts" }
    : { name, status: "failed", detail: `npm ci failed: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}` };
}

function dependencyResolution(dir: string): ValidationStep {
  const name = "dependency resolution";
  let pkg: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return { name, status: "failed", detail: "package.json unreadable" };
  }
  const wanted = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) });
  const missing = wanted.filter((dep) => {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(dep)) return true;
    return !existsSync(join(dir, "node_modules", dep, "package.json"));
  });
  return missing.length === 0
    ? { name, status: "passed", detail: `${wanted.length} package(s) resolve` }
    : { name, status: "failed", detail: `unresolved: ${missing.join(", ")}` };
}

export interface ValidateOptions {
  dir: string;
  metadata: CandidateMetadata;
  runningPiVersion: string;
  supportedRuntimeApis: readonly number[];
  stateDir: string | null;
  mode: ValidationMode;
}

export async function validateCandidate(opts: ValidateOptions): Promise<ValidationResult> {
  const steps: ValidationStep[] = [];
  const fail = (extra: Partial<ValidationResult> = {}): ValidationResult => ({ ok: false, steps, ...extra });
  const { dir, metadata } = opts;

  const apiOk = opts.supportedRuntimeApis.includes(metadata.runtimeApi);
  steps.push({
    name: "runtime API compatibility",
    status: apiOk ? "passed" : "failed",
    detail: `candidate ${metadata.runtimeApi}; host supports ${opts.supportedRuntimeApis.join(", ")}`,
  });
  const pi = piCompatible(opts.runningPiVersion, metadata.minimumPiVersion, metadata.maximumPiVersion);
  steps.push({
    name: "running Pi compatibility",
    status: pi.ok ? "passed" : "failed",
    detail: pi.ok ? `Pi ${opts.runningPiVersion}` : pi.reason,
  });
  if (!apiOk) return fail({ piIncompatible: `runtime API ${metadata.runtimeApi} needs a newer Pi Engineering host` });
  if (!pi.ok) return fail({ piIncompatible: pi.reason });

  const deps = dependencyResolution(dir);
  steps.push(deps);
  if (deps.status === "failed") return fail();

  let migration: MigrationDecision;
  try {
    migration = await prepareMigration(dir, opts.stateDir);
    steps.push({
      name: "state schema compatibility",
      status: "passed",
      detail: `writes ${metadata.stateSchema.writes}`,
    });
    steps.push({
      name: "migration dry-run",
      status: migration.plan.length > 0 ? "passed" : "skipped",
      detail: migration.plan.length > 0 ? migration.plan.map((m) => m.id).join(", ") : "no migration required",
    });
  } catch (error) {
    steps.push({
      name: "state schema compatibility",
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    return fail();
  }

  const scratch = await mkdtemp(join(tmpdir(), "pi-eng-probe-"));
  try {
    const probe = fileURLToPath(new URL("./probe.ts", import.meta.url));
    const r = await run(nodeBinary(), ["--no-warnings", probe, dir, metadata.entry, scratch], dir, 180_000);
    const line = r.stdout.split("\n").find((l) => l.startsWith("PROBE "));
    const report = line ? (JSON.parse(line.slice(6)) as ProbeReport) : null;
    if (!report) {
      steps.push({
        name: "runtime initialization test",
        status: "failed",
        detail: `probe produced no verdict (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-2).join(" ")}`,
      });
      return fail({ migration });
    }
    const initOk = report.ok || report.stage === "reload";
    steps.push({
      name: "runtime initialization test",
      status: initOk ? "passed" : "failed",
      detail: initOk
        ? `${report.commands.length} commands, ${report.tools.length} tools, ${report.handlers} handlers`
        : `${report.stage}: ${
            report.failure ??
            (report.health ?? [])
              .filter((c) => !c.ok)
              .map((c) => c.name)
              .join(", ")
          }`,
    });
    if (!initOk) return fail({ migration });
    steps.push({
      name: "hot-reload smoke test",
      status: report.ok ? "passed" : "failed",
      detail: report.ok ? "reloaded once; no duplicate registrations" : (report.failure ?? "failed"),
    });
    if (!report.ok) return fail({ migration });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  if (opts.mode !== "quick") {
    const tsc = join(dir, "node_modules", "typescript", "bin", "tsc");
    if (existsSync(join(dir, "tsconfig.json")) && existsSync(tsc)) {
      const r = await run(nodeBinary(), [tsc, "--noEmit", "-p", "tsconfig.json"], dir, 600_000);
      steps.push({
        name: "typecheck",
        status: r.code === 0 ? "passed" : "failed",
        ...(r.code === 0 ? {} : { detail: r.stdout.trim().split("\n").slice(0, 3).join(" | ") }),
      });
      if (r.code !== 0) return fail({ migration });
    } else {
      steps.push({ name: "typecheck", status: "skipped", detail: "candidate ships no tsconfig/typescript" });
    }
    const critical = CRITICAL_TESTS.filter((t) => existsSync(join(dir, t)));
    if (critical.length > 0) {
      const r = await run(nodeBinary(), ["--test", ...critical], dir, 600_000);
      steps.push({
        name: "critical unit tests",
        status: r.code === 0 ? "passed" : "failed",
        ...(r.code === 0
          ? {}
          : {
              detail: r.stdout
                .split("\n")
                .filter((l) => l.startsWith("not ok"))
                .join(" | "),
            }),
      });
      if (r.code !== 0) return fail({ migration });
    } else {
      steps.push({ name: "critical unit tests", status: "skipped", detail: "candidate ships none" });
    }
  }
  if (opts.mode === "full") {
    const r = await run("npm", ["test"], dir, 1_800_000);
    steps.push({ name: "full test suite", status: r.code === 0 ? "passed" : "failed" });
    if (r.code !== 0) return fail({ migration });
  }
  return { ok: true, steps, migration };
}
