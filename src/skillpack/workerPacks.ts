import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
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

export interface PackGrant {
  readonly id: string;
  /** sha256 (hex) of the pack's `pack.manifest.json` bytes, pinned by the operator. */
  readonly manifestSha256: string;
}

export interface WorkerSkillPacksConfig {
  readonly byRole: Readonly<Record<string, readonly PackGrant[]>>;
  readonly issues: readonly string[];
}

const PACK_ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Validate a raw `workers.skillPacks` value; malformed entries are reported and dropped. */
export function parseWorkerSkillPacks(raw: unknown): WorkerSkillPacksConfig {
  const issues: string[] = [];
  const byRole: Record<string, PackGrant[]> = {};
  if (raw === undefined || raw === null) return { byRole, issues };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { byRole, issues: ["workers.skillPacks must be a mapping of role to a list of {id, manifestSha256}"] };
  }
  for (const [role, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) {
      issues.push(`workers.skillPacks.${role} must be a list of {id, manifestSha256}`);
      continue;
    }
    const grants = new Map<string, PackGrant>();
    for (const entry of value) {
      const e = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
      const id = typeof e.id === "string" ? e.id.trim() : "";
      const sha = typeof e.manifestSha256 === "string" ? e.manifestSha256.trim().toLowerCase() : "";
      if (!PACK_ID.test(id) || !SHA256_HEX.test(sha)) {
        issues.push(`workers.skillPacks.${role}: entry needs id matching ${PACK_ID} and a 64-hex manifestSha256`);
        continue;
      }
      grants.set(id, { id, manifestSha256: sha });
    }
    byRole[role] = [...grants.values()];
  }
  return { byRole, issues };
}

/** The operator's agent directory: the only place the allowlist is read from and packs are resolved in. */
export function operatorAgentDir(env: NodeJS.ProcessEnv): string {
  return env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME ?? "~", ".pi", "agent");
}

function workersSkillPacksOf(file: string): { present: boolean; raw?: unknown; error?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { present: false }
      : { present: false, error: String(error) };
  }
  try {
    const doc: unknown = parseYaml(text);
    const workers = typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>).workers : undefined;
    const raw =
      typeof workers === "object" && workers !== null ? (workers as Record<string, unknown>).skillPacks : undefined;
    return raw === undefined ? { present: false } : { present: true, raw };
  } catch (error) {
    return { present: false, error: `unparseable: ${(error as Error).message}` };
  }
}

/**
 * The allowlist comes from the operator's `<agentDir>/engineering.yaml` ONLY. A repository is untrusted input: a
 * `workers.skillPacks` in `<cwd>/.pi/engineering.yaml` is ignored and reported.
 */
export function loadWorkerSkillPacksConfig(
  cwd: string,
  agentDir: string,
): WorkerSkillPacksConfig & { readonly repoAttempt: boolean } {
  const operator = workersSkillPacksOf(join(agentDir, "engineering.yaml"));
  const repo = workersSkillPacksOf(join(cwd, ".pi", "engineering.yaml"));
  const parsed = parseWorkerSkillPacks(operator.raw);
  const issues = operator.error ? [...parsed.issues, `operator engineering.yaml: ${operator.error}`] : parsed.issues;
  return { ...parsed, issues, repoAttempt: repo.present };
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
    else if (top === "skills" && !/^skills\/[^/]+\/.+/.test(path))
      problems.push(`file directly under skills/: ${path}`);
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
  problems.push(...emptyDirProblems(dir));
  if (!Object.keys(manifest.files).some((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p))) {
    problems.push("no skills/<name>/SKILL.md");
  }
  return problems;
}

function emptyDirProblems(root: string, dir = root): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0 && dir !== root) out.push(`empty directory: ${dir.slice(root.length + 1)}`);
  for (const e of entries) if (e.isDirectory()) out.push(...emptyDirProblems(root, join(dir, e.name)));
  return out;
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

export function workerSkillCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultFirewallDir(env)), "worker-skill-packs");
}

/** sha256 (hex) of the manifest bytes in `dir`, or undefined when unreadable. */
function manifestSha(dir: string): string | undefined {
  try {
    return createHash("sha256")
      .update(readFileSync(join(dir, PACK_MANIFEST_FILE)))
      .digest("hex");
  } catch {
    return undefined;
  }
}

function chmodTree(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) chmodTree(full);
    else if (entry.isFile()) chmodSync(full, 0o600);
  }
}

