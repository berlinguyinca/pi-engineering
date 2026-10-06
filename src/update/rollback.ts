/**
 * Manual rollback planning (spec §27, §36).
 *
 * The target must be a locally retained, installed version. If the state has
 * been migrated past what the target can read, the rollback restores the
 * pre-migration checkpoint of the update that migrated it. That restore is a
 * "migration" step of the same journaled transaction, so it is checkpointed,
 * journaled, crash-recoverable and undone if the rollback fails.
 */

import { existsSync } from "node:fs";
import { type StateMigration, readCheckpointManifest, restoreCheckpoint } from "../runtime/migrations/framework.ts";
import { readStateSchema, schemaCompatibility } from "../runtime/migrations/schema.ts";
import type { InstallLayout, InstalledVersion } from "./installLayout.ts";
import type { UpdateJournal, UpdateJournalRecord } from "./journal.ts";
import { type MigrationDecision, candidateStateSchema } from "./transaction.ts";

export interface RollbackPlan {
  target: InstalledVersion;
  migration: MigrationDecision;
}

/** Retained versions a rollback may select: installed, not the one running. */
export function rollbackTargets(layout: InstallLayout, runningRoot: string | null): InstalledVersion[] {
  return layout.listVersions().filter((v) => v.dir !== runningRoot);
}

/** Committed transactions from the journal's history log (newest last). */
export function committedTransactions(journal: UpdateJournal): UpdateJournalRecord[] {
  return journal.history().filter((r) => r.phase === "committed");
}

export async function planRollback(
  layout: InstallLayout,
  journal: UpdateJournal,
  runningRoot: string | null,
  stateDir: string | null,
  requested?: string,
): Promise<RollbackPlan> {
  const candidates = rollbackTargets(layout, runningRoot);
  let target: InstalledVersion | undefined;
  if (requested) {
    target = candidates.find((v) => v.version === requested || v.id === requested || v.commit?.startsWith(requested));
    if (!target) {
      const known = candidates.map((v) => v.version).join(", ") || "none";
      throw new Error(`version ${requested} is not retained locally (retained: ${known})`);
    }
  } else {
    const previous = layout.readPointer("previous");
    target = candidates.find((v) => v.dir === previous) ?? candidates.at(-1);
    if (!target) throw new Error("no previous known-good version is retained");
  }

  const support = candidateStateSchema(target.dir);
  if (!stateDir || !existsSync(stateDir)) return { target, migration: { plan: [], from: null, to: support.writes } };
  const schema = readStateSchema(stateDir);
  const compat = schemaCompatibility(schema, support);
  if (compat.kind === "compatible") return { target, migration: { plan: [], from: compat.schema, to: compat.schema } };
  if (compat.kind === "migrate") {
    throw new Error(`state schema ${schema} is older than ${target.version} reads; update forward instead`);
  }
  // The state is newer than the target reads: undo the migration that got it here.
  const restore = await findRestorableCheckpoint(journal, stateDir, support.maxReadable);
  if (!restore) {
    throw new Error(
      `state schema ${schema} is newer than ${target.version} reads (max ${support.maxReadable}) and no pre-migration checkpoint is retained`,
    );
  }
  const manifest = await readCheckpointManifest(restore.checkpoint);
  const step: StateMigration = {
    id: `restore-${restore.transaction}`,
    from: schema as number,
    to: restore.from,
    description: `restore the state checkpoint taken before ${restore.transaction}`,
    touches: (manifest?.entries ?? []).map((e) => e.path),
    apply: (dir) => restoreCheckpoint(restore.checkpoint, dir),
  };
  return { target, migration: { plan: [step], from: schema, to: restore.from } };
}

async function findRestorableCheckpoint(
  journal: UpdateJournal,
  stateDir: string,
  maxReadable: number,
): Promise<{ checkpoint: string; from: number; transaction: string } | null> {
  for (const record of committedTransactions(journal).reverse()) {
    const m = record.migration;
    if (!m?.checkpoint || m.stateDir !== stateDir || m.from > maxReadable) continue;
    const manifest = await readCheckpointManifest(m.checkpoint);
    if (manifest) return { checkpoint: m.checkpoint, from: m.from, transaction: record.transaction };
  }
  return null;
}
