/**
 * Versioned UI genome + design-entropy analyzer + contract injection
 * (docs/specs/autonomous-ui-engineering/pi-engineering/04-ui-genome.md).
 *
 * A UI genome is a persistent, versioned model of a product's UI design system.
 * It maintains a `.ui/` directory holding named YAML contracts:
 *
 *   constitution.yaml, tokens.yaml, typography.yaml, colors.yaml, spacing.yaml,
 *   breakpoints.yaml, components.yaml, terminology.yaml,
 *   interaction-patterns.yaml, responsive-contract.yaml,
 *   accessibility-contract.yaml, task-catalog.yaml, exceptions.yaml,
 *   and an approved-reference/ directory.
 *
 * The genome carries a semantic version (`UiGenome.version`) plus typed
 * contract interfaces. It is loaded/saved via `loadGenome`/`saveGenome`
 * (using the repo's `yaml` dependency) and validated by `validateGenome`.
 *
 * Two companion features live here:
 *  1. A deterministic design-entropy analyzer
 *     (`analyzeGenomeEntropy`) that computes normalized Shannon entropy across
 *     structured style-usage counts and maps it onto the rubric metric id
 *     `design_entropy` (src/uieng/rubric.ts), returning a typed
 *     `AnalysisResult` (src/uieng/evidence.ts).
 *  2. A contract-injection helper (`injectGenomeContracts`) that, given a
 *     `UiProfile` (src/uieng/discovery.ts) and a genome, returns the relevant
 *     contract YAML/docs text for automatic injection into implementation and
 *     review task prompts. Only human-approved or experimentally supported
 *     rules become constitutional; everything else is advisory.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { UiProfile } from "./discovery.ts";
import type { AnalysisResult } from "./evidence.ts";
import { assertMetricKnown } from "./rubric.ts";

/** Current UI genome model version. Bump whenever the contract shapes change. */
export const GENOME_VERSION = 1;

/** The `.ui/` directory that hosts a genome's contracts. */
export const GENOME_DIR_NAME = ".ui";

/** Subdirectory holding approved reference material (snapshots, screenshots). */
export const APPROVED_REFERENCE_DIR = "approved-reference";

/** Manifest file that records the genome version. */
export const GENOME_MANIFEST_FILE = "genome.yaml";

/**
 * All named YAML contracts a genome maintains inside `.ui/`, in canonical order.
 * The `approved-reference/` directory is maintained alongside these files.
 */
export const GENOME_CONTRACT_NAMES = [
  "constitution.yaml",
  "tokens.yaml",
  "typography.yaml",
  "colors.yaml",
  "spacing.yaml",
  "breakpoints.yaml",
  "components.yaml",
  "terminology.yaml",
  "interaction-patterns.yaml",
  "responsive-contract.yaml",
  "accessibility-contract.yaml",
  "task-catalog.yaml",
  "exceptions.yaml",
] as const;

// ---------------------------------------------------------------------------
// Typed contract interfaces
// ---------------------------------------------------------------------------

/** A single constitutional rule with an explicit approval flag. */
export interface ConstitutionRule {
  id: string;
  title: string;
  description?: string;
  /** True when human-approved or experimentally supported -> constitutional. */
  approved: boolean;
  experimental?: boolean;
  /** Contract file names this rule governs (e.g. ["colors.yaml"]). */
  contracts?: string[];
  rationale?: string;
}

/** constitution.yaml — the genome's rule of law. */
export interface ConstitutionContract {
  version: number;
  /** Canonical list of constitutional (approved) rule ids. */
  approved_rule_ids: string[];
  rules: ConstitutionRule[];
}

/** tokens.yaml — design token buckets. */
export interface TokensContract {
  prefix?: string;
  colors?: Record<string, string>;
  spacing?: Record<string, string>;
  radii?: Record<string, string>;
  fonts?: Record<string, string>;
  /** Unstructured token extensions not covered by the typed buckets. */
  raw?: Record<string, unknown>;
}

/** colors.yaml — palette + semantic mapping. */
export interface ColorSwatch {
  name: string;
  value: string;
  role?: string;
}
export interface ColorsContract {
  palette: ColorSwatch[];
  semantic: Record<string, string>;
  contrast_guidelines?: string;
}

/** spacing.yaml — spacing scale. */
export interface SpacingToken {
  name: string;
  value: number;
  unit?: string;
  usage?: string;
}
export interface SpacingContract {
  base_unit?: string;
  scale: SpacingToken[];
  guidelines?: string;
}