/**
 * Content-addressed private copy (mode 0700/0600) of a pack that was verified in place, then verified again as
 * copied: the bytes a worker loads are the bytes that passed. An existing copy is trusted only if it verifies now;
 * a bad one is moved aside, never edited. No network, no script run, no symlink followed.
 */
export function stage(src: string, cacheDir: string, pin: string): { dir: string } | { problems: string[] } {
  assertPrivateDir(cacheDir);
  const copied = manifestSha(src);
  if (copied !== pin) return { problems: ["manifest sha256 does not match the pinned digest"] };
  const target = join(cacheDir, pin.slice(0, 32));
  const stagedProblems = (dir: string): string[] =>
    manifestSha(dir) === pin ? packProblems(dir) : ["manifest sha256 does not match the pinned digest"];
  if (existsSync(target) && stagedProblems(target).length === 0) return { dir: target };
  const tmp = join(cacheDir, `.stage.${process.pid}.${randomBytes(6).toString("hex")}`);
  try {
    cpSync(src, tmp, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    chmodTree(tmp);
    const problems = stagedProblems(tmp);
    if (problems.length > 0) return { problems: problems.map((p) => `copy: ${p}`) };
    if (existsSync(target)) renameSync(target, join(cacheDir, `.bad.${randomBytes(6).toString("hex")}`));
    try {
      renameSync(tmp, target);
    } catch {
      // Another process staged the same content first; use its copy only if it verifies.
    }
    const final = stagedProblems(target);
    return final.length === 0 ? { dir: target } : { problems: final.map((p) => `staged copy: ${p}`) };
  } catch (error) {
    return { problems: [`stage failed: ${error instanceof Error ? error.message : String(error)}`] };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const boundedLine = (s: string): string => (s.length > 300 ? `${s.slice(0, 297)}...` : s);

export interface ResolveWorkerSkillsOptions {
  readonly role: string;
  /** The worker's working directory. Used only to detect (and warn about) a repo-supplied allowlist. */
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The operator's agent dir; defaults to PI_CODING_AGENT_DIR or ~/.pi/agent. */
  readonly agentDir?: string;
  /** Test seam only; defaults to the private per-user state directory. */
  readonly cacheDir?: string;
}

/**
 * The verified packs the OPERATOR's allowlist grants `role`. Disabled (default) returns immediately without reading
 * any configuration. Packs live under `<agentDir>/skill-packs/<id>` and must match the operator-pinned manifest
 * sha256. A pack that fails any check is dropped with a diagnostic; the worker runs without it.
 */
export async function resolveWorkerSkills(opts: ResolveWorkerSkillsOptions): Promise<ResolvedWorkerSkills> {
  const env = opts.env ?? process.env;
  if (!workerSkillsEnabled(env)) return NO_WORKER_SKILLS;
  const agentDir = opts.agentDir ?? operatorAgentDir(env);
  const config = loadWorkerSkillPacksConfig(opts.cwd, agentDir);
  const diagnostics = config.issues.map((i) => boundedLine(`worker skill packs config: ${i}`));
  if (config.repoAttempt) {
    diagnostics.push(
      "worker skill packs: ignored workers.skillPacks in the repository's .pi/engineering.yaml (operator config only)",
    );
  }
  const packs: WorkerSkillPack[] = [];
  const cacheDir = opts.cacheDir ?? workerSkillCacheDir(env);
  for (const grant of config.byRole[opts.role] ?? []) {
    const ref = grant.id;
    const refuse = (why: string[]) =>
      diagnostics.push(
        boundedLine(
          `worker skill pack refused (${opts.role}): ${ref}: ${why.slice(0, 3).join("; ")}${why.length > 3 ? `; +${why.length - 3} more` : ""}`,
        ),
      );
    const src = join(agentDir, "skill-packs", ref);
    if (!existsSync(src)) {
      refuse(["pack not found"]);
      continue;
    }
    let pinned: string;
    try {
      pinned = createHash("sha256")
        .update(readFileSync(join(src, PACK_MANIFEST_FILE)))
        .digest("hex");
    } catch {
      refuse(["manifest unreadable"]);
      continue;
    }
    if (pinned !== grant.manifestSha256) {
      refuse(["manifest sha256 does not match the pinned digest"]);
      continue;
    }
    const problems = packProblems(src);
    if (problems.length > 0) {
      refuse(problems);
      continue;
    }
    const staged = stage(src, cacheDir, grant.manifestSha256);
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
