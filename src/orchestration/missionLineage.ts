/**
 * Mission-level lineage for the plan entry points (standalone `plan` and `plan --from-autospec`).
 *
 * Pi remains the authority; this only PROJECTS what the ledger already holds into the Herdr graph, through the same
 * LineageEmitter every other hook uses (so room/workspace/mission scope, visibility, the instance stamp and keyed
 * event ids apply). Absent emitter = no-op: a standalone Pi with no `herdr:` block emits and connects to nothing.
 */

import { join } from "node:path";
import { type LineageEmitter, lineageNodeId } from "../runtime/herdr/lineage.ts";
import { loadLineageEmitter } from "../runtime/herdr/lineageConfig.ts";

export interface PlanCliLineageDeps {
  /** Test seam: the emitter to use instead of the one the global YAML configures (null = none). */
  emitter?: unknown;
  /** Test seams for the YAML-built emitter: where its outbox lives and which fetch it uses. */
  lineageDir?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * The emitter for a short-lived CLI: built ONLY from the `herdr:` block of the GLOBAL engineering.yaml (same agent-dir
 * rule as the other CLI settings: `PI_CODING_AGENT_DIR` in the injected env, else `~/.pi/agent`). No block, no
 * `lineage: true`, an unsafe key file or a bad URL => null, and the CLI does not touch the network.
 */
export async function loadPlanCliLineage(
  env: NodeJS.ProcessEnv,
  deps: PlanCliLineageDeps = {},
): Promise<LineageEmitter | null> {
  if (deps.emitter !== undefined) return null; // an injected plan emitter (tests) replaces the YAML-built one
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? "~", ".pi", "agent");
  return loadLineageEmitter({
    yamlOnly: true,
    agentDir,
    ...(deps.lineageDir ? { envelopeDir: deps.lineageDir } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

export interface MissionLineageInput {
  missionId: string;
  /** Bounded display title. The goal text itself is never sent. */
  title: string;
  /** Where the plan came from. */
  source: "standalone" | "autospec";
}

/** The mission node. State `pending` only: planning has not started any work, and nothing is claimed beyond that. */
export function emitMissionPlanned(lineage: LineageEmitter | null | undefined, input: MissionLineageInput): void {
  if (!lineage) return;
  lineage.nodeUpsert(
    lineageNodeId("mission", input.missionId),
    { label: input.title, state: "pending", attrs: { source: input.source } },
    "planned",
    { mission_id: input.missionId },
  );
}
