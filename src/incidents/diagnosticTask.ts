// D08: a bounded diagnostic *task package* over D07's bundle — what a local model must be handed to explain an
// incident, and the answer shape it must return. Pure and deterministic: no fs, no network, no clock, no RNG, no
// mutation of the caller's bundle, and identical inputs serialize byte-identically. Nothing here dispatches:
// `modelHint` is a hint string naming a route this repo already names (src/models/aliasCatalog.ts,
// src/plannerWorker/roles.ts), never a client, and this module imports no provider, router or transport. The bundle
// is carried by reference and never re-derived, so the package and the bundle cannot disagree about an id.
import { DEFAULT_MAX_BYTES, type EvidenceBundle, type EvidenceItem } from "./evidenceBundle.ts";

export type { ErrorOccurrence } from "./errorEvent.ts";
export type { AggregateRow } from "./errorAggregate.ts"; // D01's envelope and D03's row, forwarded so a consumer needs only this module

export const TASK_VERSION = 1;
export const DEFAULT_TASK_MAX_BYTES = DEFAULT_MAX_BYTES; // the ceiling D07 gives the bundle, so the package is never tighter than what it carries
export const MODEL_HINTS = ["metabolomics/qwen3.8-flash_next", "metabolomics/qwen3.8-27b"] as const; // Qwen Flash / 27B route names; a hint is a name, never a client and never a call
export type DiagnosticModelHint = (typeof MODEL_HINTS)[number];
export const DEFAULT_MODEL_HINT: DiagnosticModelHint = MODEL_HINTS[0];
export const REQUIRED_FIELDS = [
  "hypothesis",
  "supportingEventIds",
  "disconfirmingEvidence",
  "uncertainty",
  "furtherEvidence",
] as const;
export type DiagnosticField = (typeof REQUIRED_FIELDS)[number];
export const SECTIONS: Readonly<Record<DiagnosticField, string>> = {
  hypothesis: "HYPOTHESIS",
  supportingEventIds: "SUPPORTING_EVENTS",
  disconfirmingEvidence: "DISCONFIRMING_EVIDENCE",
  uncertainty: "UNCERTAINTY",
  furtherEvidence: "FURTHER_EVIDENCE",
};
export const ANSWER_LINES: Readonly<Record<DiagnosticField, string>> = {
  hypothesis: "one cause the evidence supports, stated as a claim — never a restatement of an item's summary",
  supportingEventIds: "the supporting event ids, comma-separated, every one named in EVIDENCE_IDS",
  disconfirmingEvidence: "the evidence that argues against the hypothesis, or NONE",
  uncertainty: "what the supplied evidence cannot decide",
  furtherEvidence: "what further evidence would change the verdict",
};
export const CONSTRAINTS: readonly string[] = [
  "read-only diagnosis: report what the supplied evidence shows and change nothing",
  "no source modification: do not edit, create or delete source, configuration, persisted data or evidence",
  "no self-repair: do not propose or apply a fix, patch, retry, re-run or rollback",
  "no automatic dispatch: nothing in this package calls a model; a human or a later orchestrator hands it over",
  "no new tooling: do not propose a script, dependency, endpoint or command to run",
  "answer from the supplied evidence only: anything outside the bundle is unknown, not guessable",
  "name every evidence id you rely on; an id absent from EVIDENCE_IDS is refused",
];
export const DEFAULT_QUESTION = "Diagnose the incident cause behind the supplied evidence.";
export interface DiagnosticLimits {
  maxBytes?: number;
}
export interface DiagnosticTaskInput {
  bundle: EvidenceBundle;
  question?: string;
  modelHint?: string;
}
export interface DiagnosticTask {
  version: number;
  modelHint: string;
  hintFallback: boolean;
  systemContract: string;
  prompt: string;
  requiredFields: DiagnosticField[];
  constraints: string[];
  evidenceIds: string[];
  fingerprints: string[];
  maxBytes: number;
  bytes: number;
  truncated: boolean;
  dropped: { items: number; bytes: number };
}
export interface DiagnosticAnswer {
  hypothesis: string;
  supportingEventIds: string[];
  disconfirmingEvidence: string;
  uncertainty: string;
  furtherEvidence: string;
}
export type DiagnosticResponse = { ok: true; answer: DiagnosticAnswer } | { ok: false; reasons: string[] };

const FORMAT: string = REQUIRED_FIELDS.map((field) => `${SECTIONS[field]}: ${ANSWER_LINES[field]}`).join("\n");
const SECTION = new RegExp(`^(${Object.values(SECTIONS).join("|")}):[ \\t]*(.*)$`); // the answer shape is required in words as well as by the validator; one label per line, its body may continue below
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const norm = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim(); // the summary-restatement test compares content, not punctuation
const itemsOf = (bundle: EvidenceBundle | undefined): EvidenceItem[] =>
  Array.isArray(bundle?.items) ? bundle.items : [];
