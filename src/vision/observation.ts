/**
 * DesignObservation/v1 — versioned structured design artifact produced by a
 * vision analysis worker (spec: pi-engineering-vision-payload-management).
 *
 * Pure deterministic logic over plain structured inputs; no image decoding.
 */

export const SCHEMA_VERSION = "DesignObservation/v1" as const;

export interface DesignObservation {
  assetId: string;
  reference: string;
  summary: string;
  layouts: string[];
  components: string[];
  navigation: string[];
  responsiveBehavior: {
    desktop: string[];
    tablet: string[];
    mobile: string[];
  };
  visualHierarchy: string[];
  interactionPatterns: string[];
  reusablePatterns: string[];
  implementationConstraints: string[];
  accessibilityNotes: string[];
  unknowns: string[];
  confidence: {
    overall: number;
    layout: number;
    typography: number;
  };
}

const STRING_SCALAR_FIELDS = ["assetId", "reference", "summary"] as const;
const STRING_ARRAY_FIELDS = [
  "layouts",
  "components",
  "navigation",
  "visualHierarchy",
  "interactionPatterns",
  "reusablePatterns",
  "implementationConstraints",
  "accessibilityNotes",
  "unknowns",
] as const;
const RESPONSIVE_KEYS = ["desktop", "tablet", "mobile"] as const;
const CONFIDENCE_KEYS = ["overall", "layout", "typography"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Return a list of validation error strings; empty when `v` is a valid
 * DesignObservation.
 */
export function validateDesignObservation(v: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(v)) {
    return ["DesignObservation must be a plain object"];
  }
  for (const field of STRING_SCALAR_FIELDS) {
    if (typeof v[field] !== "string") {
      errors.push(`${field} must be a string`);
    }
  }
  for (const field of STRING_ARRAY_FIELDS) {
    if (!isStringArray(v[field])) {
      errors.push(`${field} must be an array of strings`);
    }
  }
  const rb = v.responsiveBehavior;
  if (!isPlainObject(rb)) {
    errors.push("responsiveBehavior must be an object with desktop/tablet/mobile string arrays");
  } else {
    for (const key of RESPONSIVE_KEYS) {
      if (!isStringArray(rb[key])) {
        errors.push(`responsiveBehavior.${key} must be an array of strings`);
      }
    }
  }
  const confidence = v.confidence;
  if (!isPlainObject(confidence)) {
    errors.push("confidence must be an object with overall/layout/typography numbers");
  } else {
    for (const key of CONFIDENCE_KEYS) {
      if (!isFiniteNumber(confidence[key])) {
        errors.push(`confidence.${key} must be a finite number`);
      }
    }
  }
  return errors;
}

/** Type guard: true when `v` conforms to the DesignObservation/v1 schema. */
export function isDesignObservation(v: unknown): v is DesignObservation {
  return validateDesignObservation(v).length === 0;
}

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Render a human-readable `.analysis.md`-style Markdown document with a heading
 * per section. Non-empty arrays are listed; confidence values are always shown.
 */
export function renderObservationMarkdown(obs: DesignObservation): string {
  const parts: string[] = [];
  parts.push(`# ${obs.reference || obs.assetId}`);
  parts.push("");
  parts.push(`**Schema:** ${SCHEMA_VERSION}`);
  parts.push("");
  parts.push("## Overview");
  parts.push(`- **Asset:** ${obs.assetId}`);
  parts.push(`- **Reference:** ${obs.reference}`);
  parts.push("");
  parts.push(`**Summary:** ${obs.summary}`);
  parts.push("");

  const mainSections: ReadonlyArray<[string, string[]]> = [
    ["Layouts", obs.layouts],
    ["Components", obs.components],
    ["Navigation", obs.navigation],
    ["Visual Hierarchy", obs.visualHierarchy],
    ["Interaction Patterns", obs.interactionPatterns],
    ["Reusable Patterns", obs.reusablePatterns],
    ["Implementation Constraints", obs.implementationConstraints],
    ["Accessibility Notes", obs.accessibilityNotes],
    ["Unknowns", obs.unknowns],
  ];
  for (const [title, items] of mainSections) {
    if (items.length > 0) {
      parts.push(`## ${title}`);
      parts.push("");
      parts.push(bulletList(items));
      parts.push("");
    }
  }

  const responsive: ReadonlyArray<[string, string[]]> = [
    ["Desktop", obs.responsiveBehavior.desktop],
    ["Tablet", obs.responsiveBehavior.tablet],
    ["Mobile", obs.responsiveBehavior.mobile],
  ];
  const nonEmptyResponsive = responsive.filter(([, items]) => items.length > 0);
  if (nonEmptyResponsive.length > 0) {
    parts.push("## Responsive Behavior");
    parts.push("");
    for (const [title, items] of nonEmptyResponsive) {
      parts.push(`### ${title}`);
      parts.push("");
      parts.push(bulletList(items));
      parts.push("");
    }
  }

  parts.push("## Confidence");
  parts.push("");
  parts.push(`- Overall: ${obs.confidence.overall}`);
  parts.push(`- Layout: ${obs.confidence.layout}`);
  parts.push(`- Typography: ${obs.confidence.typography}`);
  parts.push("");

  return `${parts.join("\n").trimEnd()}\n`;
}
