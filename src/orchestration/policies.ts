/**
 * Declarative policy engine (spec 01 §Stage B, spec 00 §6).
 *
 * Deterministic policy rules observe runtime facts (files changed, file
 * classes, manifests, security paths) and upgrade a mission's required gates
 * and workflow class REGARDLESS of semantic classification. These invariants
 * are enforced in code — no model prompt can skip a mandatory gate.
 */

import type { RequiredGate, WorkflowClass } from "./types.ts";

/** A file class matched by path patterns. */
export interface FileClass {
  name: string;
  /** Glob-style path patterns (e.g. "src/auth/**"). */
  patterns: string[];
}

/** A policy rule that maps an observed fact to required gates. */
export interface PolicyRule {
  id: string;
  description: string;
  /** File classes that trigger this rule. */
  triggersOn: string[];
  /** Gates required when triggered. */
  require: RequiredGate[];
  /** Workflow class upgrade when triggered (if the current class is weaker). */
  upgradeWorkflow?: WorkflowClass;
}

/** A mutation observation fed to the policy engine. */
export interface MutationFact {
  changedFiles: string[];
  manifestsChanged: boolean;
  migrationsChanged: boolean;
  testsChanged: boolean;
  generatedChanged: boolean;
  securityPathsChanged: boolean;
  schemaChanged: boolean;
  publicApiChanged: boolean;
}

/** Default file classes covering common repository conventions. */
export const DEFAULT_FILE_CLASSES: FileClass[] = [
  { name: "auth", patterns: ["**/auth/**", "**/security/**", "**/oauth/**", "**/session/**"] },
  { name: "schema", patterns: ["**/schema/**", "**/migrations/**", "**/migration/**", "**/*.sql"] },
  {
    name: "manifests",
    patterns: [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "Cargo.toml",
      "go.mod",
      "requirements*.txt",
      "Pipfile*",
    ],
  },
  {
    name: "tests",
    patterns: ["**/*.test.ts", "**/*.test.js", "**/*.spec.ts", "**/*.spec.js", "test/**", "__tests__/**"],
  },
  {
    name: "generated",
    patterns: ["**/dist/**", "**/build/**", "**/*.generated.ts", "**/generated/**", "**/vendor/**"],
  },
  { name: "publicApi", patterns: ["**/index.ts", "**/exports.ts", "**/public-api.ts", "**/*.d.ts"] },
];

/** Default policy rules (spec 00 §6). Extensible by callers. */
export const DEFAULT_POLICY_RULES: PolicyRule[] = [
  {
    id: "source_mutation",
    description: "Material source mutation requires validation + independent review.",
    triggersOn: ["source"],
    require: ["validation", "independent_review"],
    upgradeWorkflow: "engineering_review",
  },
  {
    id: "auth_mutation",
    description: "Auth/security-sensitive mutation requires security review.",
    triggersOn: ["auth"],
    require: ["security_review"],
    upgradeWorkflow: "security_sensitive",
  },
  {
    id: "schema_mutation",
    description: "Schema/migration mutation requires migration validation.",
    triggersOn: ["schema"],
    require: ["migration_validation"],
    upgradeWorkflow: "migration",
  },
  {
    id: "dependency_mutation",
    description: "Manifest/lockfile mutation requires dependency install/build validation.",
    triggersOn: ["manifests"],
    require: ["dependency_validation"],
  },
  {
    id: "public_api_mutation",
    description: "Public API mutation requires compatibility review.",
    triggersOn: ["publicApi"],
    require: ["compatibility_review"],
  },
];

/**
 * True when a file matches a glob-like pattern (supports ** and *).
 * `**` matches zero or more path segments; `*` matches within a segment.
 */