/** breakpoints.yaml — responsive breakpoints. */
export interface Breakpoint {
  name: string;
  width: number;
  unit?: string;
}
export interface BreakpointsContract {
  breakpoints: Breakpoint[];
  strategy?: string;
}

/** typography.yaml — font families + type scale. */
export interface TypeScaleToken {
  name: string;
  size: number;
  line_height?: number;
  weight?: number;
  usage?: string;
}
export interface TypographyContract {
  families: string[];
  scale: TypeScaleToken[];
}

/** components.yaml — reusable component contracts. */
export interface ComponentContract {
  name: string;
  description: string;
  tokens: string[];
  patterns?: string[];
}
export interface ComponentsContract {
  components: ComponentContract[];
}

/** terminology.yaml — authoritative product vocabulary. */
export interface Term {
  term: string;
  definition: string;
  usage?: string;
}
export interface TerminologyContract {
  terms: Term[];
}

/** interaction-patterns.yaml — named interaction patterns. */
export interface InteractionPattern {
  name: string;
  description: string;
  states: string[];
}
export interface InteractionPatternContract {
  patterns: InteractionPattern[];
}

/** responsive-contract.yaml — responsive behavior contract. */
export interface ResponsiveContract {
  mobile_first?: boolean;
  breakpoints: string[];
  reflow?: string;
}

/** accessibility-contract.yaml — accessibility baseline. */
export interface AccessibilityContract {
  wcag_target?: string;
  contrast_aa?: boolean;
  touch_minimum?: number;
  focus_visible?: boolean;
  reduced_motion?: boolean;
  landmarks?: string[];
}

/** task-catalog.yaml — representative UI tasks. */
export interface UiTask {
  id: string;
  title: string;
  description: string;
  steps: string[];
}
export interface TaskCatalogContract {
  tasks: UiTask[];
}

/** exceptions.yaml — documented exceptions to contracts. */
export interface ContractException {
  id: string;
  contract: string;
  reason: string;
  approved: boolean;
}
export interface ExceptionsContract {
  exceptions: ContractException[];
}

/** Union of all typed contract payloads keyed by their genome contract key. */
export interface GenomeContracts {
  constitution?: ConstitutionContract;
  tokens?: TokensContract;
  typography?: TypographyContract;
  colors?: ColorsContract;
  spacing?: SpacingContract;
  breakpoints?: BreakpointsContract;
  components?: ComponentsContract;
  terminology?: TerminologyContract;
  "interaction-patterns"?: InteractionPatternContract;
  "responsive-contract"?: ResponsiveContract;
  "accessibility-contract"?: AccessibilityContract;
  "task-catalog"?: TaskCatalogContract;
  exceptions?: ExceptionsContract;
}

/** The versioned UI genome: a version plus the named contract set. */
export interface UiGenome {
  /** Semantic version of the genome model. */
  version: number;
  contracts: GenomeContracts;
}

export type GenomeContractKey = keyof GenomeContracts;

/** Canonical key -> file name mapping for every genome contract. */
export const GENOME_CONTRACT_FILES: Readonly<Record<GenomeContractKey, string>> = {
  constitution: "constitution.yaml",
  tokens: "tokens.yaml",
  typography: "typography.yaml",
  colors: "colors.yaml",
  spacing: "spacing.yaml",
  breakpoints: "breakpoints.yaml",
  components: "components.yaml",
  terminology: "terminology.yaml",
  "interaction-patterns": "interaction-patterns.yaml",
  "responsive-contract": "responsive-contract.yaml",
  "accessibility-contract": "accessibility-contract.yaml",
  "task-catalog": "task-catalog.yaml",
  exceptions: "exceptions.yaml",
};

export const GENOME_CONTRACT_KEYS: readonly GenomeContractKey[] = Object.keys(
  GENOME_CONTRACT_FILES,
) as GenomeContractKey[];

// ---------------------------------------------------------------------------
// Genome store (load/save/validate over the `yaml` package)
// ---------------------------------------------------------------------------

/** Absolute path to the `.ui/` directory for a given repo root. */
export function genomeDirPath(root: string): string {
  return join(root, GENOME_DIR_NAME);
}

