/**
 * Persistent state schema versioning (spec §25).
 *
 * `.pi-eng/state-schema.json` records the schema of the Pi Engineering-owned
 * state in a `.pi-eng` directory. The file is absent in every store written
 * before versioning existed, and an absent file reads as BASELINE_STATE_SCHEMA:
 * the format those stores already have.
 *
 * Each runtime declares the schemas it can read and the schema it writes. For
 * this code base that is package.json `piEngineering.stateSchema`, mirrored by
 * RUNTIME_STATE_SCHEMA below.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

export const STATE_SCHEMA_FILE = "state-schema.json";
export const BASELINE_STATE_SCHEMA = 1;

export interface StateSchemaSupport {
  minReadable: number;
  maxReadable: number;
  writes: number;
}

/** What this runtime reads and writes. */
export const RUNTIME_STATE_SCHEMA: StateSchemaSupport = { minReadable: 1, maxReadable: 1, writes: 1 };

export function isStateSchemaSupport(value: unknown): value is StateSchemaSupport {
  const v = value as Partial<StateSchemaSupport> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    [v.minReadable, v.maxReadable, v.writes].every((n) => Number.isInteger(n) && (n as number) >= 1) &&
    (v.minReadable as number) <= (v.writes as number) &&
    (v.writes as number) <= (v.maxReadable as number)
  );
}

/** Schema version of a state directory; BASELINE when unversioned; null when corrupt. */
export function readStateSchema(stateDir: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(join(stateDir, STATE_SCHEMA_FILE), "utf8");
  } catch {
    return BASELINE_STATE_SCHEMA;
  }
  try {
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown };
    return Number.isInteger(parsed.schemaVersion) && (parsed.schemaVersion as number) >= 1
      ? (parsed.schemaVersion as number)
      : null;
  } catch {
    return null;
  }
}

export function writeStateSchema(stateDir: string, schemaVersion: number): void {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, STATE_SCHEMA_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, `${JSON.stringify({ schemaVersion }, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export type SchemaCompatibility =
  | { kind: "compatible"; schema: number }
  | { kind: "migrate"; from: number; to: number }
  | { kind: "incompatible"; schema: number | null; reason: string };

/** Can a runtime with `support` run on state at `schema`, or what must happen first? */
export function schemaCompatibility(schema: number | null, support: StateSchemaSupport): SchemaCompatibility {
  if (schema === null) return { kind: "incompatible", schema, reason: "state schema marker is corrupt" };
  if (schema >= support.minReadable && schema <= support.maxReadable) return { kind: "compatible", schema };
  if (schema < support.minReadable) return { kind: "migrate", from: schema, to: support.writes };
  return {
    kind: "incompatible",
    schema,
    reason: `state schema ${schema} is newer than this runtime reads (max ${support.maxReadable})`,
  };
}
