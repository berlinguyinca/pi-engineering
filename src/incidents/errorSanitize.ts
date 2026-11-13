// E04: the last pass before an ErrorOccurrence reaches a durable sink. E02 owns the schema, E03 owns the mapping, this owns what we are willing to keep. It reuses the one canonical secret table (src/platform/redact.ts) instead of writing a second pattern set, and adds what that table cannot know: secret-bearing *environment values* (only the variable NAME survives), absolute local paths (`<path>`), and raw prompt or transcript text — of which only `<redacted-prompt len=N sha256=…>` survives, because a truncated prompt is still a prompt. The caps keep an error index from becoming a log store, and a cap that bites counts what it dropped into the summary instead of dropping it silently.
import { createHash } from "node:crypto";
import { redactDeep, redactSecrets } from "../platform/redact.ts";
import {
  ERROR_LAYERS,
  ERROR_OCCURRENCE_VERSION,
  ERROR_SEVERITIES,
  type ErrorOccurrence,
  parseErrorOccurrence,
} from "./errorEvent.ts";
import { UNATTRIBUTED, UNKNOWN_ERROR_CODE } from "./errorNormalize.ts";
export const SUMMARY_MAX_CHARS = 400; // E02 admits 500; past this a "summary" is a transcript, so only its length and digest are kept
export const MAX_ARTIFACT_REFS = 8,
  MAX_CORRELATION_IDS = 8; // a failure has a cause and an evidence file; forty refs is a payload dump
export const MAX_REF_CHARS = 60,
  MAX_FIELD_CHARS = 120; // refs and ids are pointers, not prose; host/sessionId/runtime/code/model/quantization are labels
export const MAX_PERSISTED_BYTES = 4096; // hard budget for the serialized record; the caps above keep the fixed fields alone well under it
export const ENV_NAME =
    /(?:^|[_-])(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTHORIZATION|CERT)(?:$|[_-])/i,
  ENV_VALUE_MIN = 8; // an env name that means "secret", and the shortest value worth redacting ("1", "linux", "x86_64" are env values too)
