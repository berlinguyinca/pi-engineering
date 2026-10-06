/**
 * Candidate metadata: what a Pi Engineering release declares about itself
 * (spec §16-§18, §25, §46). Everything read from a candidate is validated
 * here and treated as untrusted data. It is never executed and never
 * interpolated into a command.
 */

import { type StateSchemaSupport, isStateSchemaSupport } from "../runtime/migrations/schema.ts";

export interface CandidateMetadata {
  name: string;
  version: string;
  runtimeApi: number;
  entry: string;
  minimumPiVersion: string | null;
  maximumPiVersion: string | null;
  stateSchema: StateSchemaSupport;
}

export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataError";
  }
}

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const VERSION_RANGE_BOUND = /^\d{1,6}(?:\.(?:\d{1,6}|x)){0,2}$/;
const SAFE_ENTRY = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}\.(?:ts|js|mjs)$/;

/** Parse and validate a candidate package.json. Throws MetadataError on anything malformed. */
export function parseCandidateMetadata(packageJson: string, legacyEntry: string): CandidateMetadata {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(packageJson) as Record<string, unknown>;
  } catch {
    throw new MetadataError("candidate package.json is not valid JSON");
  }
  if (typeof pkg !== "object" || pkg === null) throw new MetadataError("candidate package.json is not an object");
  const version = pkg.version;
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new MetadataError(`malformed candidate version ${JSON.stringify(version)}`);
  }
  const meta = (pkg.piEngineering ?? {}) as Record<string, unknown>;
  if (typeof meta !== "object" || meta === null) throw new MetadataError("malformed piEngineering metadata");
  // A release older than the runtime contract is still the extension: it is
  // runtime API 1 only if it ships the adapter entry. Validation imports it to
  // be sure.
  const runtimeApi = meta.runtimeApi ?? 1;
  if (!Number.isInteger(runtimeApi) || (runtimeApi as number) < 1 || (runtimeApi as number) > 1000) {
    throw new MetadataError(`malformed runtimeApi ${JSON.stringify(runtimeApi)}`);
  }
  const entry = meta.entry ?? legacyEntry;
  if (typeof entry !== "string" || !SAFE_ENTRY.test(entry) || entry.includes("..")) {
    throw new MetadataError(`malformed runtime entry ${JSON.stringify(entry)}`);
  }
  const bound = (key: string): string | null => {
    const v = meta[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || !VERSION_RANGE_BOUND.test(v)) {
      throw new MetadataError(`malformed ${key} ${JSON.stringify(v)}`);
    }
    return v;
  };
  const schema = meta.stateSchema ?? { minReadable: 1, maxReadable: 1, writes: 1 };
  if (!isStateSchemaSupport(schema)) throw new MetadataError(`malformed stateSchema ${JSON.stringify(schema)}`);
  return {
    name: typeof pkg.name === "string" ? pkg.name : "pi-engineering-runtime",
    version,
    runtimeApi: runtimeApi as number,
    entry,
    minimumPiVersion: bound("minimumPiVersion"),
    maximumPiVersion: bound("maximumPiVersion"),
    stateSchema: schema,
  };
}

function parts(v: string): Array<number | "x"> {
  return v
    .split("-")[0]
    ?.split(".")
    .map((p) => (p === "x" ? "x" : Number(p))) as Array<number | "x">;
}

/** Compare a concrete version against a bound; `x` and missing parts match anything. */
function cmp(version: string, bound: string): number {
  const a = parts(version);
  const b = parts(bound);
  for (let i = 0; i < 3; i++) {
    const bi = b[i];
    if (bi === undefined || bi === "x") return 0;
    const ai = (a[i] ?? 0) as number;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

/** Is the running Pi within the candidate's declared range? (spec §17) */
export function piCompatible(
  running: string,
  min: string | null,
  max: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (!VERSION.test(running)) return { ok: false, reason: `running Pi version ${running} is not recognised` };
  if (min && cmp(running, min) < 0) return { ok: false, reason: `requires Pi ≥ ${min}, running ${running}` };
  if (max && cmp(running, max) > 0) return { ok: false, reason: `requires Pi ≤ ${max}, running ${running}` };
  return { ok: true };
}
