/**
 * Report which Pi runtime this agent is on to the control plane, as part of its existing session record.
 * Best-effort and non-blocking like every other ingest call; runtime metrics only (inference metrics stay
 * in the inference telemetry). Sent once at start and then on a slow interval so CPU/RSS stay current.
 */
import { runtimeFacts } from "../runtimeFacts.ts";
import type { ControlPlaneIngest } from "./ControlPlaneIngest.ts";

export interface RuntimeReporter {
  stop(): void;
}

export function reportRuntimeFacts(
  ingest: Pick<ControlPlaneIngest, "session">,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  intervalMs = 60_000,
): RuntimeReporter {
  const missionId = env.PI_ENGINEERING_MISSION_ID?.trim() || undefined;
  const role = env.PI_ENGINEERING_ROLE?.trim() || undefined;
  const send = () =>
    void ingest
      .session(sessionId, "session.updated", {
        ...(missionId ? { missionId } : {}),
        ...(role ? { agentRole: role } : {}),
        runtime: runtimeFacts() as unknown as Record<string, unknown>,
      })
      .catch(() => {});
  send();
  const timer = setInterval(send, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
