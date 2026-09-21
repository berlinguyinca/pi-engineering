/**
 * Runtime-neutral AgentRuntime seam (herdr spec 02, 03, 14).
 *
 * All external runtime access flows through `AgentRuntime`. A runtime selector
 * (`createAgentRuntime`) resolves the active runtime from a feature flag /
 * selector; Phase D adds `HerdrAgentRuntime` behind the same seam. The legacy
 * runtime remains the rollback target until parity/canary/rollback gates pass.
 */

export * from "./AgentRuntime.ts";
export { LegacyAgentRuntime } from "./LegacyAgentRuntime.ts";
export type { LegacyAgentRuntimeOptions } from "./LegacyAgentRuntime.ts";

import type { WorkerExecutor } from "../workers/WorkerExecutor.ts";
import type { AgentRuntime } from "./AgentRuntime.ts";
import { LegacyAgentRuntime } from "./LegacyAgentRuntime.ts";

/** Selector input for resolving the active runtime. */
export interface AgentRuntimeSelector {
  /** Active runtime name. Defaults to "legacy" until Herdr gates pass. */
  runtime?: "legacy" | "herdr";
  /** Worker executor backing the legacy runtime. */
  worker?: WorkerExecutor;
  /** Discovered context ceiling from runtime/InferWeave metadata. */
  maxContextTokens?: number;
  /** Options for the Herdr runtime (Phase D). */
  herdr?: Record<string, unknown>;
}

/**
 * Resolve the active runtime behind the feature flag. `runtime: "herdr"` is
 * reserved for Phase D and currently falls back to legacy with a warning, so a
 * selector that asks for Herdr before it exists fails safe rather than throwing.
 */
export function createAgentRuntime(sel: AgentRuntimeSelector): AgentRuntime {
  if (sel.runtime === "herdr") {
    // Phase D installs HerdrAgentRuntime here behind capability negotiation.
    if (!sel.worker) throw new Error("HerdrAgentRuntime not yet available; supply a worker to use legacy");
    return new LegacyAgentRuntime({ worker: sel.worker, maxContextTokens: sel.maxContextTokens });
  }
  if (!sel.worker) throw new Error("createAgentRuntime requires a worker executor for the legacy runtime");
  return new LegacyAgentRuntime({ worker: sel.worker, maxContextTokens: sel.maxContextTokens });
}
