/**
 * Pure normalization of ledger / mission-store events and report objects into a
 * stable "golden record". Everything nondeterministic (generated ids, clocks,
 * durations, temp roots, commit SHAs, content hashes) is replaced by a
 * placeholder or dropped; everything structural (event type sequence, actor
 * type, key payload enums, id relationships) is kept.
 *
 * Ids become ordinal placeholders per prefix in first-seen order, so the same
 * entity keeps the same placeholder everywhere in one record: `WI-6GiMT8`
 * becomes `<WI#1>`, the next distinct work item `<WI#2>`.
 */

/** Object keys whose value is volatile by nature and is dropped outright. */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "timestamp",
  "created_at",
  "updated_at",
  "started_at",
  "finished_at",
  "completed_at",
  "durationMs",
  "duration_ms",
  "startedAt",
  "finishedAt",
  "createdAt",
  "updatedAt",
]);

/** Payload keys that carry a stable, enum-like fact worth pinning. */
const KEY_FIELDS: ReadonlySet<string> = new Set([
  "status",
  "outcome",
  "verdict",
  "decision",
  "role",
  "severity",
  "kind",
  "action",
  "category",
  "trust",
  "from",
  "to",
  "exit_code",
  "exitStatus",
  "passed",
  "completed",
]);

/**
 * Every prefix src/ passes to `id()` (src/core/ids.ts), plus the entity kinds
 * `newEntityId` upper-cases. Restricting the pattern to this list keeps words
 * such as `HIGH-abcdef` out of the id table.
 */
const ID_PREFIXES: readonly string[] = [
  "evt",
  "obsevt",
  "oevt",
  "aps",
  "dur",
  "mem",
  "promo",
  "AC",
  "ACK",
  "APSSESS",
  "ART",
  "BARAUDIT",
  "BARREQ",
  "BARSCOPE",
  "BLK",
  "CAND",
  "CAVEVID",
  "CTX",
  "DEFECT",
  "DSE",
  "EI",
  "EVID",
  "EXC",
  "F",
  "FC",
  "HERD",
  "MCP",
  "MEM",
  "MSN",
  "PLAN",
  "PRJ",
  "RCV",
  "RE",
  "REPO",
  "RT",
  "RUN",
  "RVS",
  "SUP",
  "TASK",
  "TCP",
  "TSK",
  "VE",
  "WI",
  "WKS",
  "WRK",
  "WS",
  // entity kinds (Ledger.createEntity -> newEntityId)
  "REQUIREMENT",
  "INVARIANT",
  "FACT",
  "HYPOTHESIS",
  "DECISION",
  "FINDING",
  "TESTOB",
];

/** `WI-6GiMT8`, `evt-AbC123`, `REQUIREMENT-o2kjOi`, `MSN-0wDA7O`: a known prefix and six base-62 characters. */
const ID_PATTERN = new RegExp(`\\b(${ID_PREFIXES.join("|")})-([0-9A-Za-z]{6})\\b`, "g");
const SHA_PATTERN = /\b[0-9a-f]{40}\b/g;
const HASH_PATTERN = /\bsha256:[0-9a-f]{64}\b/g;
/** Repository ids are a hash of the repository path, so they differ per checkout and temp dir. */
const REPO_ID_PATTERN = /\brepo-[0-9a-f]{16}\b/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

