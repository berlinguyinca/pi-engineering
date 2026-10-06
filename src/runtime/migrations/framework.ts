/**
 * State migration framework (spec §26, §27).
 *
 *   inspect schema → plan path → dry-run on a copy → checkpoint → migrate
 *
 * Migrations are deterministic functions of a state directory. Each one
 * declares the paths it touches. Those paths, plus the schema marker, are
 * exactly what the checkpoint copies, so a rollback restores the pre-migration
 * state byte for byte without copying worktrees or logs it never touches.
 *
 * Applying is idempotent across crashes. The schema marker is advanced after
 * each step, so a re-run resumes at the first step not yet recorded. A crash
 * in the middle of a step is handled by restoring the checkpoint (recovery).
 */

import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { STATE_SCHEMA_FILE, readStateSchema, writeStateSchema } from "./schema.ts";

export interface StateMigration {
  /** Stable identifier, e.g. "v7-v8". */
  id: string;
  from: number;
  to: number;
  description: string;
  /** Paths (relative to the state dir) this migration may create, change or delete. */
  touches: string[];
  apply(stateDir: string): Promise<void>;
}

export class MigrationError extends Error {
  readonly migration: string | undefined;
  constructor(message: string, migration?: string) {
    super(message);
    this.name = "MigrationError";
    this.migration = migration;
  }
}

/** The chain of single-step migrations from `from` to `to`. Throws when there is none. */
export function planMigrations(registry: readonly StateMigration[], from: number, to: number): StateMigration[] {
  if (from === to) return [];
  if (from > to) throw new MigrationError(`no downgrade migrations: state ${from} → ${to}`);
  const plan: StateMigration[] = [];
  let at = from;
  while (at < to) {
    const steps = registry.filter((m) => m.from === at && m.to > at && m.to <= to);
    if (steps.length !== 1) {
      throw new MigrationError(
        steps.length === 0 ? `no migration from schema ${at} toward ${to}` : `ambiguous migrations from schema ${at}`,
      );
    }
    const step = steps[0] as StateMigration;
    plan.push(step);
    at = step.to;
  }
  return plan;
}

function checkTouches(plan: readonly StateMigration[]): string[] {
  const out = new Set<string>();
  for (const m of plan) {
    for (const t of m.touches) {
      const n = normalize(t);
      if (isAbsolute(n) || n === ".." || n.startsWith(`..${sep}`) || n === "." || n === "") {
        throw new MigrationError(`migration ${m.id} declares an unsafe path: ${t}`, m.id);
      }
      out.add(n);
    }
  }
  out.add(STATE_SCHEMA_FILE);
  return [...out];
}

/** Run the plan against a throwaway copy of the touched paths. The real state is not modified. */
export async function dryRunMigrations(
  stateDir: string,
  plan: readonly StateMigration[],
): Promise<{ ok: true } | { ok: false; error: string; migration?: string }> {
  if (plan.length === 0) return { ok: true };
  const scratch = await mkdtemp(join(tmpdir(), "pi-eng-migration-dryrun-"));
  try {
    for (const rel of checkTouches(plan)) {
      const src = join(stateDir, rel);
      if (existsSync(src)) await cp(src, join(scratch, rel), { recursive: true });
    }
    await applyMigrations(scratch, plan);
    const after = readStateSchema(scratch);
    const want = (plan.at(-1) as StateMigration).to;
    if (after !== want) return { ok: false, error: `dry-run ended at schema ${after}, expected ${want}` };
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof MigrationError && error.migration ? { migration: error.migration } : {}),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const MANIFEST = "checkpoint-manifest.json";

/** Copy everything the plan may touch, recording which paths existed. */
export async function createCheckpoint(
  stateDir: string,
  plan: readonly StateMigration[],
  checkpointDir: string,
): Promise<void> {
  await mkdir(join(checkpointDir, "state"), { recursive: true });
  const entries: Array<{ path: string; existed: boolean }> = [];
  for (const rel of checkTouches(plan)) {
    const src = join(stateDir, rel);
    const existed = existsSync(src);
    if (existed) await cp(src, join(checkpointDir, "state", rel), { recursive: true });
    entries.push({ path: rel, existed });
  }
  await writeFile(
    join(checkpointDir, MANIFEST),
    `${JSON.stringify({ stateDir, createdAt: new Date().toISOString(), entries }, null, 2)}\n`,
  );
}

/** Put the checkpointed paths back exactly; paths that did not exist are removed. */
export async function restoreCheckpoint(checkpointDir: string, stateDir: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(checkpointDir, MANIFEST), "utf8")) as {
    entries: Array<{ path: string; existed: boolean }>;
  };
  for (const { path, existed } of manifest.entries) {
    const n = normalize(path);
    if (isAbsolute(n) || n.startsWith("..")) throw new MigrationError(`corrupt checkpoint path ${path}`);
    const target = join(stateDir, n);
    await rm(target, { recursive: true, force: true });
    if (existed) await cp(join(checkpointDir, "state", n), target, { recursive: true });
  }
}

export interface CheckpointManifest {
  stateDir: string;
  createdAt: string;
  entries: Array<{ path: string; existed: boolean }>;
}

export async function readCheckpointManifest(checkpointDir: string): Promise<CheckpointManifest | null> {
  try {
    return JSON.parse(await readFile(join(checkpointDir, MANIFEST), "utf8")) as CheckpointManifest;
  } catch {
    return null;
  }
}

export function hasCheckpoint(checkpointDir: string): boolean {
  return existsSync(join(checkpointDir, MANIFEST));
}

/** Apply the plan in order, advancing the schema marker after each step; skips steps already recorded. */
export async function applyMigrations(
  stateDir: string,
  plan: readonly StateMigration[],
  onStep?: (m: StateMigration) => void | Promise<void>,
): Promise<void> {
  for (const m of plan) {
    const at = readStateSchema(stateDir);
    // Already applied? Forward steps are done once the marker reaches `to`; a
    // backward step (a rollback restoring a checkpoint) once it is down to `to`.
    const done = m.to >= m.from ? at !== null && at >= m.to : at !== null && at <= m.to;
    if (done) continue;
    if (at !== m.from) throw new MigrationError(`migration ${m.id} expects schema ${m.from}, found ${at}`, m.id);
    await onStep?.(m);
    try {
      await m.apply(stateDir);
    } catch (error) {
      throw new MigrationError(
        `migration ${m.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        m.id,
      );
    }
    writeStateSchema(stateDir, m.to);
  }
}
