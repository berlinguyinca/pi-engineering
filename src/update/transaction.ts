/**
 * One journaled runtime activation: migrate state if required, switch the
 * current pointer, hand over, health-check, commit, or roll ALL of it back
 * (spec §11, §26-§27, §29, §34-§35).
 *
 * The caller holds the runtime mutation lock. Every step writes the journal
 * BEFORE it mutates anything, so startup recovery can always tell how far a
 * crashed transaction got (src/update/recovery.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HandoverPhase, HandoverResult, HandoverTask } from "../runtime/host/host.ts";
import type { RuntimeTelemetry } from "../runtime/host/telemetry.ts";
import {
  type StateMigration,
  applyMigrations,
  createCheckpoint,
  dryRunMigrations,
  hasCheckpoint,
  planMigrations,
  restoreCheckpoint,
} from "../runtime/migrations/framework.ts";
import {
  BASELINE_STATE_SCHEMA,
  type StateSchemaSupport,
  isStateSchemaSupport,
  readStateSchema,
  schemaCompatibility,
} from "../runtime/migrations/schema.ts";
import type { InstallLayout } from "./installLayout.ts";
import type { JournalPhase, UpdateJournal, UpdateJournalRecord } from "./journal.ts";

/** What the transaction needs from the Host extension. */
export interface ActivationHost {
  readonly layout: InstallLayout;
  readonly telemetry: RuntimeTelemetry;
  activateInstalled(
    dir: string,
    kind: "update" | "rollback",
    hooks: {
      beforeLoad?(): Promise<void>;
      onRollback?(reason: string): Promise<void>;
      onCommit?(): Promise<void>;
      onPhase?(phase: HandoverPhase): void | Promise<void>;
    },
    fields: Record<string, unknown>,
  ): Promise<HandoverTask>;
}

/** A candidate's declared state schema support (package.json `piEngineering.stateSchema`). */
export function candidateStateSchema(dir: string): StateSchemaSupport {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      piEngineering?: { stateSchema?: unknown };
    };
    const declared = pkg.piEngineering?.stateSchema;
    if (isStateSchemaSupport(declared)) return declared;
  } catch {
    // Fall through: an older runtime that predates schema versioning.
  }
  return { minReadable: BASELINE_STATE_SCHEMA, maxReadable: BASELINE_STATE_SCHEMA, writes: BASELINE_STATE_SCHEMA };
}

/** Load the migrations a candidate ships (its `piEngineering.migrations` module). */
export async function candidateMigrations(dir: string): Promise<readonly StateMigration[]> {
  let rel = "src/runtime/migrations/index.ts";
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      piEngineering?: { migrations?: unknown };
    };
    const declared = pkg.piEngineering?.migrations;
    if (typeof declared === "string" && /^[A-Za-z0-9_./-]+$/.test(declared) && !declared.includes("..")) {
      rel = declared;
    }
  } catch {
    // Default path.
  }
  const file = join(dir, rel);
  if (!existsSync(file)) return [];
  const url = pathToFileURL(file);
  url.searchParams.set("migrations", String(Date.now()));
  const mod = (await import(url.href)) as { migrations?: readonly StateMigration[] };
  return Array.isArray(mod.migrations) ? mod.migrations : [];
}

export interface MigrationDecision {
  plan: StateMigration[];
  from: number | null;
  to: number;
}

/**
 * What the candidate needs from the state at `stateDir`, decided from its
 * declared schema support alone: no candidate code is loaded. Throws when the
 * candidate cannot run on that state.
 */
export function assessMigration(
  candidateDir: string,
  stateDir: string | null,
): { needed: false; from: number | null; to: number } | { needed: true; from: number; to: number } {
  const support = candidateStateSchema(candidateDir);
  if (!stateDir || !existsSync(stateDir)) return { needed: false, from: null, to: support.writes };
  const compat = schemaCompatibility(readStateSchema(stateDir), support);
  if (compat.kind === "compatible") return { needed: false, from: compat.schema, to: compat.schema };
  if (compat.kind === "incompatible") throw new Error(`state schema incompatible: ${compat.reason}`);
  return { needed: true, from: compat.from, to: compat.to };
}

/**
 * Decide (and, unless `dryRun` is false, dry-run) what the candidate needs
 * from the state at `stateDir`. Throws when the candidate cannot run on that
 * state. Nothing is modified.
 *
 * This LOADS the candidate's migrations module. Update validation therefore
 * calls it with the dry-run only inside the isolated probe process
 * (src/update/probe.ts); the Pi process calls it, without the dry-run, only
 * after the probe passed.
 */
