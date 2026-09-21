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
export * from "./herdr/index.ts";

import type { WorkerExecutor } from "../workers/WorkerExecutor.ts";
import type { AgentRuntime } from "./AgentRuntime.ts";
import { LegacyAgentRuntime } from "./LegacyAgentRuntime.ts";
import { HerdrAgentRuntime } from "./herdr/HerdrAgentRuntime.ts";
import type { HerdrCli } from "./herdr/HerdrCli.ts";

/** Selector input for resolving the active runtime. */
export interface AgentRuntimeSelector {
  /** Active runtime name. Defaults to "legacy" until Herdr gates pass. */
  runtime?: "legacy" | "herdr";
  /** Worker executor backing the legacy runtime (ignored when herdr selected). */
  worker?: WorkerExecutor;
  /** Discovered context ceiling from runtime/InferWeave metadata. */
  maxContextTokens?: number;
  /** Herdr CLI client (required when runtime === "herdr"). */
  herdrCli?: HerdrCli;
  /** Minimum Herdr protocol version to accept (capability negotiation). */
  herdrMinProtocol?: number;
  /** Agent kind Herdr should start (default "pi"). */
  herdrAgentKind?: string;
}

/**
 * Resolve the active runtime behind the feature flag (spec 03, 14).
 *
 * - `runtime: "herdr"` builds `HerdrAgentRuntime` over `herdrCli` and performs
 *   capability/version negotiation (`herdrMinProtocol`) before accepting.
 * - Default is `legacy`, which remains the rollback target until parity,
 *   recovery, canary and rollback gates pass (Phase H).
 */
export async function createAgentRuntime(sel: AgentRuntimeSelector): Promise<AgentRuntime> {
  if (sel.runtime === "herdr") {
    if (!sel.herdrCli) throw new Error("createAgentRuntime(runtime='herdr') requires herdrCli");
    await negotiateHerdr(sel.herdrCli, sel.herdrMinProtocol);
    return new HerdrAgentRuntime({
      cli: sel.herdrCli,
      maxContextTokens: sel.maxContextTokens,
      agentKind: sel.herdrAgentKind,
    });
  }
  if (!sel.worker) throw new Error("createAgentRuntime requires a worker executor for the legacy runtime");
  return new LegacyAgentRuntime({ worker: sel.worker, maxContextTokens: sel.maxContextTokens });
}

/**
 * Capability/version negotiation against the live Herdr server (spec 03).
 * Throws when the server is unreachable or below the minimum protocol version,
 * so Pi-Engineering never assumes a Herdr capability that is not present.
 */
export async function negotiateHerdr(cli: HerdrCli, minProtocol?: number): Promise<void> {
  const st = await cli.status();
  if (!st.ok) throw new Error("Herdr server unreachable during capability negotiation");
  if (minProtocol !== undefined && st.protocol < minProtocol) {
    throw new Error(`Herdr protocol ${st.protocol} below required minimum ${minProtocol}`);
  }
}
