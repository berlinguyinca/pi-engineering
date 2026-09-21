/**
 * VisionAnalysisWorker — isolated worker task contract + routing for vision
 * analysis (spec: pi-engineering-vision-payload-management, §§31-32).
 *
 * Pure deterministic logic over plain structured inputs; no image decoding.
 * The worker receives ONLY the bounded request fields, never the full session.
 */

import { validateDesignObservation } from "./observation.ts";

/** Task identifiers for model routing (spec §31). */
export const VISION_ANALYSIS_TASK = "analyze-ui-reference";
export const VISUAL_REGRESSION_TASK = "visual-regression-review";
export const IMPLEMENT_TASK = "implement-react-component";

/** Bounded, isolated input passed to a vision analysis worker (spec §32). */
export interface VisionWorkerRequest {
  assetId: string;
  reference: string;
  schemaVersion: "DesignObservation/v1" | string;
  instructions: string;
  designContractFragment?: string;
  projectContext?: string;
}

export interface VisionWorkerResult {
  assetId: string;
  reference: string;
  observation: unknown;
  schemaVersion: string;
  modelId?: string;
  durationMs?: number;
}

/** Standard analysis task prompt from the spec. */
export const VISION_WORKER_INSTRUCTIONS =
  "Analyze this reference for implementation. Extract: layout hierarchy; component hierarchy; " +
  "visual grouping; navigation; spacing; typography; cards and panels; graphs; interaction patterns; " +
  "responsive behavior; desktop/tablet/mobile differences; reusable components; implementation constraints; " +
  "notable visual details; accessibility concerns. Do not implement code. Return structured JSON plus " +
  "human-readable Markdown.";

/**
 * Build a compact text prompt for the isolated worker summarizing only the
 * bounded request fields (spec §32 — minimal context, never the full session).
 */
export function buildVisionWorkerContext(request: VisionWorkerRequest): string {
  const parts: string[] = [];
  parts.push(`Reference: ${request.reference}`);
  parts.push(`Schema version: ${request.schemaVersion}`);
  parts.push(`Instructions: ${request.instructions}`);
  if (request.designContractFragment !== undefined && request.designContractFragment.length > 0) {
    parts.push(`Design contract fragment:\n${request.designContractFragment}`);
  }
  if (request.projectContext !== undefined && request.projectContext.length > 0) {
    parts.push(`Project context:\n${request.projectContext}`);
  }
  return parts.join("\n\n");
}

/** Default analyze callback that returns a minimal valid DesignObservation. */
function defaultAnalyze(request: VisionWorkerRequest): unknown {
  return {
    assetId: request.assetId,
    reference: request.reference,
    summary: "Auto-generated stub observation for isolated vision worker.",
    layouts: [],
    components: [],
    navigation: [],
    responsiveBehavior: { desktop: [], tablet: [], mobile: [] },
    visualHierarchy: [],
    interactionPatterns: [],
    reusablePatterns: [],
    implementationConstraints: [],
    accessibilityNotes: [],
    unknowns: [],
    confidence: { overall: 0, layout: 0, typography: 0 },
  };
}

export type AnalyzeCallback = (request: VisionWorkerRequest) => Promise<unknown> | unknown;

/**
 * Isolated vision analysis worker. `run` builds minimal context, calls the
 * analyze callback, validates the result against the DesignObservation/v1
 * schema, and throws with validation details when invalid.
 */
export class VisionAnalysisWorker {
  private readonly analyze: AnalyzeCallback;

  constructor(analyze?: AnalyzeCallback) {
    this.analyze = analyze ?? defaultAnalyze;
  }

  async run(request: VisionWorkerRequest): Promise<VisionWorkerResult> {
    // (1) build worker context from ONLY the request fields (minimal context).
    const context = buildVisionWorkerContext(request);
    // Keep the context referenced so the bounded prompt is actually constructed
    // and available for isolation semantics; the worker only ever sees request.
    if (context.length === 0) {
      throw new Error("Vision worker context is empty");
    }
    // (2) call the analyze callback with the bounded request.
    const observation = await this.analyze(request);
    // (3) validate the returned value with the DesignObservation/v1 schema.
    const errors = validateDesignObservation(observation);
    // (4) if invalid, throw listing the validation problems.
    if (errors.length > 0) {
      throw new Error(`Vision analysis returned an invalid DesignObservation: ${errors.join("; ")}`);
    }
    // (5) return the result.
    return {
      assetId: request.assetId,
      reference: request.reference,
      observation,
      schemaVersion: request.schemaVersion,
    };
  }
}
