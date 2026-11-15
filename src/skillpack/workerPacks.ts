import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadPolicy } from "../lifecycle/policy.ts";
import { assertPrivateDir, defaultFirewallDir } from "../omp/firewall.ts";
import { PACK_MANIFEST_FILE, type PackManifest, verifyPack } from "./verify.ts";

/**
 * Opt-in: version-pinned, digest-verified skill packs MAY reach worker sessions.
 * Both switches are required: this env var AND a per-role allowlist in
 * `.pi/engineering.yaml` (`workers.skillPacks: { <role>: [<pack id or path>] }`).
 * Default off: workers stay skill-less (the context firewall).
 */
export const WORKER_SKILLS_ENV = "PI_ENGINEERING_WORKER_SKILLS";

export function workerSkillsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env[WORKER_SKILLS_ENV]?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

export interface WorkerSkillPacksConfig {
  readonly byRole: Readonly<Record<string, readonly string[]>>;
  readonly issues: readonly string[];
}

/** Validate a raw `workers.skillPacks` value; malformed entries are reported and dropped. */
export function parseWorkerSkillPacks(raw: unknown): WorkerSkillPacksConfig {
  const issues: string[] = [];
  const byRole: Record<string, string[]> = {};
  if (raw === undefined || raw === null) return { byRole, issues };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { byRole, issues: ["workers.skillPacks must be a mapping of role to a list of packs"] };
  }
  for (const [role, value] of Object.entries(raw)) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
      issues.push(`workers.skillPacks.${role} must be a list of non-empty strings`);
      continue;
    }
    byRole[role] = [...new Set(value.map((v: string) => v.trim()))];
  }
  return { byRole, issues };
}

export async function loadWorkerSkillPacksConfig(cwd: string, env: NodeJS.ProcessEnv): Promise<WorkerSkillPacksConfig> {
  const { policy } = await loadPolicy({ cwd, env });
  const workers = (policy as unknown as Record<string, unknown>).workers;
  const raw =
    typeof workers === "object" && workers !== null ? (workers as Record<string, unknown>).skillPacks : undefined;
  return parseWorkerSkillPacks(raw);
}

export interface WorkerSkillPack {
  readonly ref: string;
  readonly name: string;
  readonly version: string;
  /** The verified private copy; never the repository's own directory. */
  readonly dir: string;
  readonly skillsDir: string;
}

export interface ResolvedWorkerSkills {
  readonly packs: readonly WorkerSkillPack[];
  /** Deterministic, bounded operator-visible lines for packs refused (fail closed) or malformed config. */
  readonly diagnostics: readonly string[];
}

export const NO_WORKER_SKILLS: ResolvedWorkerSkills = { packs: [], diagnostics: [] };

const SCRIPT_LIKE = /(^|\/)(scripts|bin)\/|\.(sh|bash|zsh|ts|tsx|js|mjs|cjs|py|rb|pl|ps1|bat|cmd)$/i;
const FORBIDDEN_PACKAGE_KEYS = ["scripts", "bin", "main", "module", "exports", "omp", "pi"] as const;

/** Packs carry skills only: nothing a loader could execute, nothing outside skills/ other than inert metadata. */
function contentProblems(dir: string, manifest: PackManifest): string[] {
  const problems: string[] = [];
  for (const path of Object.keys(manifest.files)) {
    const top = path.split("/")[0] ?? "";
    if (SCRIPT_LIKE.test(path)) problems.push(`script-like file: ${path}`);
    else if (top !== "skills" && !["package.json", "README.md", "LICENSE"].includes(path)) {
      problems.push(`file outside skills/: ${path}`);
    } else if ((lstatSync(join(dir, path)).mode & 0o111) !== 0) problems.push(`executable file: ${path}`);
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    for (const key of FORBIDDEN_PACKAGE_KEYS) if (key in pkg) problems.push(`package.json declares ${key}`);
  } catch {
    // verifyPack already reports an unreadable package.json
  }
  if (!Object.keys(manifest.files).some((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p))) {
    problems.push("no skills/<name>/SKILL.md");
  }
  return problems;
}

function readManifest(dir: string): PackManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, PACK_MANIFEST_FILE), "utf8")) as PackManifest;
  } catch {
    return undefined;
  }
}

