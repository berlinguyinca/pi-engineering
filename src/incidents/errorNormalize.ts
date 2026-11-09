// E03: deterministic normalization of observed harness failures into the E02 ErrorOccurrence envelope (E02 owns the
// schema, E04 owns what we store). Mapping is a pure table walk — first match wins, in the order written below — so
// identical input plus identical context yields byte-identical output: no clock, no randomness, no iteration order.
import { redactSecrets } from "../platform/redact.ts";
import { ERROR_LAYERS, ERROR_OCCURRENCE_VERSION, type ErrorLayer, type ErrorOccurrence } from "./errorEvent.ts";
export const UNKNOWN_ERROR_CODE = "unknown.unclassified"; // an unrecognised shape is recorded, never dropped
export const UNATTRIBUTED = "unattributed"; // caller gave no host/session/id — a durable sink must refuse it (E02)
const NON_PRINTABLE = /[^\x20-\x7e]+/g;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const EPOCH = "1970-01-01T00:00:00Z";
type Severity = ErrorOccurrence["severity"];
export interface NormalizationContext {
  // timestamps arrive here — normalizeError never reads the clock
  timestamp: string;
  host: string;
  sessionId: string;
  runtime: string;
  correlationIds: string[];
  runId?: string | null;
  taskId?: string | null;
  model?: string | null;
  quantization?: string | null;
  layer?: ErrorLayer;
  artifactRefs?: string[];
} // derived refs; input evidence stays ahead of them
export interface UnknownErrorInput {
  // tolerant on purpose: every field optional, unknown fields allowed, nothing dropped
  kind?: string;
  type?: string;
  category?: string;
  message?: string;
  error?: string;
  detail?: string;
  text?: string;
  reason?: string;
  summary?: string;
  stderr?: string;
  signal?: string;
  code?: string | number;
  httpStatus?: number | string;
  status?: number | string;
  statusCode?: number | string;
  exitCode?: number | string;
  exit_status?: number | string;
  evidenceRef?: string;
  artifactRefs?: string[];
  correlationIds?: string[];
  [key: string]: unknown;
}
interface Signal {
  detail: string;
  status: number | null;
  exit: number | null;
  haystack: string;
}
const printable = (value: unknown, max: number): string =>
  redactSecrets(typeof value === "string" ? value : value === null || value === undefined ? "" : String(value))
    .replace(NON_PRINTABLE, " ")
    .trim()
    .slice(0, max);
const numeric = (value: unknown): number | null =>
  /^-?\d+$/.test(printable(value, 24)) ? Number(printable(value, 24)) : null;
const storable = (ref: unknown): ref is string =>
  typeof ref === "string" &&
  ref.length > 0 &&
  /^[\x20-\x7e]*$/.test(ref) &&
  !ref.startsWith("/") &&
  !/\s/.test(ref) &&
  !ref.split("/").includes(".."); // E02 refuses absolute/blank/escaping refs, so never emit one
const RULES: Array<{
  when: (s: Signal) => boolean;
  code: string;
  severity: Severity;
  layer: ErrorLayer;
  what: string;
}> = [
  // most specific first; the last entry matches anything
  {
    when: (s) =>
      s.haystack.includes("worker_result_missing") ||
      /no structured result|missing (worker|structured) result|without a result|result (is|was) missing|finished with no result/.test(
        s.haystack,
      ),
    code: "worker.result_missing",
    severity: "error",
    layer: "worker",
    what: "worker finished without a structured result",
  },
  {
    when: (s) => /panic|sigsegv|sigabrt|sigill|sigbus|core dumped|oomkilled|out of memory|killed: 9/.test(s.haystack),
    code: "process.crash",
    severity: "fatal",
    layer: "process",
    what: "process crashed",
  },
  {
    when: (s) => s.exit !== null && s.exit !== 0,
    code: "tool.nonzero_exit",
    severity: "error",
    layer: "worker",
    what: "tool exited with a non-zero status",
  },
  {
    when: (s) =>
      s.status === 429 || /rate.?limit|too many requests|overloaded|queue_saturated|retry after/.test(s.haystack),
    code: "gateway.429.rate_limited",
    severity: "warning",
    layer: "gateway",
    what: "upstream rate limit",
  },
  {
    when: (s) => s.status === 404 || /not found|no such (model|deployment|route)/.test(s.haystack),
    code: "gateway.404.not_found",
    severity: "error",
    layer: "gateway",
    what: "upstream returned not found",
  },
  {
    when: (s) =>
      s.status === 400 ||
      s.status === 413 ||
      /no thinking match for model|bad request|invalid request|invalid argument|content policy|context (length|window)|prompt is too long|too many tokens/.test(
        s.haystack,
      ),
    code: "gateway.400.bad_request",
    severity: "error",
    layer: "gateway",
    what: "upstream rejected the request",
  },
  {
    when: (s) =>
      (s.status !== null && s.status >= 500 && s.status < 600) ||
      /bad gateway|service unavailable|internal server error|gateway timeout/.test(s.haystack),
    code: "gateway.5xx.upstream",
    severity: "error",
    layer: "gateway",
    what: "upstream server failure",
  },
  {
    when: (s) =>
      /econnrefused|econnreset|eai_again|etimedout|enotfound|ehostunreach|enetunreach|epipe|socket hang up|connection (refused|reset|closed|lost)|fetch failed/.test(
        s.haystack,
      ),
    code: "network.connection_failed",
    severity: "warning",
    layer: "host",
    what: "network connection failed",
  },
  {
    when: (s) => /\btimed out\b|timeout|deadline exceeded/.test(s.haystack),
    code: "execution.timeout",
    severity: "error",
    layer: "worker",
    what: "operation timed out",
  },
  { when: () => true, code: UNKNOWN_ERROR_CODE, severity: "warning", layer: "process", what: "unclassified failure" },
];

