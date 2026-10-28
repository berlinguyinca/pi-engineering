/**
 * Constitution quality-law mapping (T04). PURE.
 *
 * The Constitution repo ships a quality-gate SCHEMA (name, purpose,
 * required_evidence, pass_fail_criteria, applies_to_profiles) and profiles that
 * list `quality_gates` by name. This turns the configured profile + gate
 * definitions (+ baseline pack `qualityGates` prose) into a checklist for
 * Pi's finalization output. It is informational: nothing here is evidence, and
 * nothing is ever reported as passed.
 */

export interface QualityGateDef {
  name: string;
  purpose: string;
  required_evidence: string[];
  pass_fail_criteria: string[];
  applies_to_profiles: string[];
}

export interface QualityLawItem {
  name: string;
  purpose: string | null;
  requiredEvidence: string[];
  criteria: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | null =>
  v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;

/** Validate one quality-gate.schema.json document; null when it does not conform. */
export function parseQualityGate(raw: unknown): QualityGateDef | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.name !== "string" || typeof raw.purpose !== "string") return null;
  const evidence = strings(raw.required_evidence);
  const criteria = strings(raw.pass_fail_criteria);
  const profiles = strings(raw.applies_to_profiles);
  if (
    !evidence ||
    !criteria ||
    !profiles ||
    raw.required_evidence === undefined ||
    raw.pass_fail_criteria === undefined
  )
    return null;
  return {
    name: raw.name,
    purpose: raw.purpose,
    required_evidence: evidence,
    pass_fail_criteria: criteria,
    applies_to_profiles: profiles,
  };
}

export interface QualityLawInput {
  /** profile.schema.json document (for `quality_gates` names), if configured. */
  profile?: unknown;
  profileId?: string;
  gates: readonly unknown[];
}

export interface QualityLawResult {
  items: QualityLawItem[];
  /** Problems with the inputs (shown, never silently dropped). */
  notes: string[];
}

export function mapQualityLaw(input: QualityLawInput): QualityLawResult {
  const notes: string[] = [];
  const defs = new Map<string, QualityGateDef>();
  input.gates.forEach((g, i) => {
    const def = parseQualityGate(g);
    if (!def) notes.push(`quality gate definition #${i + 1} does not match quality-gate.schema.json; ignored`);
    else defs.set(def.name, def);
  });
  let wanted: string[] | null = null;
  if (input.profile !== undefined) {
    const names = isRecord(input.profile) ? strings(input.profile.quality_gates) : null;
    if (!names) notes.push("profile has no valid quality_gates list; falling back to every applicable definition");
    else wanted = names;
  }
  const names = wanted ?? [...defs.keys()].sort();
  const items: QualityLawItem[] = [];
  for (const name of names) {
    const def = defs.get(name);
    if (!def) {
      items.push({ name, purpose: null, requiredEvidence: [], criteria: [] });
      continue;
    }
    if (input.profileId && def.applies_to_profiles.length > 0 && !def.applies_to_profiles.includes(input.profileId))
      continue;
    items.push({
      name,
      purpose: def.purpose,
      requiredEvidence: def.required_evidence,
      criteria: def.pass_fail_criteria,
    });
  }
  return { items, notes };
}

export function qualityLawChecklist(result: QualityLawResult): string[] {
  if (result.items.length === 0 && result.notes.length === 0) return [];
  const lines = ["Quality law (Constitution; informational, not verified):"];
  for (const i of result.items) {
    lines.push(`  [not verified] ${i.name}${i.purpose ? `: ${i.purpose}` : " (no definition available)"}`);
    if (i.requiredEvidence.length) lines.push(`    evidence: ${i.requiredEvidence.join("; ")}`);
    if (i.criteria.length) lines.push(`    criteria: ${i.criteria.join("; ")}`);
  }
  for (const n of result.notes) lines.push(`  note: ${n}`);
  return lines;
}
