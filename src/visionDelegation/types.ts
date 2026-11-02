/** Public types of the vision delegator (re-exported from `delegate.ts`). */

import type { SessionHandoffMessage } from "../plannerWorker/sessionHandoff.ts";
import type { ProbeResult } from "../resilience/probe.ts";
import type { HerdrCli } from "../runtime/herdr/HerdrCli.ts";
import type { VisionDelegateSettings } from "./config.ts";
import type { VisionRegistry } from "./registry.ts";

export type LineageOutcome = "ok" | "partial" | "failed" | "timeout";

export interface LineageEvent {
  phase: "out" | "back";
  requestId: string;
  fromSession: string;
  toSession: string | null;
  fromModel: string;
  toModel: string;
  outcome: LineageOutcome;
}

export interface VisionDelegatorDeps {
  herdr: HerdrCli;
  settings: VisionDelegateSettings;
  models: Array<{ provider: string; id: string; input?: string[] }>;
  probeFor: (m: { provider: string; id: string }) => Promise<ProbeResult>;
  registry: VisionRegistry;
  artifactDir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
  lineage?: (e: LineageEvent) => void;
  /** Id of the current text model (lineage `fromModel`). */
  textModel: string;
  /** Pane the vision pane splits from (the caller's HERDR_PANE_ID). Absent means herdr is unavailable. */
  originPaneId?: string;
}

export interface VisionDelegateInput {
  sessionId: string;
  cwd: string;
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  messages: SessionHandoffMessage[];
  signal?: AbortSignal;
  status?: (text: string | undefined) => void;
}

export type VisionDelegateOutput = { action: "continue" } | { action: "transform"; text: string; images: [] };