/** Whole-pack problems: digest/lock/symlink agreement plus the no-script rule. Empty means loadable. */
export function packProblems(dir: string): string[] {
  const verified = verifyPack(dir);
  if (!verified.ok) return [...verified.problems];
  const manifest = readManifest(dir);
  return manifest ? contentProblems(dir, manifest) : ["manifest unreadable"];
}

/** Pack id (a name) resolves under the repository's skill-packs/; anything with a path separator is a path. */
function locatePack(ref: string, cwd: string): string | undefined {
  if (isAbsolute(ref) || ref.includes("/") || ref.includes("\\")) return resolve(cwd, ref);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref) ? join(cwd, "skill-packs", ref) : undefined;
}

export function workerSkillCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultFirewallDir(env)), "worker-skill-packs");
}

/**
 * Content-addressed private copy of a pack that was verified in place, then verified again as copied:
 * the bytes a worker loads are the bytes that passed. No network, no script run, no symlink followed.
 */
function stage(src: string, cacheDir: string): { dir: string } | { problems: string[] } {
  const manifestBytes = readFileSync(join(src, PACK_MANIFEST_FILE));
  const target = join(cacheDir, createHash("sha256").update(manifestBytes).digest("hex").slice(0, 32));
  if (existsSync(target) && packProblems(target).length === 0) return { dir: target };
  assertPrivateDir(cacheDir);
  const tmp = join(cacheDir, `.stage.${process.pid}.${randomBytes(6).toString("hex")}`);
  try {
    cpSync(src, tmp, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    const problems = packProblems(tmp);
    if (problems.length > 0) return { problems: problems.map((p) => `copy: ${p}`) };
    rmSync(target, { recursive: true, force: true });
    renameSync(tmp, target);
    return { dir: target };
  } catch (error) {
    return { problems: [`stage failed: ${error instanceof Error ? error.message : String(error)}`] };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const boundedLine = (s: string): string => (s.length > 300 ? `${s.slice(0, 297)}...` : s);

export interface ResolveWorkerSkillsOptions {
  readonly role: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam only; defaults to the private per-user state directory. */
  readonly cacheDir?: string;
}

/**
 * The verified packs the allowlist grants `role`. Disabled (default) returns immediately without reading
 * any configuration. A pack that fails verification is dropped with a diagnostic; the worker runs without it.
 */
export async function resolveWorkerSkills(opts: ResolveWorkerSkillsOptions): Promise<ResolvedWorkerSkills> {
  const env = opts.env ?? process.env;
  if (!workerSkillsEnabled(env)) return NO_WORKER_SKILLS;
  let config: WorkerSkillPacksConfig;
  try {
    config = await loadWorkerSkillPacksConfig(opts.cwd, env);
  } catch (error) {
    return {
      packs: [],
      diagnostics: [boundedLine(`worker skill packs disabled: config unreadable: ${(error as Error).message}`)],
    };
  }
  const diagnostics = config.issues.map((i) => boundedLine(`worker skill packs config: ${i}`));
  const packs: WorkerSkillPack[] = [];
  const cacheDir = opts.cacheDir ?? workerSkillCacheDir(env);
  for (const ref of config.byRole[opts.role] ?? []) {
    const refuse = (why: string[]) =>
      diagnostics.push(
        boundedLine(
          `worker skill pack refused (${opts.role}): ${ref}: ${why.slice(0, 3).join("; ")}${why.length > 3 ? `; +${why.length - 3} more` : ""}`,
        ),
      );
    const src = locatePack(ref, opts.cwd);
    if (!src || !existsSync(src)) {
      refuse(["pack not found"]);
      continue;
    }
    const problems = packProblems(src);
    if (problems.length > 0) {
      refuse(problems);
      continue;
    }
    const staged = stage(src, cacheDir);
    if ("problems" in staged) {
      refuse(staged.problems);
      continue;
    }
    const manifest = readManifest(staged.dir);
    packs.push({
      ref,
      name: manifest?.name ?? ref,
      version: manifest?.version ?? "",
      dir: staged.dir,
      skillsDir: join(staged.dir, "skills"),
    });
  }
  return { packs, diagnostics };
}
