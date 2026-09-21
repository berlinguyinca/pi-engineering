/**
 * Visual verification slice (spec: pi-engineering-vision-payload-management,
 * §§25-27, 51). Provides the VisualDiffObservation schema, the isolated
 * VisualVerificationWorker, and responsive viewport planning.
 *
 * Pure deterministic logic over plain structured (text) inputs; no image
 * decoding. The engineering agent only ever receives textual difference
 * descriptions, never full-resolution screenshots (§25).
 */

/** A single textual difference between a reference and the implemented UI. */
export interface VisualDifference {
  component: string;
  severity: "low" | "medium" | "high" | "critical";
  difference: string;
  recommendation: string;
}

/** Viewport dimension pair (spec §26/§27). */
export interface Viewport {
  width: number;
  height: number;
}

/** VisualDiffObservation — structured schema for a per-route diff result. */
export interface VisualDiffObservation {
  route: string;
  viewport: Viewport;
  differences: VisualDifference[];
  overallConfidence: number;
}

/** Bounded, isolated input passed to a visual verification worker (§25). */
export interface VisualVerificationRequest {
  route: string;
  viewport: Viewport;
  reference: string;
  referenceSummary: string;
  screenshotSummary: string;
}

export interface VisualVerificationResult {
  route: string;
  viewport: Viewport;
  observation: VisualDiffObservation;
  schemaVersion: string;
  modelId?: string;
  durationMs?: number;
}

export const VISUAL_DIFF_SCHEMA_VERSION = "VisualDiffObservation/v1" as const;

/** Standard responsive viewports (spec §27) plus project breakpoints. */
export const DEFAULT_VIEWPORTS: ReadonlyArray<Viewport> = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isViewport(v: unknown): v is Viewport {
  return (
    isPlainObject(v) &&
    typeof v.width === "number" &&
    Number.isFinite(v.width) &&
    typeof v.height === "number" &&
    Number.isFinite(v.height)
  );
}

const DIFF_SEVERITIES = new Set(["low", "medium", "high", "critical"]);

/**
 * Return a list of validation error strings; empty when `v` is a valid
 * VisualDiffObservation.
 */
export function validateVisualDiffObservation(v: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(v)) {
    return ["VisualDiffObservation must be a plain object"];
  }
  if (typeof v.route !== "string") {
    errors.push("route must be a string");
  }
  if (!isViewport(v.viewport)) {
    errors.push("viewport must be an object with finite width/height numbers");
  }
  if (!Array.isArray(v.differences)) {
    errors.push("differences must be an array");
  } else {
    for (const d of v.differences) {
      if (!isPlainObject(d)) {
        errors.push("each difference must be a plain object");
        continue;
      }
      if (typeof d.component !== "string") {
        errors.push("difference.component must be a string");
      }
      if (typeof d.severity !== "string" || !DIFF_SEVERITIES.has(d.severity)) {
        errors.push(`difference.severity must be one of low|medium|high|critical`);
      }
      if (typeof d.difference !== "string") {
        errors.push("difference.difference must be a string");
      }
      if (typeof d.recommendation !== "string") {
        errors.push("difference.recommendation must be a string");
      }
    }
  }
  if (typeof v.overallConfidence !== "number" || !Number.isFinite(v.overallConfidence)) {
    errors.push("overallConfidence must be a finite number");
  }
  return errors;
}

/** Type guard: true when `v` conforms to the VisualDiffObservation schema. */
export function isVisualDiffObservation(v: unknown): v is VisualDiffObservation {
  return validateVisualDiffObservation(v).length === 0;
}

/**
 * Render the textual difference report delivered to the engineering agent
 * (§25). Contains only text — never image binary.
 */
export function renderVisualDiffMarkdown(obs: VisualDiffObservation): string {
  const parts: string[] = [];
  parts.push(`# Visual Diff — ${obs.route}`);
  parts.push(`Viewport: ${obs.viewport.width}x${obs.viewport.height}`);
  parts.push(`Overall confidence: ${obs.overallConfidence}`);
  parts.push("");
  if (obs.differences.length === 0) {
    parts.push("No differences detected.");
  } else {
    for (const d of obs.differences) {
      parts.push(`- **${d.component}** (${d.severity}): ${d.difference}`);
      parts.push(`  - Recommendation: ${d.recommendation}`);
    }
  }
  return parts.join("\n");
}

/**
 * Build the responsive viewport test plan: the standard breakpoints (§27)
 * plus any project-defined breakpoints, deduplicated by exact (width,height).
 */
export function planResponsiveViewports(projectBreakpoints: ReadonlyArray<Viewport> = []): Viewport[] {
  const seen = new Set<string>();
  const result: Viewport[] = [];
  for (const v of [...DEFAULT_VIEWPORTS, ...projectBreakpoints]) {
    if (!isViewport(v)) continue;
    const key = `${v.width}x${v.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ width: v.width, height: v.height });
  }
  return result;
}

/** Default compare callback: returns an empty diff (no differences). */
function defaultCompare(_request: VisualVerificationRequest): VisualDifference[] {
  return [];
}

export type CompareCallback = (request: VisualVerificationRequest) => Promise<VisualDifference[]> | VisualDifference[];

/**
 * Isolated visual verification worker (§25/§51). Compares a reference summary
 * against an implemented screenshot summary via a compare callback, validates
 * the resulting VisualDiffObservation, and returns only text for the agent.
 */
export class VisualVerificationWorker {
  private readonly compare: CompareCallback;

  constructor(compare?: CompareCallback) {
    this.compare = compare ?? defaultCompare;
  }

  async run(request: VisualVerificationRequest): Promise<VisualVerificationResult> {
    if (!request.reference) {
      throw new Error("Visual verification request requires a reference");
    }
    const differences = await this.compare(request);
    const observation: VisualDiffObservation = {
      route: request.route,
      viewport: { width: request.viewport.width, height: request.viewport.height },
      differences,
      overallConfidence: 1,
    };
    const errors = validateVisualDiffObservation(observation);
    if (errors.length > 0) {
      throw new Error(`Visual verification returned an invalid VisualDiffObservation: ${errors.join("; ")}`);
    }
    return {
      route: observation.route,
      viewport: observation.viewport,
      observation,
      schemaVersion: VISUAL_DIFF_SCHEMA_VERSION,
    };
  }
}