const PATH_RULES: Array<[RegExp, string]> = [
  [/\b[a-zA-Z]:\\[^\s"'`,;|&)\]]*/g, "<path>"],
  [/(^|[\s"'`(=])\/[^\s"'`,;|&)\]]+/g, "$1<path>"],
]; // a drive letter, an absolute POSIX path
const TRANSCRIPT = /(?:^|\s)(?:system|user|assistant|human|prompt)\s*[:>]\s/i;
const DROP_MARKER = /(?: \[(?:refs|ids)\+\d+ dropped\])+$/; // a prompt transcript, whichever field it arrived in; our own suffix, which re-sanitizing must not stack
const EPOCH = "1970-01-01T00:00:00Z";
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
export interface SanitizePolicy {
  summaryMaxChars?: number;
  maxArtifactRefs?: number;
  maxCorrelationIds?: number;
  maxRefChars?: number;
  maxFieldChars?: number;
  maxPersistedBytes?: number;
}
const envSecrets = (): Array<[string, string]> =>
  Object.entries(process.env)
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && ENV_NAME.test(entry[0]) && entry[1].length >= ENV_VALUE_MIN,
    )
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)); // one snapshot, longest value first: a short secret can sit inside a longer one
const clean = (value: unknown, secrets: Array<[string, string]>): string => {
  let s = "";
  try {
    s = redactSecrets(typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
  } catch {
    return "";
  } // unreadable evidence is no evidence
  for (const [name, secret] of secrets) s = s.split(secret).join(`[env:${name}]`);
  for (const [pattern, replacement] of PATH_RULES) s = s.replace(pattern, replacement); // the name is diagnostic, the value is never stored
  return s.replace(/[^\x20-\x7e]+/g, " ").trim();
}; // E02 refuses non-printable text outright
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
const text = (value: unknown, max: number, secrets: Array<[string, string]>): string => {
  const s = clean(value, secrets);
  return s.length === 0
    ? ""
    : s.length > max || TRANSCRIPT.test(s)
      ? `<redacted-prompt len=${s.length} sha256=${digest(s)}>`
      : s;
};
const ref = (value: unknown, max: number, secrets: Array<[string, string]>): string | null => {
  // E02 refuses absolute, blank, spaced or escaping refs: drop them, never rewrite them
  if (
    typeof value !== "string" ||
    !/^[\x20-\x7e]+$/.test(value) ||
    value.startsWith("/") ||
    /\s/.test(value) ||
    value.split("/").includes("..")
  )
    return null;
  const s = clean(value, secrets).slice(0, max);
  return s === "" || /\s/.test(s) ? null : s;
};
const bytes = (event: ErrorOccurrence): number => Buffer.byteLength(JSON.stringify(event), "utf8");

/** The persisted form of an occurrence, or null when there is nothing attributable to store. Pure, deterministic for a given environment (no clock, no randomness, no I/O), never throws, idempotent. A policy value only shrinks the record; unknown input fields are not persisted at all. */
export function sanitizeForPersistence(input: unknown, policy: SanitizePolicy = {}): ErrorOccurrence | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null; // not an occurrence: refuse, E02 rejects the unattributed and E04 will not invent attribution
  const cap = (value: number | undefined, fallback: number): number =>
    Number.isInteger(value) && (value as number) >= 1 ? (value as number) : fallback;
  const [summaryMax, refsMax, idsMax, refMax, fieldMax, budget] = [
    cap(policy.summaryMaxChars, SUMMARY_MAX_CHARS),
    cap(policy.maxArtifactRefs, MAX_ARTIFACT_REFS),
    cap(policy.maxCorrelationIds, MAX_CORRELATION_IDS),
    cap(policy.maxRefChars, MAX_REF_CHARS),
    cap(policy.maxFieldChars, MAX_FIELD_CHARS),
    cap(policy.maxPersistedBytes, MAX_PERSISTED_BYTES),
  ];
  const secrets = envSecrets();
  let raw: Record<string, unknown> = {};
  try {
    raw = redactDeep(input as Record<string, unknown>);
  } catch {
    raw = {};
  } // a hostile getter is unreadable evidence: record the gap, do not throw
  const field = (name: string, max: number, fallback = ""): string => text(raw[name], max, secrets) || fallback;
  const list = (name: string, max: number, fallback: string): { kept: string[]; dropped: number } => {
    const items = [
      ...new Set(
        (Array.isArray(raw[name]) ? (raw[name] as unknown[]) : [])
          .map((item) => ref(item, refMax, secrets))
          .filter((item): item is string => item !== null),
      ),
    ];
    const kept = items.slice(0, max);
    return { kept: kept.length > 0 ? kept : fallback === "" ? [] : [fallback], dropped: items.length - kept.length };
  }; // empty refs are honest, empty ids are unattributed
  const refs = list("artifactRefs", refsMax, "");
  const ids = list("correlationIds", idsMax, UNATTRIBUTED);
  const nullable = (name: string): string | null => field(name, fieldMax) || null;
  const layer = field("layer", 40);
  const severity = field("severity", 20); // an unknown enum value is a gap E02 would refuse: fall back to the least loud one
  const suffix = [
    [refs.dropped, "refs"],
    [ids.dropped, "ids"],
  ]
    .map(([n, name]) => ((n as number) > 0 ? ` [${name as string}+${n as number} dropped]` : ""))
    .join("");
  const body = field("summary", Math.max(8, summaryMax - suffix.length), UNKNOWN_ERROR_CODE); // the drop counts stay legible inside the summary cap
  const base: ErrorOccurrence = {
    version: ERROR_OCCURRENCE_VERSION,
    timestamp: ISO_8601.test(field("timestamp", 40)) ? String(raw.timestamp) : EPOCH, // never our own clock — E03 owns the stamp
    host: field("host", fieldMax, UNATTRIBUTED),
    sessionId: field("sessionId", fieldMax, UNATTRIBUTED),
    runtime: field("runtime", fieldMax, UNATTRIBUTED),
    code: field("code", fieldMax, UNKNOWN_ERROR_CODE),
    layer: ERROR_LAYERS.includes(layer as ErrorOccurrence["layer"]) ? (layer as ErrorOccurrence["layer"]) : "process",
    severity: ERROR_SEVERITIES.includes(severity as ErrorOccurrence["severity"])
      ? (severity as ErrorOccurrence["severity"])
      : "warning",
    runId: nullable("runId"),
    taskId: nullable("taskId"),
    model: nullable("model"),
    quantization: nullable("quantization"),
    correlationIds: ids.kept,
    artifactRefs: refs.kept,
    summary: body,
  };
  let keep = body.length;
  let summary = suffix === "" ? body : body.replace(DROP_MARKER, "") + suffix; // an existing marker is rewritten, never stacked
  while (keep > 3 && (bytes({ ...base, summary }) > budget || !parseErrorOccurrence({ ...base, summary }).ok)) {
    keep = Math.max(3, keep - 64);
    summary = `${body.slice(0, keep)}...${suffix}`;
  } // the byte budget is hard, and a cut that splits a redaction marker must cut deeper: E02 would reject it
  const parsed = parseErrorOccurrence({ ...base, summary });
  return parsed.ok && bytes({ ...base, summary }) <= budget ? parsed.event : null; // refuse to store what E02 would reject, or what cannot meet the budget (a minimum record is ~455 bytes)
}
