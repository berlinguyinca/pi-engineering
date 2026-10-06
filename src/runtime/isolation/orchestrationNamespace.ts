/**
 * Open the orchestration namespace a runtime binds to: legacy migration, the
 * session's own event writer over the merged stream, and mission custody.
 *
 * Only a namespace that cannot be written at all falls back further (to a
 * session-local one, then to memory); contention never fails an open, because
 * nothing here is exclusive across sessions.
 */
import { join } from "node:path";
import type { EventStoreBackend } from "../../platform/eventstore/backend.ts";
import { JsonlEventStore } from "../../platform/eventstore/jsonl.ts";
import { FileLockMissionCustody, LocalMissionCustody, type MissionCustody } from "./MissionCustody.ts";
import type { RuntimeBinding } from "./RuntimeBinding.ts";
import { SessionEventStore } from "./SessionEventStore.ts";
import { readJsonlFrom } from "./jsonlFiles.ts";
import { type LegacyMigrationResult, migrateLegacyStore } from "./legacyMigration.ts";
import { emitRuntimeEvent } from "./runtimeEvents.ts";

export type NamespaceBackend = EventStoreBackend & { close(): void };

export interface OrchestrationNamespace {
  /** In-process sharing key: one namespace instance per events directory. */
  key: string;
  binding: RuntimeBinding;
  backend: NamespaceBackend;
  custody: MissionCustody;
  migrations: LegacyMigrationResult[];
}

export function namespaceKey(binding: RuntimeBinding): string {
  return binding.eventsDir ?? `memory:${binding.identity.worktreeId}`;
}

export async function openOrchestrationNamespace(options: {
  binding: RuntimeBinding;
  sessionId: string;
  writerAuthority?: () => boolean;
}): Promise<OrchestrationNamespace> {
  const { binding, sessionId } = options;
  const migrations: LegacyMigrationResult[] = [];
  if (binding.runtimeDir && binding.eventsDir) {
    for (const legacyFile of binding.legacyFiles) {
      try {
        migrations.push(
          migrateLegacyStore({
            legacyFile,
            runtimeDir: binding.runtimeDir,
            eventsDir: binding.eventsDir,
            sessionId,
            worktreeId: binding.identity.worktreeId,
          }),
        );
      } catch (error) {
        // Degraded, not fatal: the session still runs; history import retries next open.
        emitRuntimeEvent("migration.skipped", {
          session_id: sessionId,
          worktree_id: binding.identity.worktreeId,
          source: legacyFile,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const backend = SessionEventStore.open({
      eventsDir: binding.eventsDir,
      sessionId,
      worktreeId: binding.identity.worktreeId,
      recoveryDir: binding.recoveryDir ?? undefined,
      writerAuthority: options.writerAuthority,
    });
    return {
      key: namespaceKey(binding),
      binding,
      backend,
      custody: new FileLockMissionCustody(join(binding.runtimeDir, "custody")),
      migrations,
    };
  }
  // Nothing writable: keep engineering features alive in memory, seeded with
  // whatever legacy history is readable.
  const backend = JsonlEventStore.inMemory();
  for (const legacyFile of binding.legacyFiles) {
    const { events } = readJsonlFrom(legacyFile, 0);
    if (events.length > 0) await backend.appendAll(events);
  }
  return { key: namespaceKey(binding), binding, backend, custody: new LocalMissionCustody(), migrations };
}
