// D02: the cross-session identity of an ErrorOccurrence. Equivalent root causes seen from different hosts,
// sessions, runs and timestamps must share one key; distinct causes must not — above all a 404 and a 429, which
// E03 already separates inside `code`, so digits are folded out of free text but never out of a code. Pure and
// total: no clock, no randomness, no I/O, no locale-dependent casing (`toLowerCase` is locale-independent).
import { fnv1a64 } from "../aps/fingerprint.ts";
import type { ErrorOccurrence } from "./errorEvent.ts";

/** Malformed or wholly-empty input is unattributable: one stable key, never a digest of raw text, never a throw. */
export const INVALID_FINGERPRINT = "0000000000000000";
export interface ErrorFingerprintInput {
  code: string;
  layer: string;
  summary: string;
  tool: string;
}

// Folds applied to the retained text, in this order. A run of >= 4 digits is volatile (id, port, epoch); 2-3 digit
// runs survive because "http 429" and "exit 2" are root-cause evidence. URLs are dropped entirely rather than
// host-kept: host, port, signed path and query are all volatile, and `code` already names the failing upstream.
const FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/<redacted-prompt\b[^>]*>/gi, "<prompt>"], // E04's len/sha256 is a re-serialization artifact: it must not move the key
  [/\bhttps?:\/\/[^\s"'`,;)\]]+/gi, "<url>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<addr>"],
  [/\[[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\](?::\d{1,5})?/gi, "<addr>"], // bracketed IPv6 (:: compressed) with or without :port
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  [/\b[0-9a-f]{8,}\b/gi, "<id>"], // hex ids and inline digests of any length
  [/\b\d+(?:\.\d+)?\s*(?:ns|us|ms|msec|sec|secs|seconds?|mins?|minutes?|hours?|s)\b/gi, "<dur>"],
  [/\b\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|tb|kib|mib|gib|bytes?)\b/gi, "<size>"],
  [/\b\d+\s+(?:lines?|chars?|characters?|tokens?|words?|attempts?|retries|events?|files?|records?|refs?)\b/gi, "<n>"],
  [/(?:^|[\s"'`(=])~?\/?(?:[\w.-]+\/)*worktrees?\/[^\s"'`,;)\]]*/g, " <path>"], // any worktree prefix, before the path rules
  [/(^|[\s"'`(=])\/[^\s"'`,;|&)\]]+/g, "$1<path>"], // absolute POSIX path (E04 folds most of these already)
  [/\b[a-z]:\\[^\s"'`,;|&)\]]*/gi, "<path>"], // Windows and file:// paths
  [/\b\d{4,}\b/g, "<num>"],
  [/\s+/g, " "],
];
// The field is read inside the try: a throwing accessor is no evidence rather than a crash, a non-string scalar is stringified, an absent field is empty text, and nothing raw ever reaches the key.
const raw = (source: object, key: string): string => {
  try {
    const value = (source as Record<string, unknown>)[key];
    return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  } catch {
    return "";
  }
};
const fold = (source: object, key: string): string =>
  FOLD.reduce((acc, [re, to]) => acc.replace(re, to), raw(source, key))
    .trim()
    .toLowerCase();
const foldCode = (source: object, key: string): string =>
  raw(source, key).replace(/\s+/g, "").toLowerCase().slice(0, 120); // digits survive: gateway.429.rate_limited !== gateway.404.not_found
// The tool is part of the cause when it is named in the code (`tool.bash.*`) or in the summary ("tool=rg", "tool rg").
const toolOf = (code: string, summary: string): string => {
  const named =
    /^(?:tool|worker)\.([a-z0-9][a-z0-9_-]*)\./i.exec(code) ??
    /\btool[ _-]?(?:name|is)?[ =:]+([a-z0-9][a-z0-9_-]*)/i.exec(summary);
  return (named?.[1] ?? "").toLowerCase().slice(0, 60);
};

/** What the key compares. What is dropped, and why: timestamp/host/sessionId/runId/taskId/runtime/correlationIds/artifactRefs are per-occurrence pointers; `severity` is E03's judgment of loudness rather than of cause (a 429 is "warning", a 5xx "error", and a version bump moves either), so keeping it would split equivalent errors; `model`/`quantization` are context, and when a model IS the cause E03 names it inside `summary`, which is retained. Null when nothing is attributable. */
export function fingerprintInput(occurrence: ErrorOccurrence): ErrorFingerprintInput | null {
  if (occurrence === null || typeof occurrence !== "object" || Array.isArray(occurrence)) return null;
  const code = foldCode(occurrence, "code");
  const summary = fold(occurrence, "summary");
  if (code === "" && summary === "") return null; // no cause recorded: there is nothing to correlate on
  return { code, layer: fold(occurrence, "layer"), summary, tool: toolOf(code, raw(occurrence, "summary")) };
}

/** A stable 16-hex-char key: FNV-1a 64 over canonical JSON with fixed sorted keys, as `incidentFingerprint` does.
 * Collision posture: ~2^-64 per pair over a small discriminator set, unkeyed and non-secret — keys group errors
 * for triage and authorize nothing, so a false merge costs one extra line in a report, never an action. */
export function errorFingerprint(occurrence: ErrorOccurrence): string {
  const input = fingerprintInput(occurrence);
  return input === null ? INVALID_FINGERPRINT : fnv1a64(JSON.stringify(input, ["code", "layer", "summary", "tool"]));
}
