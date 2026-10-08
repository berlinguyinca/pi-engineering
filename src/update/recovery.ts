/**
 * Startup crash recovery (spec §30, §53).
 *
 * Runs BEFORE normal Pi Engineering initialization. The policy: only a
 * COMMITTED transaction survives a crash. Anything else is undone to the state
 * the journal recorded before the transaction began:
 *
 *   - interrupted before anything mutated (checking … snapshotting):
 *     nothing to undo; the transaction is marked failed and its staging
 *     directory removed;
 *   - interrupted while mutating (migrating … committing, rolling_back):
 *     the state checkpoint is restored, both runtime pointers are put back,
 *     and the transaction is marked rolled_back.
 *
 * The Host then starts from `current` with its normal health check and its
 * fallback chain (previous, then the package checkout), so even a pointer the
 * journal could not vouch for cannot brick Pi Engineering.
 */

import { existsSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { RuntimeTelemetry } from "../runtime/host/telemetry.ts";
import { hasCheckpoint, restoreCheckpoint } from "../runtime/migrations/framework.ts";
import { type InstallLayout, isInside } from "./installLayout.ts";
import { type UpdateJournal, type UpdateJournalRecord, mayHaveMutated } from "./journal.ts";

export type RecoveryAction = "none" | "marked_failed" | "rolled_back" | "quarantined_corrupt_journal";

export interface RecoveryOutcome {
  action: RecoveryAction;
  record?: UpdateJournalRecord;
  detail: string;
}

export async function recoverInterruptedTransaction(
  layout: InstallLayout,
  journal: UpdateJournal,
  telemetry: RuntimeTelemetry,
): Promise<RecoveryOutcome> {
  const raw = journal.read();
  if (raw === "corrupt") {
    // An atomic writer cannot produce this, so it is outside damage. Keep it
    // for inspection and let the Host's health/fallback chain pick a runtime.
    const aside = `${journal.file}.corrupt-${Date.now()}`;
    try {
      renameSync(journal.file, aside);
    } catch {
      // Leave it; recovery never blocks startup.
    }
    telemetry.emit("runtime.crash_recovery.completed", { failure_reason: "corrupt journal", quarantined: aside });
    return { action: "quarantined_corrupt_journal", detail: `corrupt journal moved to ${aside}` };
  }
  const record = journal.incomplete();
  if (!record) return { action: "none", detail: "no interrupted transaction" };

  const fields = {
    transaction_id: record.transaction,
    from_version: record.fromVersion ?? undefined,
    to_version: record.toVersion ?? undefined,
    from_commit: record.fromCommit,
    to_commit: record.toCommit,
    interrupted_phase: record.phase,
  };
  telemetry.emit("runtime.crash_recovery.started", fields);

  if (!mayHaveMutated(record.phase)) {
    if (record.candidateRuntime && isInside(layout.stagingDir, record.candidateRuntime)) {
      await rm(record.candidateRuntime, { recursive: true, force: true }).catch(() => {});
    }
    const next = journal.advance(record, "failed", {
      failure: `interrupted during ${record.phase} (before activation); current runtime untouched`,
    });
    telemetry.emit("runtime.crash_recovery.completed", { ...fields, action: "marked_failed" });
    return { action: "marked_failed", record: next, detail: next.failure ?? "" };
  }

  let rolling = record.phase === "rolling_back" ? record : journal.advance(record, "rolling_back");
  const notes: string[] = [];
  const m = rolling.migration;
  if (m?.checkpoint && hasCheckpoint(m.checkpoint) && existsSync(m.stateDir)) {
    await restoreCheckpoint(m.checkpoint, m.stateDir);
    notes.push(`state restored from checkpoint (schema ${m.from})`);
  }
  await layout.restorePointers(validPointers(layout, rolling.pointers));
  notes.push(`runtime pointers restored (current → ${rolling.pointers.current ?? "package checkout"})`);
  rolling = journal.advance(rolling, "rolled_back", {
    failure: `interrupted during ${record.phase}; ${notes.join("; ")}`,
  });
  telemetry.emit("runtime.crash_recovery.completed", {
    ...fields,
    action: "rolled_back",
    rollback_version: rolling.fromVersion ?? undefined,
  });
  return { action: "rolled_back", record: rolling, detail: rolling.failure ?? "" };
}

/** Pointers recorded in the journal, minus any that no longer name an installed version. */
function validPointers(
  layout: InstallLayout,
  pointers: { current: string | null; previous: string | null },
): { current: string | null; previous: string | null } {
  const ok = (p: string | null) => (p && layout.isVersionDir(p) && existsSync(p) ? p : null);
  return { current: ok(pointers.current), previous: ok(pointers.previous) };
}