/** Result of validating a genome for well-formedness. */
export interface GenomeValidation {
  valid: boolean;
  version: number;
  contract_count: number;
  issues: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate a single typed contract payload; pushes issue strings. */
function validateContract(key: GenomeContractKey, contract: unknown, issues: string[]): void {
  if (!isRecord(contract)) {
    issues.push(`contract ${key}: expected an object`);
    return;
  }
  const path = `contract ${key}`;
  if (key === "colors") {
    const c = contract as unknown as ColorsContract;
    if (!Array.isArray(c.palette)) issues.push(`${path}: missing "palette" array`);
    else
      for (const swatch of c.palette)
        if (!isRecord(swatch) || typeof swatch.name !== "string" || typeof swatch.value !== "string")
          issues.push(`${path}: palette swatch must have string name+value`);
  } else if (key === "spacing") {
    const c = contract as unknown as SpacingContract;
    if (!Array.isArray(c.scale)) issues.push(`${path}: missing "scale" array`);
    else
      for (const t of c.scale)
        if (!isRecord(t) || typeof t.name !== "string" || typeof t.value !== "number")
          issues.push(`${path}: scale token must have string name + number value`);
  } else if (key === "breakpoints") {
    const c = contract as unknown as BreakpointsContract;
    if (!Array.isArray(c.breakpoints)) issues.push(`${path}: missing "breakpoints" array`);
    else
      for (const bp of c.breakpoints)
        if (!isRecord(bp) || typeof bp.name !== "string" || typeof bp.width !== "number")
          issues.push(`${path}: breakpoint must have string name + number width`);
  } else if (key === "typography") {
    const c = contract as unknown as TypographyContract;
    if (!Array.isArray(c.families)) issues.push(`${path}: missing "families" array`);
    if (!Array.isArray(c.scale)) issues.push(`${path}: missing "scale" array`);
    else
      for (const t of c.scale)
        if (!isRecord(t) || typeof t.name !== "string" || typeof t.size !== "number")
          issues.push(`${path}: scale token must have string name + number size`);
  } else if (key === "components") {
    const c = contract as unknown as ComponentsContract;
    if (!Array.isArray(c.components)) issues.push(`${path}: missing "components" array`);
    else
      for (const comp of c.components)
        if (!isRecord(comp) || typeof comp.name !== "string") issues.push(`${path}: component must have a string name`);
  } else if (key === "terminology") {
    const c = contract as unknown as TerminologyContract;
    if (!Array.isArray(c.terms)) issues.push(`${path}: missing "terms" array`);
    else
      for (const term of c.terms)
        if (!isRecord(term) || typeof term.term !== "string" || typeof term.definition !== "string")
          issues.push(`${path}: term must have string term+definition`);
  } else if (key === "interaction-patterns") {
    const c = contract as unknown as InteractionPatternContract;
    if (!Array.isArray(c.patterns)) issues.push(`${path}: missing "patterns" array`);
    else
      for (const p of c.patterns)
        if (!isRecord(p) || typeof p.name !== "string") issues.push(`${path}: pattern must have a string name`);
  } else if (key === "responsive-contract") {
    const c = contract as unknown as ResponsiveContract;
    if (!Array.isArray(c.breakpoints)) issues.push(`${path}: missing "breakpoints" array`);
  } else if (key === "task-catalog") {
    const c = contract as unknown as TaskCatalogContract;
    if (!Array.isArray(c.tasks)) issues.push(`${path}: missing "tasks" array`);
    else
      for (const task of c.tasks)
        if (!isRecord(task) || typeof task.id !== "string" || typeof task.title !== "string")
          issues.push(`${path}: task must have string id+title`);
  } else if (key === "constitution") {
    const c = contract as unknown as ConstitutionContract;
    if (!Array.isArray(c.rules)) issues.push(`${path}: missing "rules" array`);
    else {
      for (const rule of c.rules)
        if (!isRecord(rule) || typeof rule.id !== "string" || typeof rule.approved !== "boolean")
          issues.push(`${path}: rule must have string id + boolean approved`);
      const approvedIds = c.approved_rule_ids ?? [];
      for (const ruleId of approvedIds) {
        const rule = c.rules.find((r) => r.id === ruleId);
        if (!rule) issues.push(`${path}: approved_rule_ids references unknown rule "${ruleId}"`);
        else if (!rule.approved)
          issues.push(`${path}: approved_rule_ids includes "${ruleId}" but rule.approved is false`);
      }
    }
  } else if (key === "exceptions") {
    const c = contract as unknown as ExceptionsContract;
    if (!Array.isArray(c.exceptions)) issues.push(`${path}: missing "exceptions" array`);
    else
      for (const ex of c.exceptions)
        if (!isRecord(ex) || typeof ex.contract !== "string" || typeof ex.reason !== "string")
          issues.push(`${path}: exception must have string contract+reason`);
  }
  // `tokens`, `accessibility-contract`, `exceptions` are lenient by design.
}

/**
 * Validate that a genome is well-formed. Returns a typed `GenomeValidation`
 * with every issue found; does not throw.
 */
export function validateGenome(genome: UiGenome): GenomeValidation {
  const issues: string[] = [];
  if (!Number.isInteger(genome.version) || genome.version < 1) issues.push("genome.version must be a positive integer");
  if (!isRecord(genome.contracts)) issues.push("genome.contracts must be an object");

  let contractCount = 0;
  if (isRecord(genome.contracts)) {
    for (const key of GENOME_CONTRACT_KEYS) {
      const contract = genome.contracts[key];
      if (contract === undefined || contract === null) continue;
      contractCount += 1;
      validateContract(key, contract, issues);
    }
  }
  return { valid: issues.length === 0, version: genome.version, contract_count: contractCount, issues };
}

/** Read and parse a single YAML contract file; undefined when missing/empty. */
async function readContractFile(dir: string, fileName: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(join(dir, fileName), "utf-8");
    if (!text.trim()) return undefined;
    return parseYaml(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Load a genome from a repo root, reading `.ui/genome.yaml` (version) plus all
 * present contract files. Missing contracts are simply left undefined; the
 * genome's version is read from the manifest (defaulting to GENOME_VERSION).
 */
export async function loadGenome(root: string): Promise<UiGenome> {
  const dir = genomeDirPath(root);
  let version = GENOME_VERSION;
  const manifest = await readContractFile(dir, GENOME_MANIFEST_FILE);
  if (isRecord(manifest) && typeof manifest.version === "number") version = manifest.version;

  const contracts: GenomeContracts = {};
  for (const key of GENOME_CONTRACT_KEYS) {
    const fileName = GENOME_CONTRACT_FILES[key];
    const parsed = await readContractFile(dir, fileName);
    if (parsed !== undefined) contracts[key] = parsed as never;
  }
  return { version, contracts };
}

/** Persist a genome to `.ui/` under a repo root (writes YAML via `yaml`). */
export async function saveGenome(genome: UiGenome, root: string): Promise<void> {
  const dir = genomeDirPath(root);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, GENOME_MANIFEST_FILE),
    stringifyYaml({ version: genome.version, contracts: GENOME_CONTRACT_KEYS.map((k) => GENOME_CONTRACT_FILES[k]) }),
    "utf-8",
  );
  for (const key of GENOME_CONTRACT_KEYS) {
    const contract = genome.contracts[key];
    if (contract === undefined) continue;
    await writeFile(join(dir, GENOME_CONTRACT_FILES[key]), stringifyYaml(contract), "utf-8");
  }
  // Maintain the approved-reference directory even when empty.
  await mkdir(join(dir, APPROVED_REFERENCE_DIR), { recursive: true });
}

/** List files currently stored in a genome's `.ui/` directory. */
export async function listGenomeFiles(root: string): Promise<string[]> {
  const dir = genomeDirPath(root);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Design-entropy analyzer (deterministic, Shannon entropy across categories)
// ---------------------------------------------------------------------------

/** Usage counts for one style dimension: value -> number of usages. */
export type StyleUsage = Record<string, number>;

/** Structured inputs consumed by the genome design-entropy analyzer. */
export interface GenomeEntropyInput {
  /** color palette usage counts (e.g. { "#0a84ff": 42, "#ff375f": 3 }). */
  colorPalette: StyleUsage;
  /** spacing usage counts (e.g. { "space-2": 120, "space-3": 4 }). */
  spacing: StyleUsage;
  /** typography size usage counts (e.g. { "text-sm": 60, "text-2xl": 1 }). */
  typography: StyleUsage;
  /** radius usage counts (e.g. { "radius-md": 80, "radius-3xl": 2 }). */
  radius: StyleUsage;
  /** repeated UI pattern counts (e.g. { "Card": 40, "OneOffThing": 1 }). */
  patterns: StyleUsage;
  /** Per-category weights (defaults applied when omitted). */
  weights?: Partial<GenomeEntropyWeights>;
}

export interface GenomeEntropyWeights {
  colorPalette: number;
  spacing: number;
  typography: number;
  radius: number;
  patterns: number;
}

/** Default weights for each entropy category. */
export const DEFAULT_GENOME_ENTROPY_WEIGHTS: GenomeEntropyWeights = {
  colorPalette: 0.3,
  spacing: 0.2,
  typography: 0.2,
  radius: 0.15,
  patterns: 0.15,
};

/** Per-category + combined design entropy (0..1). */
export interface GenomeEntropy {
  /** Combined normalized entropy across all non-empty categories (0..1). */
  entropy: number;
  categories: Record<"colorPalette" | "spacing" | "typography" | "radius" | "patterns", number>;
  /** The 0..100 score derived from entropy (higher entropy -> lower score). */
  score: number;
}

/** Normalized Shannon entropy of a count distribution: 0 (uniform/consistent)..1 (max divergence). */
export function normalizedShannonEntropy(counts: StyleUsage): number {
  const values = Object.values(counts).filter((c) => Number.isFinite(c) && c > 0);
  const n = values.length;
  if (n === 0) return 0;
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const count of values) {
    const p = count / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  if (n <= 1) return 0;
  return h / Math.log2(n);
}

/** Compute the deterministic design entropy across the five usage categories. */
export function computeGenomeEntropy(
  input: GenomeEntropyInput,
  weights: GenomeEntropyWeights = DEFAULT_GENOME_ENTROPY_WEIGHTS,
): GenomeEntropy {
  const categories = {
    colorPalette: normalizedShannonEntropy(input.colorPalette ?? {}),
    spacing: normalizedShannonEntropy(input.spacing ?? {}),
    typography: normalizedShannonEntropy(input.typography ?? {}),
    radius: normalizedShannonEntropy(input.radius ?? {}),
    patterns: normalizedShannonEntropy(input.patterns ?? {}),
  };
  // Weighted combination, renormalized over categories that carry any signal.
  const keys = Object.keys(categories) as Array<keyof typeof categories>;
  let weighted = 0;
  let weightTotal = 0;
  for (const key of keys) {
    const w = weights[key] ?? DEFAULT_GENOME_ENTROPY_WEIGHTS[key];
    const present =
      key === "colorPalette"
        ? Object.keys(input.colorPalette ?? {}).length > 0
        : key === "spacing"
          ? Object.keys(input.spacing ?? {}).length > 0
          : key === "typography"
            ? Object.keys(input.typography ?? {}).length > 0
            : key === "radius"
              ? Object.keys(input.radius ?? {}).length > 0
              : Object.keys(input.patterns ?? {}).length > 0;
    if (present) {
      weighted += w * categories[key];
      weightTotal += w;
    }
  }
  const entropy = weightTotal > 0 ? weighted / weightTotal : 0;
  const score = Math.round(100 * (1 - entropy));
  return { entropy, categories, score };
}

/**
 * Deterministic design-entropy analyzer. Consumes structured style-usage counts
 * and returns a typed `AnalysisResult` mapped to the rubric metric id
 * `design_entropy` (consumable by src/uieng/evidence.ts `toMetricScore`).
 */
export function analyzeGenomeEntropy(
  input: GenomeEntropyInput,
  opts: { weights?: GenomeEntropyWeights; evidence?: string[] } = {},
): AnalysisResult {
  const weights = opts.weights ?? DEFAULT_GENOME_ENTROPY_WEIGHTS;
  const evidence = [...(opts.evidence ?? [])];
  const { entropy, categories, score } = computeGenomeEntropy(input, weights);
  assertMetricKnown("design_entropy");
  const catSummary = Object.entries(categories)
    .map(([key, value]) => `${key}=${value.toFixed(3)}`)
    .join(", ");
  const details =
    entropy === 0
      ? "Design usage is maximally consistent; negligible entropy across all categories."
      : `Design entropy ${entropy.toFixed(3)} (${catSummary}); ${score}/100 design_entropy.`;
  return {
    metricId: "design_entropy",
    score,
    confidence: 0.8,
    evidence,
    details,
  };
}

// ---------------------------------------------------------------------------
// Contract-injection helper (reuses the auto-attach concept from policy.ts)
// ---------------------------------------------------------------------------

/** Options for {@link injectGenomeContracts}. */
export interface GenomeInjectionOptions {
  /** Contract keys to always include regardless of profile relevance. */
  force?: readonly GenomeContractKey[];
  /** Max advisory rule ids to surface (defaults to all). */
  maxAdvisory?: number;
}

/** Result of injecting a genome's relevant contracts into a task prompt. */
export interface GenomeInjection {
  genome_version: number;
  profile: {
    ui_present: boolean;
    framework?: string;
    styling?: string;
    design_system?: string;
  };
  /** Constitutional rule ids (approved -> authoritative). */
  constitutional: string[];
  /** Advisory rule ids (experimental or not yet approved). */
  advisory: string[];
  /** Contract YAML text keyed by contract key (only relevant ones). */
  documents: Record<string, string>;
  /** Ready-to-inject combined prompt text. */
  text: string;
}

/** True when a rule id is constitutional for a genome (present in the approved list). */
export function isConstitutional(genome: UiGenome, ruleId: string): boolean {
  const constitution = genome.contracts.constitution;
  if (!constitution) return false;
  if (constitution.approved_rule_ids.includes(ruleId)) return true;
  const rule = constitution.rules.find((r) => r.id === ruleId);
  return rule?.approved === true;
}

/** Split a genome's constitution rules into constitutional vs advisory ids. */
export function splitConstitutionalRules(genome: UiGenome): { constitutional: string[]; advisory: string[] } {
  const rules = genome.contracts.constitution?.rules ?? [];
  const constitutional: string[] = [];
  const advisory: string[] = [];
  for (const rule of rules) {
    if (isConstitutional(genome, rule.id)) constitutional.push(rule.id);
    else advisory.push(rule.id);
  }
  return { constitutional, advisory };
}

/** Map a profile to the set of contract keys that are relevant to it. */
export function relevantContracts(profile: UiProfile): GenomeContractKey[] {
  const keys = new Set<GenomeContractKey>();
  // Styling/token presence implies the visual + token contracts.
  if (profile.styling || profile.design_system || (profile.tokens && Object.keys(profile.tokens).length > 0)) {
    keys.add("tokens");
    keys.add("colors");
    keys.add("spacing");
    keys.add("breakpoints");
    keys.add("typography");
    keys.add("responsive-contract");
    keys.add("accessibility-contract");
  }
  if (profile.component_count > 0) keys.add("components");
  if (profile.responsive_targets.length > 0 && profile.ui_present) keys.add("responsive-contract");
  if (profile.framework && profile.ui_present) keys.add("interaction-patterns");
  keys.add("terminology");
  keys.add("task-catalog");
  keys.add("exceptions");
  return [...keys];
}

/**
 * Build the contract YAML/text to auto-inject into implementation and review
 * task prompts for a given profile + genome. Constitutional rules are surfaced
 * as authoritative; everything else is explicitly advisory. Pure/deterministic.
 */
export function injectGenomeContracts(
  profile: UiProfile,
  genome: UiGenome,
  opts: GenomeInjectionOptions = {},
): GenomeInjection {
  const force = opts.force ?? [];
  const relevant = new Set<GenomeContractKey>([...relevantContracts(profile), ...force]);
  const { constitutional, advisory } = splitConstitutionalRules(genome);
  const boundedAdvisory = opts.maxAdvisory !== undefined ? advisory.slice(0, opts.maxAdvisory) : advisory;

  const documents: Record<string, string> = {};
  const chunks: string[] = [
    `# UI Genome (v${genome.version}) — auto-injected contracts`,
    `Profile: ui_present=${profile.ui_present}${profile.framework ? `, framework=${profile.framework}` : ""}${
      profile.styling ? `, styling=${profile.styling}` : ""
    }${profile.design_system ? `, design_system=${profile.design_system}` : ""}`,
  ];
  if (constitutional.length > 0) chunks.push(`CONSTITUTIONAL rules (must follow): ${constitutional.join(", ")}`);
  if (boundedAdvisory.length > 0)
    chunks.push(`ADVISORY rules (apply unless contradicted): ${boundedAdvisory.join(", ")}`);

  for (const key of relevant) {
    const contract = genome.contracts[key];
    if (contract === undefined) continue;
    const text = stringifyYaml(contract);
    documents[key] = text;
    chunks.push(`## ${GENOME_CONTRACT_FILES[key]}\n${text}`);
  }
  if (Object.keys(documents).length === 0)
    chunks.push("No genome contracts available for this profile; proceed with default UI conventions.");

  return {
    genome_version: genome.version,
    profile: {
      ui_present: profile.ui_present,
      framework: profile.framework,
      styling: profile.styling,
      design_system: profile.design_system,
    },
    constitutional,
    advisory: boundedAdvisory,
    documents,
    text: chunks.join("\n\n"),
  };
}
