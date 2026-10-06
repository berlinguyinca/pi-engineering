/**
 * Non-destructive migration of a legacy single-writer store
 * (`.pi-eng/orchestration.jsonl`) into a worktree runtime namespace.
 *
 *   1. detect the legacy file,
 *   2. read every valid complete event (a torn tail is ignored, never edited),
 *   3. publish them atomically as `events/legacy-<hash>.jsonl`,
 *   4. leave the original untouched,
 *   5. record completion (source size + mtime) in `migrations.json`.
 *
 * Idempotent and safe to race: the import is a pure function of the source
 * snapshot, both outputs are published by rename, and readers de-duplicate by
 * event id. If an older Pi Engineering keeps appending to the legacy file, the
 * changed size/mtime triggers a fresh import on the next open.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonlFrom } from "./jsonlFiles.ts";
import { emitRuntimeEvent } from "./runtimeEvents.ts";

export const MIGRATIONS_FILE = "migrations.json";

export interface LegacyMigrationRecord {
  source: string;
  target: string;
  sourceSize: number;
  sourceMtimeMs: number;
  events: number;
  skippedLines: number;
  completedAt: string;
}

export type LegacyMigrationResult =
  | { status: "absent" }
  | { status: "current"; record: LegacyMigrationRecord }
  | { status: "migrated"; record: LegacyMigrationRecord };

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readMigrationRecords(runtimeDir: string): Record<string, LegacyMigrationRecord> {
  try {
    const value: unknown = JSON.parse(readFileSync(join(runtimeDir, MIGRATIONS_FILE), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, LegacyMigrationRecord>)
      : {};
  } catch {
    return {};
  }
}

export function legacyTargetName(legacyFile: string): string {
  return `legacy-${createHash("sha256").update(legacyFile).digest("hex").slice(0, 16)}.jsonl`;
}

export function migrateLegacyStore(options: {
  legacyFile: string;
  runtimeDir: string;
  eventsDir: string;
  sessionId?: string;
  worktreeId?: string;
}): LegacyMigrationResult {
  let stat: { size: number; mtimeMs: number };
  try {
    const s = statSync(options.legacyFile);
    if (!s.isFile()) return { status: "absent" };
    stat = { size: s.size, mtimeMs: Math.trunc(s.mtimeMs) };
  } catch {
    return { status: "absent" };
  }
  const records = readMigrationRecords(options.runtimeDir);
  const prior = records[options.legacyFile];
  if (prior && prior.sourceSize === stat.size && prior.sourceMtimeMs === stat.mtimeMs) {
    return { status: "current", record: prior };
  }
  const read = readJsonlFrom(options.legacyFile, 0);
  mkdirSync(options.eventsDir, { recursive: true });
  const targetName = legacyTargetName(options.legacyFile);
  const target = join(options.eventsDir, targetName);
  atomicWrite(target, read.events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  const record: LegacyMigrationRecord = {
    source: options.legacyFile,
    target,
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs,
    events: read.events.length,
    skippedLines: read.corruptLines + (read.tornTailBytes > 0 ? 1 : 0),
    completedAt: new Date().toISOString(),
  };
  // Re-read just before publishing so a concurrent migrator's other sources survive.
  const latest = readMigrationRecords(options.runtimeDir);
  latest[options.legacyFile] = record;
  atomicWrite(join(options.runtimeDir, MIGRATIONS_FILE), `${JSON.stringify(latest, null, 2)}\n`);
  emitRuntimeEvent("migration.completed", {
    session_id: options.sessionId,
    worktree_id: options.worktreeId,
    source: options.legacyFile,
    target,
    events: record.events,
    skipped_lines: record.skippedLines,
  });
  return { status: "migrated", record };
}
