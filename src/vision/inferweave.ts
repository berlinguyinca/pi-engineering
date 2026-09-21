/**
 * InferWeave task-level routing and dynamically advertised provider
 * capabilities (spec pi-engineering-vision-payload-management, §§30-31).
 *
 * Pure deterministic logic over plain structured inputs — no real network
 * calls, no image decoding. This slice defines the routing contract and the
 * capability-advertisement model that a later integration slice wires to the
 * real InferWeave client.
 */

import { RequestBudgetManager } from "./budget.ts";

// ── Task-level routing (spec §31) ──────────────────────────────────────────

/** Route a UI-reference analysis task to a vision-capable model. */
export const TASK_ANALYZE_UI = "analyze-ui-reference";
/** Route an implementation task to a stronger coding model. */
export const TASK_IMPLEMENT = "implement-react-component";
/** Route a visual-regression review task back to a visual model. */
export const TASK_VISUAL_REGRESSION = "visual-regression-review";

/** The three vision tasks the router understands (spec §31). */
export type VisionTask = typeof TASK_ANALYZE_UI | typeof TASK_IMPLEMENT | typeof TASK_VISUAL_REGRESSION;

/** A small route descriptor mapping a task to a capability + model role. */
export interface VisionTaskRoute {
  task: VisionTask;
  capability: "vision" | "code";
  preferredModelRole: string;
}

const ROUTES: Record<VisionTask, VisionTaskRoute> = {
  [TASK_ANALYZE_UI]: { task: TASK_ANALYZE_UI, capability: "vision", preferredModelRole: "vision-analyst" },
  [TASK_IMPLEMENT]: { task: TASK_IMPLEMENT, capability: "code", preferredModelRole: "implementer" },
  [TASK_VISUAL_REGRESSION]: {
    task: TASK_VISUAL_REGRESSION,
    capability: "vision",
    preferredModelRole: "visual-reviewer",
  },
};

/** Return the route descriptor for a task; throws on an unknown task. */
export function routeTask(task: VisionTask): VisionTaskRoute {
  const route = ROUTES[task];
  if (!route) throw new Error(`unknown vision task: ${String(task)}`);
  return route;
}

// ── Dynamically advertised provider capabilities (spec §30) ────────────────

/** Capabilities an InferWeave endpoint advertises for request budgeting. */
export interface InferWeaveCapabilities {
  maxRequestBytes?: number;
  maxContextTokens?: number;
  supportsVision?: boolean;
  preferredImageLongEdge?: number;
  maxImagesPerRequest?: number;
}

/** Spec §30 defaults: 64 MiB, 262144 tokens, 1800px, 8 images. */
export const DEFAULT_INFERWEAVE_CAPABILITIES: InferWeaveCapabilities = {
  maxRequestBytes: 67_108_864,
  maxContextTokens: 262_144,
  supportsVision: true,
  preferredImageLongEdge: 1800,
  maxImagesPerRequest: 8,
};

/**
 * Client that consumes dynamically advertised limits rather than hardcoding
 * provider assumptions into prompts (spec §17/§30). Accepts an optional fetch
 * callback for tests / future wiring; defaults to the spec defaults.
 */
export class InferWeaveCapabilityClient {
  private readonly fetch: () => Promise<InferWeaveCapabilities>;
  private cached: InferWeaveCapabilities | null = null;
  private pending: Promise<InferWeaveCapabilities> | null = null;

  constructor(fetch?: () => Promise<InferWeaveCapabilities>) {
    this.fetch = fetch ?? (async () => ({ ...DEFAULT_INFERWEAVE_CAPABILITIES }));
  }

  /** Return the fetched capabilities (cached across calls). */
  async capabilities(): Promise<InferWeaveCapabilities> {
    if (this.cached) return this.cached;
    if (!this.pending) {
      this.pending = this.fetch().then((c) => {
        this.cached = c;
        return c;
      });
    }
    return this.pending;
  }

  async maxRequestBytes(): Promise<number> {
    const c = await this.capabilities();
    return c.maxRequestBytes ?? DEFAULT_INFERWEAVE_CAPABILITIES.maxRequestBytes!;
  }

  async supportsVision(): Promise<boolean> {
    const c = await this.capabilities();
    return c.supportsVision ?? DEFAULT_INFERWEAVE_CAPABILITIES.supportsVision!;
  }

  async preferredImageLongEdge(): Promise<number> {
    const c = await this.capabilities();
    return c.preferredImageLongEdge ?? DEFAULT_INFERWEAVE_CAPABILITIES.preferredImageLongEdge!;
  }

  async maxImagesPerRequest(): Promise<number> {
    const c = await this.capabilities();
    return c.maxImagesPerRequest ?? DEFAULT_INFERWEAVE_CAPABILITIES.maxImagesPerRequest!;
  }

  /** Construct a RequestBudgetManager from the advertised limits. */
  async buildRequestBudgetManager(): Promise<RequestBudgetManager> {
    const [maxRequestBytes, maxContextTokens] = await Promise.all([this.maxRequestBytes(), this.maxContextTokens()]);
    return new RequestBudgetManager(maxRequestBytes, maxContextTokens);
  }

  private async maxContextTokens(): Promise<number> {
    const c = await this.capabilities();
    return c.maxContextTokens ?? DEFAULT_INFERWEAVE_CAPABILITIES.maxContextTokens!;
  }
}

/** Serialize capabilities to JSON (advertising/debug; spec §30 shape). */
export function capabilitiesToJson(c: InferWeaveCapabilities): string {
  return JSON.stringify(c);
}
