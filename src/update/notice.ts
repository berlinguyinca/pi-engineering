/**
 * One-shot update outcome notices (issue #484).
 *
 * A transaction is started by whichever session happened to be open, but it can
 * finish, fail, be refused, be rolled back, or be recovered by a different
 * process — and telemetry alone never reaches the operator. The outcome is
 * therefore persisted in the install root and consumed exactly once by the next
 * session that starts.
 *
 * This module stores text only. It never moves a pointer, never writes the
 * journal, and cannot change what a transaction did.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type UpdateNoticeKind = "activated" | "failed" | "refused" | "rolled_back" | "interrupted";

const KINDS: ReadonlySet<string> = new Set<UpdateNoticeKind>([
  "activated",
  "failed",
  "refused",
  "rolled_back",
  "interrupted",
]);

export interface UpdateNotice {
  kind: UpdateNoticeKind;
  /** The transaction this outcome belongs to, when one was open. */
  transaction?: string | null;
  /** The line the operator sees, already legible (version ids, not bare versions). */
  text: string;
  at: string;
}

/** Atomically replace the pending notice; the newest report wins. */
export function writeUpdateNotice(file: string, notice: UpdateNotice): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(notice, null, 2));
  renameSync(tmp, file);
}

/** The pending notice, or null when there is nothing to show. */
export function readUpdateNotice(file: string): UpdateNotice | null {
  const raw = readRaw(file);
  return raw === null ? null : parse(raw);
}

/** The pending notice, cleared so it is delivered exactly once. */
export function takeUpdateNotice(file: string): UpdateNotice | null {
  const raw = readRaw(file);
  if (raw === null) return null;
  // Clear it before parsing: an unreadable notice must not linger either.
  try {
    unlinkSync(file);
  } catch {
    return null;
  }
  return parse(raw);
}

function readRaw(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Anything that is not a notice we recognise is discarded, not thrown. */
function parse(raw: string): UpdateNotice | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.kind !== "string" || !KINDS.has(value.kind)) return null;
    if (typeof value.text !== "string" || value.text.trim() === "") return null;
    if (typeof value.at !== "string") return null;
    return {
      kind: value.kind as UpdateNoticeKind,
      transaction: typeof value.transaction === "string" ? value.transaction : null,
      text: value.text,
      at: value.at,
    };
  } catch {
    return null;
  }
}
