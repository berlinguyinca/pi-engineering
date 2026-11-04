/**
 * Shared durable memory providers — the cross-worker memory surface.
 *
 * Promoted knowledge lives in a `DurableMemoryProvider`. The default is
 * single-process in-memory. To let SEVERAL pi workers share their promoted
 * memory, point the provider at a shared backend:
 *
 *  - `SharedFileDurableMemory` — dependency-free, append-only JSONL on a shared
 *    path. Safe for concurrent processes on one host (O_APPEND per line) and
 *    for CI.
 *  - `HindsightDurableMemory` (src/blackhole/hindsight.ts) — the Hindsight
 *    (herdr-memory) service for cross-machine sharing. Pi reaches it ONLY
 *    through the `herdr-memory` client, which owns the durable outbox, tenant
 *    keys, tombstones, the evidence gate and the corrections ledger. There is
 *    deliberately no HTTP adapter here: talking to the REST API directly would
 *    bypass that contract.
 *
 * Sharing is read-only from the perspective of a worker: workers hydrate their
 * context FROM shared durable memory, but only the evidence-gated promotion
 * pipeline WRITES to it. Session-local working memory stays strictly isolated.
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { type DurableMemoryProvider, type DurableMemoryRecord, searchDurable } from "./durableProvider.ts";

/** Dependency-free cross-process shared store backed by append-only JSONL. */
export class SharedFileDurableMemory implements DurableMemoryProvider {
  readonly kind = "shared-file";
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async store(record: DurableMemoryRecord): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    // appendFile via writeSync on an O_APPEND fd keeps each record a single
    // atomic-ish line so concurrent writers do not interleave within a record.
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
    } finally {
      closeSync(fd);
    }
  }

  async recallAll(): Promise<DurableMemoryRecord[]> {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const records: DurableMemoryRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as DurableMemoryRecord);
      } catch {
        // ignore a corrupt/partial trailing line; keep the rest
      }
    }
    return records;
  }

  async search(query: string): Promise<DurableMemoryRecord[]> {
    const all = await this.recallAll();
    return searchDurable(query, all);
  }
}