export function pathMatchesPattern(file: string, pattern: string): boolean {
  // Normalize slashes.
  const f = file.replace(/\\/g, "/");
  const p = pattern.replace(/\\/g, "/");
  // Convert the pattern to a RegExp.
  let re = "^";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] ?? "";
    if (ch === "*") {
      // `**` (and any run of stars) matches any path segments.
      if (p[i + 1] === "*") {
        re += ".*";
        while (p[i + 1] === "*") i++;
      } else {
        re += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re).test(f);
}

/** Classify a file into file-class names (default classes only). */
export function classifyFiles(
  files: string[],
  classes: FileClass[] = DEFAULT_FILE_CLASSES,
): { fileClass: string; matched: string[] }[] {
  const out: { fileClass: string; matched: string[] }[] = [];
  for (const c of classes) {
    const matched = files.filter((f) => c.patterns.some((pat) => pathMatchesPattern(f, pat ?? "")));
    if (matched.length > 0) out.push({ fileClass: c.name, matched });
  }
  return out;
}

/**
 * Derive the required gates from a mutation fact + applicable rules.
 * The "source" class is implicit: any non-generated, non-test-only change is a
 * source mutation.
 */
export function deriveRequiredGates(
  fact: MutationFact,
  rules: PolicyRule[] = DEFAULT_POLICY_RULES,
  classes: FileClass[] = DEFAULT_FILE_CLASSES,
): { gates: RequiredGate[]; upgradedWorkflow: WorkflowClass | null; reasons: string[] } {
  const gates = new Set<RequiredGate>();
  const reasons: string[] = [];
  let upgraded: WorkflowClass | null = null;
  const classNames = new Set(classifiedClasses(fact, classes));

  // Implicit source mutation: any real change beyond generated/tests.
  const hasSource = fact.changedFiles.length > 0;
  if (hasSource) classNames.add("source");

  for (const rule of rules) {
    if (rule.triggersOn.some((c) => classNames.has(c))) {
      for (const g of rule.require) gates.add(g);
      if (rule.upgradeWorkflow) {
        if (!upgraded || workflowRank(rule.upgradeWorkflow) > workflowRank(upgraded)) upgraded = rule.upgradeWorkflow;
      }
      reasons.push(`${rule.id}: ${rule.description}`);
    }
  }
  return { gates: [...gates], upgradedWorkflow: upgraded, reasons };
}

function classifiedClasses(fact: MutationFact, classes: FileClass[]): string[] {
  const names = new Set<string>();
  for (const { fileClass } of classifyFiles(fact.changedFiles, classes)) names.add(fileClass);
  if (fact.manifestsChanged) names.add("manifests");
  if (fact.migrationsChanged) names.add("schema");
  if (fact.schemaChanged) names.add("schema");
  if (fact.securityPathsChanged) names.add("auth");
  if (fact.publicApiChanged) names.add("publicApi");
  // Tests-only changes are still source mutations.
  if (fact.testsChanged && fact.changedFiles.length === 0) names.add("source");
  return [...names];
}

const WORKFLOW_RANK: Record<WorkflowClass, number> = {
  conversation: 0,
  research: 1,
  investigation: 2,
  review: 2,
  engineering: 3,
  engineering_review: 4,
  refactor: 3,
  incident_fix: 3,
  migration: 4,
  security_sensitive: 5,
};

export function workflowRank(w: WorkflowClass): number {
  return WORKFLOW_RANK[w] ?? 0;
}

/** Build a MutationFact from a list of changed paths (best-effort). */
export function mutationFactFromChangedFiles(files: string[]): MutationFact {
  const classes = classifyFiles(files);
  const names = new Set(classes.map((c) => c.fileClass));
  return {
    changedFiles: files,
    manifestsChanged: names.has("manifests"),
    migrationsChanged: names.has("schema"),
    testsChanged: names.has("tests"),
    generatedChanged: names.has("generated"),
    securityPathsChanged: names.has("auth"),
    schemaChanged: names.has("schema"),
    publicApiChanged: names.has("publicApi"),
  };
}
