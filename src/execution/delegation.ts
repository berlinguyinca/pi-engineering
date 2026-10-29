/**
 * Delegation advice per execution preference (Missionless Execution Fabric,
 * phase 4). Pure: it never starts anything. `direct` and `adaptive` stay silent
 * so ordinary interactive behaviour is unchanged; `team` is an explicit opt-in
 * that tells the foreground agent to coordinate parallel agents. No preference
 * creates a Mission or relaxes review, verification or risk gates.
 */
import type { ExecutionPreference } from "../lifecycle/policy.ts";
import type { AutoInvokeDecision } from "../orchestration/autoInvoke.ts";

export interface DelegationAdvice {
  advise: boolean;
  /** Why advice was or was not given; surfaced for comparison and debugging. */
  reason: string;
  message?: string;
}

const TEAM_MESSAGE =
  "[pi-engineering] Execution preference: team. For this engineering request, split independent parts across separate agents or sessions where the harness supports delegation, keep one owner for integration, and record each handover through the verified handoff protocol so the receiving agent acknowledges it. Delegation never replaces review or verification: every part still needs its own evidence before the work is called done. Do not create a Mission unless the user asks for one.";

export function delegationAdvice(preference: ExecutionPreference, classified: AutoInvokeDecision): DelegationAdvice {
  if (!classified.invoke) return { advise: false, reason: `not an engineering request: ${classified.reason}` };
  if (preference === "team") return { advise: true, reason: "team preference", message: TEAM_MESSAGE };
  return { advise: false, reason: `${preference} preference delegates only on explicit request` };
}