export function normalizeError(input: UnknownErrorInput | unknown, ctx: NormalizationContext): ErrorOccurrence {
  let s: Signal = { haystack: "", status: null, exit: null, detail: "" };
  let refs: string[] = [];
  let ids: string[] = [];
  const field = (value: unknown): string | null => printable(value, 200) || null; // evidence is read first, so an unreadable shape cannot lose it
  try {
    const raw =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : { message: String(input) };
    refs = [
      ...(storable(raw.evidenceRef) ? [raw.evidenceRef] : []),
      ...(Array.isArray(raw.artifactRefs) ? raw.artifactRefs : []),
    ].filter(storable);
    ids = [
      ...new Set(
        [
          ...(Array.isArray(raw.correlationIds) ? raw.correlationIds : []),
          ...(Array.isArray(ctx.correlationIds) ? ctx.correlationIds : []),
        ]
          .map((id) => printable(id, 200))
          .filter((id) => id !== ""),
      ),
    ].slice(0, 32);
    const msg =
      [raw.message, raw.error, raw.detail, raw.text, raw.reason, raw.summary]
        .map((value) => printable(value, 400))
        .find((value) => value !== "") ?? "";
    const hints = [printable(raw.code, 40), printable(raw.signal, 40)].filter((part) => part !== ""); // errno or fatal signal: evidence worth reading, not just matching
    const haystack = [
      ...new Set(
        [printable(raw.kind ?? raw.type ?? raw.category, 80), ...hints, msg, printable(raw.stderr, 400)].filter(
          (part) => part !== "",
        ),
      ),
    ]
      .join(" ")
      .toLowerCase(); // Set over strings: stable, first-write wins
    const status =
      numeric(raw.httpStatus ?? raw.status ?? raw.statusCode) ??
      numeric(/(?:\b(?:https?|status|error|response)[^0-9a-z]{0,3}|^[^0-9a-z]{0,3})([45]\d\d)\b/i.exec(haystack)?.[1]);
    const exit = numeric(raw.exitCode ?? raw.exit_status);
    s = {
      haystack,
      status,
      exit,
      detail: [
        ...new Set(
          [
            status !== null ? `http ${status}` : "",
            exit !== null ? `exit ${exit}` : "",
            ...hints,
            msg,
            printable(raw.stderr, 400),
          ].filter((part) => part !== ""),
        ),
      ].join("; "),
    };
  } catch {
    /* a throwing getter is still an event: keep whatever evidence survived and record it under the unknown code */
  }
  let rule = RULES[RULES.length - 1]!;
  for (const candidate of RULES)
    if (candidate.when(s)) {
      rule = candidate;
      break;
    }
  const stamp = printable(ctx.timestamp, 40); // the table ends in a catch-all, so walk order is precedence
  return {
    version: ERROR_OCCURRENCE_VERSION,
    timestamp: ISO_8601.test(stamp) ? stamp : EPOCH,
    host: printable(ctx.host, 200) || UNATTRIBUTED,
    sessionId: printable(ctx.sessionId, 200) || UNATTRIBUTED,
    runtime: printable(ctx.runtime, 200) || UNATTRIBUTED,
    layer: ctx.layer !== undefined && ERROR_LAYERS.includes(ctx.layer) ? ctx.layer : rule.layer,
    code: rule.code,
    severity: rule.severity,
    summary: printable(`${rule.what}${s.detail === "" ? "" : `: ${s.detail}`}`, 500) || rule.code, // redacted exactly the way E02 requires of a summary; the detail keeps the shape
    runId: field(ctx.runId),
    taskId: field(ctx.taskId),
    model: field(ctx.model),
    quantization: field(ctx.quantization),
    correlationIds: ids.length > 0 ? ids : [UNATTRIBUTED], // a gap is recorded, never invented
    artifactRefs: [
      ...new Set([...refs, ...(Array.isArray(ctx.artifactRefs) ? ctx.artifactRefs : []).filter(storable)]),
    ], // original evidence first, unchanged
  };
}
