/**
 * Deterministic evidence producers (spec §8, §32.5).
 *
 * A check is a command the roadmap engine runs to (re)generate deterministic
 * evidence. Each EvidenceType that can be produced by a command has an entry
 * here. Model-dependent types (dogfood, fresh_review) have no command; they are
 * resolved from the committed manual evidence index.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EvidenceType, MilestoneDef } from "./types.ts";

const exec = promisify(execFile);

export interface Check {
  type: EvidenceType;
  /** argv run in the repo root. */
  command: string[];
  /** Extra paths the check itself exercises (invalidation scope), besides milestone scope. */
  paths: string[];
}

/**
 * The check registry. Deterministic evidence types map to commands run in the
 * repository root. The command output/exit code is the machine proof.
 */
export const CHECKS: Record<string, Check> = {
  typecheck: {
    type: "typecheck",
    command: ["npm", "run", "--silent", "typecheck"],
    paths: ["src", "extensions", "tsconfig.json"],
  },
  lint: {
    type: "lint",
    command: ["npm", "run", "--silent", "lint"],
    paths: ["src", "extensions", "test", "scripts", "biome.json"],
  },
  unit: { type: "unit", command: ["npm", "run", "--silent", "test:unit"], paths: ["src", "test"] },
  integration: { type: "integration", command: ["npm", "run", "--silent", "test:integration"], paths: ["src", "test"] },
  e2e: { type: "e2e", command: ["npm", "run", "--silent", "test:e2e"], paths: ["src", "test"] },
  package_load: {
    type: "package_load",
    command: ["node", "scripts/smoke-load.ts"],
    paths: ["extensions", "src/index.ts"],
  },
  roadmap_test: {
    type: "roadmap_test",
    command: ["npm", "run", "--silent", "test:roadmap"],
    paths: ["src/roadmap", "docs/roadmap", "test/unit/roadmap*", "test/integration/roadmap*"],
  },
};

/** Types that are produced deterministically by a command. */
export const GENERATED_TYPES: EvidenceType[] = [
  "typecheck",
  "lint",
  "unit",
  "integration",
  "e2e",
  "package_load",
  "roadmap_test",
];

/** Types that must come from recorded/manual evidence (model-dependent). */
export const MANUAL_TYPES: EvidenceType[] = ["dogfood", "fresh_review"];

export interface RunResult {
  status: "pass" | "fail" | "error";
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run a check command in the repo root, returning exit code + truncated output. */
export async function runCheck(check: Check, cwd: string, timeoutMs = 600_000): Promise<RunResult> {
  const [cmd, ...args] = check.command;
  if (!cmd) return { status: "error", exitCode: -1, stdout: "", stderr: "empty command" };
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return { status: "pass", exitCode: 0, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };
    return {
      status: "fail",
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: ((e.stdout as string) ?? "").slice(0, 2000),
      stderr: ((e.stderr as string) ?? e.message ?? String(e)).slice(0, 2000),
    };
  }
}

/** The set of evidence types a set of milestones requires. */
export function requiredTypes(milestones: MilestoneDef[]): EvidenceType[] {
  const set = new Set<EvidenceType>();
  for (const m of milestones) {
    for (const t of m.verification.requires) set.add(t);
    for (const c of m.acceptance) for (const r of c.evidence.required) set.add(r.type);
  }
  return [...set];
}

/** The check for a generated evidence type, if one exists. */
export function checkFor(type: EvidenceType): Check | undefined {
  return CHECKS[type];
}
