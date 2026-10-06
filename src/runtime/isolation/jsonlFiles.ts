/**
 * Append-only JSONL helpers shared by the session event store, legacy
 * migration, startup recovery and the doctor.
 *
 * Invariant: valid history is never discarded. A torn final record (a write a
 * crash interrupted) is copied to a quarantine file BEFORE the stream is
 * truncated back to its last complete line, and a malformed complete line is
 * skipped in memory but left on disk.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readSync, truncateSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { StoredEvent } from "../../platform/eventstore/backend.ts";

export interface JsonlReadResult {
  events: StoredEvent[];
  /** Byte offset just past the last complete (newline-terminated) line read. */
  consumedBytes: number;
  /** Bytes after the last newline (an incomplete record), if any. */
  tornTailBytes: number;
  /** Complete lines that were not valid events. */
  corruptLines: number;
  /** Envelope metadata of the last event, when present. */
  lastSequence: number;
}

const STORED_KEYS = ["event_id", "timestamp", "type", "project_id", "run_id", "worker_id", "payload"] as const;

/** Strip envelope fields (session_id, worktree_id, sequence) back to the StoredEvent contract. */
export function toStoredEvent(value: unknown): StoredEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.event_id !== "string" || typeof record.type !== "string" || typeof record.timestamp !== "string") {
    return null;
  }
  const payload = record.payload;
  const event: StoredEvent = {
    event_id: record.event_id,
    timestamp: record.timestamp,
    type: record.type,
    project_id: typeof record.project_id === "string" ? record.project_id : null,
    run_id: typeof record.run_id === "string" ? record.run_id : null,
    worker_id: typeof record.worker_id === "string" ? record.worker_id : null,
    payload:
      payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {},
  };
  for (const key of Object.keys(record)) {
    if (!(STORED_KEYS as readonly string[]).includes(key) && !["session_id", "worktree_id", "sequence"].includes(key)) {
      // Unknown keys are preserved: other writers may extend the format.
      (event as unknown as Record<string, unknown>)[key] = record[key];
    }
  }
  return event;
}

/** Read complete lines of `file` starting at `fromOffset`. Missing files read as empty. */
export function readJsonlFrom(file: string, fromOffset = 0): JsonlReadResult {
  let descriptor: number;
  try {
    descriptor = openSync(file, "r");
  } catch {
    return { events: [], consumedBytes: fromOffset, tornTailBytes: 0, corruptLines: 0, lastSequence: 0 };
  }
  try {
    const size = fstatSync(descriptor).size;
    if (size <= fromOffset) {
      return {
        events: [],
        consumedBytes: Math.min(fromOffset, size),
        tornTailBytes: 0,
        corruptLines: 0,
        lastSequence: 0,
      };
    }
    const bytes = Buffer.alloc(size - fromOffset);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(descriptor, bytes, read, bytes.length - read, fromOffset + read);
      if (count === 0) break;
      read += count;
    }
    const chunk = bytes.subarray(0, read);
    const lastNewline = chunk.lastIndexOf(0x0a);
    const completeLength = lastNewline + 1;
    const events: StoredEvent[] = [];
    let corruptLines = 0;
    let lastSequence = 0;
    if (completeLength > 0) {
      for (const line of chunk.subarray(0, completeLength).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          const event = toStoredEvent(parsed);
          if (!event) {
            corruptLines++;
            continue;
          }
          const sequence = (parsed as { sequence?: unknown }).sequence;
          if (typeof sequence === "number" && Number.isSafeInteger(sequence)) lastSequence = sequence;
          events.push(event);
        } catch {
          corruptLines++;
        }
      }
    }
    return {
      events,
      consumedBytes: fromOffset + completeLength,
      tornTailBytes: read - completeLength,
      corruptLines,
      lastSequence,
    };
  } finally {
    closeSync(descriptor);
  }
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * Quarantine and truncate a torn final record. Returns the quarantine path, or
 * null when the file ends cleanly. The valid prefix is never modified.
 */
export function repairTornTail(file: string, recoveryDir: string): { quarantine: string; bytes: number } | null {
  let descriptor: number;
  try {
    descriptor = openSync(file, "r");
  } catch {
    return null;
  }
  let tail: Buffer;
  let keep: number;
  try {
    const size = fstatSync(descriptor).size;
    if (size === 0) return null;
    const bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const count = readSync(descriptor, bytes, read, size - read, read);
      if (count === 0) break;
      read += count;
    }
    if (bytes[read - 1] === 0x0a) return null;
    keep = bytes.subarray(0, read).lastIndexOf(0x0a) + 1;
    tail = Buffer.from(bytes.subarray(keep, read));
  } finally {
    closeSync(descriptor);
  }
  mkdirSync(recoveryDir, { recursive: true });
  const quarantine = join(recoveryDir, `torn-tail-${basename(file, ".jsonl")}-${stamp()}-${process.pid}.jsonl.part`);
  writeFileSync(quarantine, tail, { flag: "wx" });
  truncateSync(file, keep);
  return { quarantine, bytes: tail.length };
}

/** Write a diagnostic record to the recovery dir. Never throws. */
export function quarantineRecord(recoveryDir: string, prefix: string, content: string | Buffer): string | null {
  try {
    mkdirSync(recoveryDir, { recursive: true });
    const path = join(
      recoveryDir,
      `${prefix}-${stamp()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    writeFileSync(path, content, { flag: "wx" });
    return path;
  } catch {
    return null;
  }
}