export async function prepareMigration(
  candidateDir: string,
  stateDir: string | null,
  opts: { dryRun?: boolean } = {},
): Promise<MigrationDecision> {
  const assessed = assessMigration(candidateDir, stateDir);
  if (!assessed.needed || !stateDir) return { plan: [], from: assessed.from, to: assessed.to };
  const plan = planMigrations(await candidateMigrations(candidateDir), assessed.from, assessed.to);
  if (opts.dryRun !== false) {
    const dry = await dryRunMigrations(stateDir, plan);
    if (!dry.ok) throw new Error(`migration dry-run failed: ${dry.error}`);
  }
  return { plan, from: assessed.from, to: assessed.to };
}

const PHASE_TO_JOURNAL: Partial<Record<HandoverPhase, JournalPhase>> = {
  waiting_safe_point: "waiting_safe_point",
  quiescing: "quiescing",
  snapshotting: "snapshotting",
  loading: "loading",
  restoring: "restoring",
  health_check: "health_check",
  committing: "committing",
  rolling_back: "rolling_back",
};

export interface ActivationOptions {
  host: ActivationHost;
  journal: UpdateJournal;
  record: UpdateJournalRecord;
  candidateDir: string;
  kind: "update" | "rollback";
  stateDir: string | null;
  migration: MigrationDecision;
  /** Observe phases (UI progress); called after the journal is written. */
  onPhase?(phase: HandoverPhase): void | Promise<void>;
  fields?: Record<string, unknown>;
}

export interface ActivationOutcome {
  task: HandoverTask;
  /** Resolves with the handover result once the journal is terminal. */
  done: Promise<{ result: HandoverResult; record: UpdateJournalRecord }>;
}

export async function runActivation(opts: ActivationOptions): Promise<ActivationOutcome> {
  const { host, journal, candidateDir, kind, stateDir, migration } = opts;
  let record = opts.record;
  const checkpoint = join(host.layout.checkpointsDir, record.transaction);
  let migrated = false;
  const fields = { transaction_id: record.transaction, ...opts.fields };

  const task = await host.activateInstalled(
    candidateDir,
    kind,
    {
      onPhase: async (phase) => {
        const jp = PHASE_TO_JOURNAL[phase];
        if (jp && jp !== record.phase) record = journal.advance(record, jp);
        await opts.onPhase?.(phase);
      },
      beforeLoad: async () => {
        if (migration.plan.length > 0 && stateDir) {
          record = journal.advance(record, "migrating", {
            migration: { from: migration.from ?? 0, to: migration.to, stateDir, checkpoint },
          });
          host.telemetry.emit("runtime.migration.started", {
            ...fields,
            state_schema: migration.from ?? undefined,
            to_schema: migration.to,
          });
          await createCheckpoint(stateDir, migration.plan, checkpoint);
          migrated = true;
          try {
            await applyMigrations(stateDir, migration.plan);
          } catch (error) {
            host.telemetry.emit("runtime.migration.failed", {
              ...fields,
              failure_reason: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
          host.telemetry.emit("runtime.migration.completed", { ...fields, state_schema: migration.to });
        }
        // Journal first, then the pointer switch (done by activateInstalled).
        record = journal.advance(record, "activating");
      },
      // Durable BEFORE the new generation takes over: a crash after this point
      // keeps the update; a failure to write it rolls the handover back.
      onCommit: async () => {
        record = journal.advance(record, "committed");
      },
      onRollback: async () => {
        if (record.phase !== "rolling_back") record = journal.advance(record, "rolling_back");
        if (migrated && stateDir && hasCheckpoint(checkpoint)) await restoreCheckpoint(checkpoint, stateDir);
      },
    },
    fields,
  );

  const done = task.promise.then((result) => {
    // `committed` was written by onCommit, before the gate opened. Everything
    // else is recorded here; a journal that cannot be written must not turn
    // the outcome into an unhandled rejection.
    try {
      if (result.ok) {
        if (record.phase !== "committed") record = journal.advance(record, "committed");
        host.telemetry.emit("runtime.update.committed", {
          ...fields,
          new_generation: result.activeGeneration,
          old_generation: result.fromGeneration,
          duration: result.durationMs,
        });
      } else if (result.rolledBack) {
        record = journal.advance(record, "rolled_back", { failure: result.failure });
      } else if (record.phase !== "failed") {
        record = journal.advance(record, "failed", { failure: result.failure });
      }
    } catch (error) {
      host.telemetry.emit("runtime.update.failed", {
        ...fields,
        failure_reason: `journal write failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return { result, record };
  });
  return { task, done };
}