const uniq = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** Build the package: role + hard prohibitions, the bounded evidence prompt (the bundle itself, by reference), the required answer fields and a byte account. `maxBytes` is honoured over the whole package; when it bites, trailing bundle items (the bundle's own total order) are withheld and reported in `dropped`, never silently trimmed. */
export function buildDiagnosticTask(input: DiagnosticTaskInput, limits: DiagnosticLimits = {}): DiagnosticTask {
  const maxBytes =
    Number.isInteger(limits.maxBytes) && (limits.maxBytes as number) >= 1
      ? (limits.maxBytes as number)
      : DEFAULT_TASK_MAX_BYTES; // a bad cap falls back to the default; it never means unbounded
  const asked = str(input?.modelHint);
  const hint = (MODEL_HINTS as readonly string[]).includes(asked) ? asked : DEFAULT_MODEL_HINT;
  const hintFallback = asked !== "" && asked !== hint; // an unknown route is refused as a hint and recorded, never quietly used
  const question =
    str(input?.question) !== "" && /^[\x20-\x7e\n]+$/.test(str(input?.question))
      ? str(input.question)
      : DEFAULT_QUESTION; // printable prose only, so the prompt cannot smuggle control sequences to a terminal
  const all = itemsOf(input?.bundle);
  const version = Number.isInteger(input?.bundle?.version) ? (input?.bundle?.version as number) : 0;
  const systemContract = `You are a read-only incident diagnostician for one evidence bundle (v${version}). ${CONSTRAINTS.join("; ")}. Answer only in the sections ${REQUIRED_FIELDS.map((f) => SECTIONS[f]).join(", ")}, each non-empty, and name the evidence ids you rely on.`;
  const render = (kept: readonly EvidenceItem[]): string =>
    `${question}\n\nEVIDENCE_IDS=${uniq(kept.flatMap((i) => (Array.isArray(i?.eventIds) ? i.eventIds : []))).join(",")}\n\nEVIDENCE (bundle items carried by reference, ${kept.length} of ${all.length}):\n${JSON.stringify(kept)}\n\nANSWER FORMAT (every section required; refuse rather than invent):\n${FORMAT}`;
  const shape = (kept: readonly EvidenceItem[]): DiagnosticTask => ({
    version: TASK_VERSION,
    modelHint: hint,
    hintFallback,
    systemContract,
    prompt: render(kept),
    requiredFields: [...REQUIRED_FIELDS],
    constraints: [...CONSTRAINTS],
    evidenceIds: uniq(kept.flatMap((i) => (Array.isArray(i?.eventIds) ? i.eventIds : []))),
    fingerprints: uniq(kept.map((i) => str(i?.fingerprint))),
    maxBytes,
    bytes: 0,
    truncated: false,
    dropped: { items: 0, bytes: 0 },
  });
  const sizeOf = (kept: readonly EvidenceItem[]): number =>
    Buffer.byteLength(
      JSON.stringify({
        ...shape(kept),
        bytes: 999999999,
        truncated: true,
        dropped: { items: 999999999, bytes: 999999999 },
      }),
      "utf8",
    ); // the account fields at their widest, so a reported fit is always a real fit
  const kept = [...all];
  while (kept.length > 0 && sizeOf(kept) > maxBytes) kept.pop();
  const bytes = sizeOf(kept);
  const dropped = { items: all.length - kept.length, bytes: Math.max(0, sizeOf(all) - bytes) }; // the copy pops, so the caller's bundle array is never touched, and the withheld weight is counted, not guessed
  return { ...shape(kept), bytes, truncated: dropped.items > 0 || bytes > maxBytes, dropped }; // a cap no item satisfies still reports truncated, with bytes > maxBytes visible in the account
}

/** Read the answer back. Fail-closed by construction: text that is not text, prose outside the named sections, a missing / duplicated / empty section, an event id the bundle never supplied, a hypothesis that only restates an item's summary, or an unusable bundle is refused with a stable reason list. Nothing missing is repaired or invented. */
export function parseDiagnosticResponse(text: unknown, bundle: EvidenceBundle): DiagnosticResponse {
  if (typeof text !== "string") return { ok: false, reasons: ["not_text"] };
  const items = itemsOf(bundle);
  const known = new Set(items.flatMap((i) => (Array.isArray(i?.eventIds) ? i.eventIds : [])));
  const reasons: string[] = [];
  const bodies = new Map<string, string>();
  const value = {} as Record<DiagnosticField, string>;
  let current = "";
  let prologue = "";
  for (const line of text.split(/\r?\n/)) {
    const m = SECTION.exec(line);
    if (m?.[1] !== undefined) {
      if (bodies.has(m[1])) reasons.push(`duplicate_section:${m[1]}`);
      bodies.set(m[1], str(m[2]).trim());
      current = m[1];
    } // last body wins, but the duplicate is a refusal either way
    else if (current === "") {
      if (line.trim() !== "") prologue = line;
    } else bodies.set(current, `${bodies.get(current) ?? ""} ${line}`.trim());
  }
  if (prologue !== "") reasons.push("unlabelled_text"); // a preamble is an unrequested section
  for (const field of REQUIRED_FIELDS) {
    const body = bodies.get(SECTIONS[field]);
    if (body === undefined) {
      reasons.push(`missing_section:${SECTIONS[field]}`);
      value[field] = "";
      continue;
    }
    if (body === "") reasons.push(`empty_section:${SECTIONS[field]}`);
    value[field] = body;
  }
  const ids = uniq(
    value.supportingEventIds
      .split(/[,\s]+/)
      .map((id) => id.replace(/[.;:]+$/, ""))
      .filter((id) => id !== ""),
  );
  for (const id of ids) if (!known.has(id)) reasons.push(`unknown_event_id:${id}`); // an id outside the bundle is never truncated into something plausible
  const summaries = new Set(items.map((i) => norm(str(i?.summary))).filter((s) => s !== ""));
  if (norm(value.hypothesis) !== "" && summaries.has(norm(value.hypothesis)))
    reasons.push("hypothesis_restates_summary");
  if (items.length === 0) reasons.push("evidence_bundle_unusable"); // with no evidence there is no answer to accept
  if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)] };
  return {
    ok: true,
    answer: {
      hypothesis: value.hypothesis,
      supportingEventIds: ids,
      disconfirmingEvidence: value.disconfirmingEvidence,
      uncertainty: value.uncertainty,
      furtherEvidence: value.furtherEvidence,
    },
  };
}
