// ErrorOccurrence (v1): the normalized "something failed" envelope that E01's ERROR_SOURCES.md
// points to. Most harness failures today are transient (telemetry bus only) or swallowed outright;
// E03 maps them into this shape. Additive — `incidents/types.ts` is untouched. A failure log must
// not leak secrets or escape sequences, so unredacted/non-printable summaries and any occurrence
// without a session are refused rather than repaired.
import { redactSecrets } from "../platform/redact.ts";

export const ERROR_OCCURRENCE_VERSION = 1;
export const ERROR_LAYERS = ["host", "process", "session-store", "aps", "incident", "retry", "worker", "gateway", "verify"] as const;
export const ERROR_SEVERITIES = ["info", "warning", "error", "fatal"] as const;
export type ErrorLayer = (typeof ERROR_LAYERS)[number];
export interface ErrorOccurrence {
  version: number; timestamp: string; host: string; sessionId: string; runtime: string;
  layer: ErrorLayer; code: string; severity: (typeof ERROR_SEVERITIES)[number]; summary: string;
  runId: string | null; taskId: string | null; model: string | null; quantization: string | null;
  correlationIds: string[]; artifactRefs: string[]; // >=1 correlation id; refs are repo-relative evidence paths
}
export type ErrorOccurrenceResult = { ok: true; event: ErrorOccurrence } | { ok: false; errors: string[] };
const PRINTABLE = /^[\x20-\x7e]*$/; // no NUL, no CR/LF, no ANSI
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function parseErrorOccurrence(input: unknown): ErrorOccurrenceResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["expected an object"] };
  const raw = input as Record<string, unknown>; const errors: string[] = [];
  const text = (field: string, max: number): string => {
    const value = raw[field];
    if (typeof value !== "string" || value.length === 0 || !PRINTABLE.test(value)) errors.push(`${field}: expected a non-empty printable string`);
    else if (value.length > max) errors.push(`${field}: longer than ${max} characters`);
    else return value;
    return "";
  };
  if (raw.version !== ERROR_OCCURRENCE_VERSION) errors.push(`version: expected ${ERROR_OCCURRENCE_VERSION}`);
  const host = text("host", 200); const sessionId = text("sessionId", 200); const runtime = text("runtime", 200); const code = text("code", 200);
  const timestamp = text("timestamp", 40); if (timestamp.length > 0 && !ISO_8601.test(timestamp)) errors.push("timestamp: expected ISO-8601 UTC");
  const layer = text("layer", 40); if (layer.length > 0 && !ERROR_LAYERS.includes(layer as ErrorLayer)) errors.push(`layer: expected one of ${ERROR_LAYERS.join(", ")}`);
  const severity = text("severity", 20); if (severity.length > 0 && !ERROR_SEVERITIES.includes(severity as never)) errors.push(`severity: expected one of ${ERROR_SEVERITIES.join(", ")}`);
  const summary = text("summary", 500);
  if (summary.length > 0 && redactSecrets(summary) !== summary) errors.push("summary: contains an unredacted secret — redact it first");
  const nullable: Record<"runId" | "taskId" | "model" | "quantization", string | null> = { runId: null, taskId: null, model: null, quantization: null };
  for (const field of Object.keys(nullable) as Array<keyof typeof nullable>) {
    const value = raw[field]; // absent means null, never guessed
    if (value !== null && value !== undefined) { if (typeof value === "string" && PRINTABLE.test(value)) nullable[field] = value; else errors.push(`${field}: expected a string or null`); }
  }
  const list = (field: string, min: number): string[] => {
    const values = raw[field]; if (!Array.isArray(values)) { errors.push(`${field}: expected an array`); return []; }
    const items = values.filter((item: unknown, index: number) => {
      const printable = typeof item === "string" && item.length > 0 && PRINTABLE.test(item);
      const unsafeRef = field === "artifactRefs" && printable && (/^\//.test(item) || /\s/.test(item) || item.split("/").includes(".."));
      if (!printable) errors.push(`${field}[${index}]: expected a printable string`);
      else if (unsafeRef) errors.push(`${field}[${index}]: expected a relative artifact path`);
      return printable && !unsafeRef;
    }).map(String);
    if (items.length < min) errors.push(`${field}: expected at least ${min} entry`); return items;
  };
  const correlationIds = list("correlationIds", 1); const artifactRefs = list("artifactRefs", 0);
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, event: { version: ERROR_OCCURRENCE_VERSION, timestamp, host, sessionId, runtime, layer: layer as ErrorLayer, code, severity: severity as (typeof ERROR_SEVERITIES)[number], summary, ...nullable, correlationIds, artifactRefs } };
}