export interface Normalizer {
  /** Normalize one string: ids, roots, SHAs, hashes, uuids. */
  text(input: string): string;
  /** Deep-normalize any JSON-like value; volatile keys are dropped, object keys are sorted. */
  value(input: unknown): unknown;
  /** Mask one more root (e.g. a fixture directory) in all later output. */
  addRoot(root: string): void;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A fresh normalizer; its id table lives as long as the object, i.e. one record. */
export function createNormalizer(roots: readonly string[] = []): Normalizer {
  const ordinals = new Map<string, Map<string, number>>();
  // Longest root first so `/tmp/a/b` is replaced before `/tmp/a`.
  const known = new Set(roots.filter((r) => r.length > 0));
  const sortedRoots = (): string[] => [...known].sort((a, b) => b.length - a.length);
  const addRoot = (root: string): void => {
    if (root.length > 0) known.add(root);
  };

  const text = (input: string): string => {
    let out = input;
    for (const root of sortedRoots()) out = out.split(root).join("<ROOT>");
    out = out
      .replace(HASH_PATTERN, "<HASH>")
      .replace(SHA_PATTERN, "<SHA>")
      .replace(REPO_ID_PATTERN, "<REPO>")
      .replace(UUID_PATTERN, "<UUID>");
    return out.replace(ID_PATTERN, (_m, prefix: string, suffix: string) => {
      let byId = ordinals.get(prefix);
      if (!byId) {
        byId = new Map();
        ordinals.set(prefix, byId);
      }
      let n = byId.get(suffix);
      if (n === undefined) {
        n = byId.size + 1;
        byId.set(suffix, n);
      }
      return `<${prefix}#${n}>`;
    });
  };

  const value = (input: unknown): unknown => {
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map(value);
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        if (VOLATILE_KEYS.has(key) || key.endsWith("_at")) continue;
        out[key] = value((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };

  return { text, value, addRoot };
}

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/**
 * Collect the stable facts of a payload as `{ "candidate.status": "ELIGIBLE" }`:
 * enum-like keys (see KEY_FIELDS), any `*_id` reference, id lists (`*_ids`,
 * kept in order) and the length of every other array, at most four levels deep. Free text, diffs, prompts and summaries are deliberately not recorded.
 */
export function keyFacts(payload: unknown, norm: Normalizer, prefix = "", depth = 0): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  if (payload === null || typeof payload !== "object" || Array.isArray(payload) || depth > 3) return out;
  for (const key of Object.keys(payload).sort()) {
    const v = (payload as Record<string, unknown>)[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (isScalar(v) && (KEY_FIELDS.has(key) || key.endsWith("_id") || key === "id")) {
      out[path] = typeof v === "string" ? norm.text(v) : v;
    } else if (Array.isArray(v)) {
      // Id lists keep their members in order; every other list is pinned by its length.
      out[path] =
        /ids$/i.test(key) && v.every(isScalar) ? v.map((m) => (typeof m === "string" ? norm.text(m) : m)) : v.length;
    } else if (v !== null && typeof v === "object") {
      Object.assign(out, keyFacts(v, norm, path, depth + 1));
    }
  }
  return out;
}

/** The shape of both a ledger line and a mission-store event, as far as the golden record cares. */
export interface RawEvent {
  type: string;
  work_item_id?: string | null;
  project_id?: string | null;
  actor?: { type?: string } | null;
  payload?: unknown;
}

export interface NormalizedEvent {
  type: string;
  actor?: string;
  work_item?: string;
  facts: Record<string, JsonValue>;
}

/** Normalize an event list in order. Share one `norm` across a whole record so ordinals stay consistent. */
export function normalizeEvents(events: readonly RawEvent[], norm: Normalizer): NormalizedEvent[] {
  return events.map((e) => {
    const out: NormalizedEvent = { type: e.type, facts: keyFacts(e.payload, norm) };
    if (e.actor?.type) out.actor = e.actor.type;
    const scope = e.work_item_id ?? e.project_id;
    if (scope) out.work_item = norm.text(scope);
    return out;
  });
}

/**
 * Parse a `.jsonl` ledger body. Only an unparseable FINAL line is tolerated (a torn
 * tail); a corrupt line anywhere else is real damage and throws. `tornLinesExpected`
 * is for a ledger that was deliberately torn and then appended to: the store starts
 * the next record on a fresh line, so the torn fragment stays mid-file and is skipped.
 */
export function parseLedger(body: string, opts: { tornLinesExpected?: boolean } = {}): RawEvent[] {
  const lines = body.split("\n").map((text, i) => ({ text, no: i + 1 }));
  const used = lines.filter((l) => l.text.trim() !== "");
  const last = used.at(-1);
  const events: RawEvent[] = [];
  for (const line of used) {
    try {
      events.push(JSON.parse(line.text) as RawEvent);
    } catch (err) {
      if (line === last || opts.tornLinesExpected) continue;
      throw new Error(`corrupt ledger line ${line.no} (not the final line): ${(err as Error).message}`);
    }
  }
  return events;
}

/** Deterministic JSON text: sorted keys come from `value()`, two-space indent, trailing newline. */
export function stableStringify(input: unknown): string {
  return `${JSON.stringify(input, null, 2)}\n`;
}
