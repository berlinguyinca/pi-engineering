/**
 * Offline compaction of the `lease.*` churn in an orchestration event log.
 *
 * Recovery loops append an acquired/fenced pair per attempt; on a long-lived
 * store that is most of the file and every runtime open replays all of it. Each
 * lease event is a full snapshot of its resource's lease, and replay only keeps
 * the LAST one per resource (the epoch, plus whether it is held). So every
 * earlier lease event for the same resource is droppable, provided each dropped
 * event still counts toward its mission's revision. The surviving event records
 * that in `payload.collapsed` ({ missionId: count }), which `MissionStore`
 * applies on replay.
 *
 * Safety: the output is written to a temporary file, then both logs are
 * replayed and their canonical state digests must match before anything is
 * swapped in. The default is a dry run; `apply` keeps the original as `.bak`
 * and refuses to swap if the log changed while it was being compacted. Never
 * run it while a session that writes this log is alive.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { StoredEvent } from "../platform/eventstore/backend.ts";
import { toStoredEvent } from "../runtime/isolation/jsonlFiles.ts";
import { MissionStore } from "./missionStore.ts";

const LEASE_TYPES = new Set(["lease.acquired", "lease.renewed", "lease.expired", "lease.fenced"]);

export interface LeaseCompactionReport {
  file: string;
  applied: boolean;
  backup: string | null;
  linesBefore: number;
  linesAfter: number;
  leaseEventsBefore: number;
  leaseEventsAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  stateIdentical: boolean;
}

interface Parsed {
  type: string;
  key: string;
  missionId: string | null;
  collapsed: Record<string, number>;
}

/** The resource a lease event describes, or null when the line is not a usable lease event. */
function parseLease(line: string): Parsed | null {
  if (!line.includes('"lease.')) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = record.type;
  if (typeof type !== "string" || !LEASE_TYPES.has(type)) return null;
  const payload = record.payload as Record<string, unknown> | undefined;
  const lease = payload?.lease as { missionId?: string; repoId?: string } | undefined;
  const scope = payload?.scope;
  const resource = scope === "mission" ? lease?.missionId : scope === "repository" ? lease?.repoId : undefined;
  if (typeof resource !== "string") return null;
  return {
    type,
    key: `${scope}:${resource}`,
    missionId: typeof record.run_id === "string" ? record.run_id : null,
    collapsed: { ...((payload?.collapsed as Record<string, number> | undefined) ?? {}) },
  };
}

async function* lines(file: string): AsyncGenerator<string> {
  const reader = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of reader) yield line;
}

async function* storedEvents(file: string): AsyncGenerator<StoredEvent> {
  for await (const line of lines(file)) {
    if (!line.trim()) continue;
    try {
      const event = toStoredEvent(JSON.parse(line));
      if (event) yield event;
    } catch {
      // Malformed lines are skipped by replay too.
    }
  }
}

async function streamDigest(file: string): Promise<string> {
  // MissionStore replay is synchronous, so stream in bounded chunks into one store.
  const chunk: StoredEvent[] = [];
  const store = MissionStore.fromEvents([]);
  const feed = (): void => {
    store.replayEvents(chunk);
    chunk.length = 0;
  };
  for await (const event of storedEvents(file)) {
    chunk.push(event);
    if (chunk.length >= 5000) feed();
  }
  feed();
  return store.stateDigest();
}

/**
 * Compact one orchestration event file. Dry run unless `apply` is true.
 * Idempotent: compacting an already-compacted log changes nothing.
 */
export async function compactLeaseEvents(
  file: string,
  options: { apply?: boolean } = {},
): Promise<LeaseCompactionReport> {
  const before = await stat(file);
  // Pass 1: the last line of each resource, and what every superseded event owes it.
  const lastLine = new Map<string, number>();
  const lastShare = new Map<string, Record<string, number>>();
  const owed = new Map<string, Record<string, number>>();
  let linesBefore = 0;
  let leaseEventsBefore = 0;
  let index = 0;
  for await (const line of lines(file)) {
    const lease = parseLease(line);
    if (lease) {
      leaseEventsBefore++;
      // A superseded event owes its mission one revision plus whatever it had already folded.
      const share = { ...lease.collapsed };
      if (lease.missionId) share[lease.missionId] = (share[lease.missionId] ?? 0) + 1;
      const superseded = lastShare.get(lease.key);
      if (superseded) {
        const debt = owed.get(lease.key) ?? {};
        for (const [mission, count] of Object.entries(superseded)) debt[mission] = (debt[mission] ?? 0) + count;
        owed.set(lease.key, debt);
      }
      lastLine.set(lease.key, index);
      lastShare.set(lease.key, share);
    }
    linesBefore++;
    index++;
  }
  // Pass 2: write the compacted copy.
  const temporary = `${file}.compact.tmp`;
  const output = createWriteStream(temporary, { encoding: "utf8" });
  let linesAfter = 0;
  let leaseEventsAfter = 0;
  index = 0;
  try {
    for await (const line of lines(file)) {
      const lease = parseLease(line);
      let text = line;
      if (lease) {
        if (lastLine.get(lease.key) !== index) {
          index++;
          continue;
        }
        leaseEventsAfter++;
        const debt = owed.get(lease.key);
        if (debt && Object.keys(debt).length > 0) {
          const record = JSON.parse(line) as { payload: Record<string, unknown> };
          const merged = { ...((record.payload.collapsed as Record<string, number> | undefined) ?? {}) };
          for (const [mission, count] of Object.entries(debt)) merged[mission] = (merged[mission] ?? 0) + count;
          record.payload.collapsed = merged;
          text = JSON.stringify(record);
        }
      }
      if (!output.write(`${text}\n`)) await new Promise<void>((resolve) => output.once("drain", resolve));
      linesAfter++;
      index++;
    }
    await new Promise<void>((resolve, reject) => {
      output.once("error", reject);
      output.end(resolve);
    });
    const [digestBefore, digestAfter] = [await streamDigest(file), await streamDigest(temporary)];
    const stateIdentical = digestBefore === digestAfter;
    const after = await stat(temporary);
    const report: LeaseCompactionReport = {
      file,
      applied: false,
      backup: null,
      linesBefore,
      linesAfter,
      leaseEventsBefore,
      leaseEventsAfter,
      bytesBefore: before.size,
      bytesAfter: after.size,
      stateIdentical,
    };
    if (!options.apply || !stateIdentical) {
      await unlink(temporary);
      return report;
    }
    const current = await stat(file);
    if (current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
      await unlink(temporary);
      throw new Error(`${file} changed while it was being compacted; nothing was modified`);
    }
    const backup = `${file}.bak`;
    await rename(file, backup);
    await rename(temporary, file);
    return { ...report, applied: true, backup };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
