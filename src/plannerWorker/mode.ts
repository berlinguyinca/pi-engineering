/**
 * `auto` execution-mode selection (spec §26).
 *
 * Auto picks planner-worker for nontrivial engineering missions when the
 * gateway advertises the roles and can actually separate planning from
 * implementation (distinct models available); otherwise the existing
 * single-model workflow runs unchanged. Deliberately a transparent heuristic:
 * learned routing is out of scope — telemetry is collected so a later version
 * can learn it.
 */

import type { RoleResolver } from "./resolver.ts";
import { servedIdentity } from "./roles.ts";
import type { EngineeringMode } from "./types.ts";

const ENGINEERING_VERBS =
  /\b(implement|add|build|create|refactor|migrate|integrate|rewrite|introduce|support|extend|redesign|port|replace|split)\b/i;
const TRIVIAL = /^(what|why|how|explain|show|list|where|who|when)\b|\btypo\b|\brename\b/i;

/** Nontrivial = an engineering change with some breadth, not a question or a one-liner. */
export function isNontrivialMission(goal: string): { nontrivial: boolean; reason: string } {
  const text = goal.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  if (TRIVIAL.test(text) && words < 12) return { nontrivial: false, reason: "question or trivial edit" };
  if (!ENGINEERING_VERBS.test(text)) return { nontrivial: false, reason: "no engineering change requested" };
  const clauses = text.split(/\band\b|[,;]|\bthen\b/i).length;
  if (words >= 8 || clauses >= 2) return { nontrivial: true, reason: `${words} words, ${clauses} clause(s)` };
  return { nontrivial: false, reason: "short single change" };
}

export interface ModeDecision {
  mode: "planner-worker" | "single";
  reason: string;
}

export async function chooseExecutionMode(
  requested: EngineeringMode,
  goal: string,
  resolver: RoleResolver,
): Promise<ModeDecision> {
  if (requested === "single") return { mode: "single", reason: "mode is single" };
  if (requested === "planner-worker") return { mode: "planner-worker", reason: "mode is planner-worker" };
  const shape = isNontrivialMission(goal);
  if (!shape.nontrivial) return { mode: "single", reason: `auto: ${shape.reason}` };
  await resolver.refresh();
  if (!resolver.catalog().some((m) => m.alias || m.capabilities.length > 0)) {
    return { mode: "single", reason: "auto: the gateway does not advertise role capabilities" };
  }
  const planner = await resolver.resolve("planner");
  const implementer = await resolver.resolve("implementer", planner ? [servedIdentity(planner)] : []);
  if (!planner || !implementer) return { mode: "single", reason: "auto: roles are not resolvable on this host" };
  // Auto only engages when the gateway itself advertises the roles (aliases or
  // capabilities); static pins alone keep the existing workflow unless the
  // operator selects planner-worker explicitly.
  if (planner.via === "static" || implementer.via === "static") {
    return { mode: "single", reason: "auto: the gateway does not advertise role capabilities" };
  }
  if (servedIdentity(planner) === servedIdentity(implementer)) {
    return { mode: "single", reason: "auto: no distinct planner and implementer models available" };
  }
  return {
    mode: "planner-worker",
    reason: `auto: nontrivial mission (${shape.reason}); planner ${servedIdentity(planner)}, implementer ${servedIdentity(implementer)}`,
  };
}
