/**
 * Crash-safe update journal (spec §29).
 *
 * Written BEFORE each mutation, so after a crash the journal always describes
 * at least as much as actually happened. Every write is atomic: temp file,
 * fsync, rename, fsync of the directory. A reader sees either the previous
 * record or the new one, never a torn file.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export const JOURNAL_PHASES = [
  "checking",
  "fetching",
  "staging",
  "validating",
  "waiting_safe_point",
  "quiescing",
  "snapshotting",
  "migrating",
  "activating",
  "loading",
  "restoring",
  "health_check",
  "committing",
  "committed",
  "rolling_back",
  "rolled_back",
  "failed",
] as const;

export type JournalPhase = (typeof JOURNAL_PHASES)[number];

const TERMINAL: ReadonlySet<JournalPhase> = new Set(["committed", "rolled_back", "failed"]);

/** Phases after which state or pointers may have changed. */
const MUTATING: ReadonlySet<JournalPhase> = new Set([
  "migrating",
  "activating",
  "loading",
  "restoring",
  "health_check",
  "committing",
  "rolling_back",
]);

export interface JournalMigration {
  from: number;
  to: number;
  stateDir: string;
  checkpoint: string | null;
}

export interface UpdateJournalRecord {
  transaction: string;
  kind: "update" | "rollback";
  channel?: string;
  fromVersion: string | null;
  fromCommit: string | null;
  toVersion: string | null;
  toCommit: string | null;
  phase: JournalPhase;
  /** Version directory running before the transaction (null: the package checkout). */
  previousRuntime: string | null;
  candidateRuntime: string | null;
  /** Pointer targets before the transaction, restored on rollback. */
  pointers: { current: string | null; previous: string | null };
  migration?: JournalMigration;
  startedAt: string;
  updatedAt: string;
  failure?: string;
  history: Array<{ phase: JournalPhase; at: string }>;
}

export function isTerminal(phase: JournalPhase): boolean {
  return TERMINAL.has(phase);
}

export function mayHaveMutated(phase: JournalPhase): boolean {
  return MUTATING.has(phase);
}

export class UpdateJournal {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** The last record; null when absent. A corrupt journal reads as `corrupt`. */
  read(): UpdateJournalRecord | null | "corrupt" {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return null;
    }
    try {
      const record = JSON.parse(raw) as UpdateJournalRecord;
      if (typeof record.transaction !== "string" || !JOURNAL_PHASES.includes(record.phase)) return "corrupt";
      return record;
    } catch {
      return "corrupt";
    }
  }

  /** An incomplete transaction, if the journal holds one. */
  incomplete(): UpdateJournalRecord | null {
    const record = this.read();
    if (!record || record === "corrupt") return null;
    return isTerminal(record.phase) ? null : record;
  }

  begin(
    record: Omit<UpdateJournalRecord, "phase" | "startedAt" | "updatedAt" | "history"> & { phase?: JournalPhase },
  ): UpdateJournalRecord {
    const now = new Date().toISOString();
    const phase = record.phase ?? "checking";
    const full: UpdateJournalRecord = {
      ...record,
      phase,
      startedAt: now,
      updatedAt: now,
      history: [{ phase, at: now }],
    };
    this.write(full);
    return full;
  }

  /** Record a phase (and optional fields) durably. */
  advance(
    record: UpdateJournalRecord,
    phase: JournalPhase,
    patch: Partial<Omit<UpdateJournalRecord, "phase" | "history">> = {},
  ): UpdateJournalRecord {
    const now = new Date().toISOString();
    const next: UpdateJournalRecord = {
      ...record,
      ...patch,
      phase,
      updatedAt: now,
      history: [...record.history, { phase, at: now }],
    };
    this.write(next);
    return next;
  }

  private write(record: UpdateJournalRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `.update-journal.${process.pid}.tmp`);
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    fsyncDir(dirname(this.file));
  }
}

/** Make a rename durable. Best effort on platforms that cannot fsync a directory. */
export function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the rename is still atomic.
  }
}
