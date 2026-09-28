import { redactSecrets } from "../security/SecurityPolicy.ts";
import type { WorkerActivity } from "./WorkerExecutor.ts";
import type { CheckpointProgressClaim } from "./checkpointProgressTool.ts";

export const MAX_WORKER_ACTIVITY_SUMMARY = 160;

function safeToolName(value: unknown): string {
  if (typeof value !== "string") return "tool";
  const safe = safeText(value, 64).match(/^[A-Za-z0-9_.:-]+/)?.[0] ?? "tool";
  return safe.slice(0, 64) || "tool";
}

function safeText(value: string, max = MAX_WORKER_ACTIVITY_SUMMARY): string {
  const withoutControls = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  return redactSecrets(withoutControls).replace(/\s+/g, " ").trim().slice(0, max);
}

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function safeDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(0, value), Number.MAX_SAFE_INTEGER)
    : undefined;
}

function safeCheckpointClaims(value: unknown): CheckpointProgressClaim[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const claims = value.slice(0, 32).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const claim = entry as Partial<CheckpointProgressClaim>;
    const deliverable = typeof claim.deliverable === "string" ? safeText(claim.deliverable) : "";
    const candidateSha = typeof claim.candidateSha === "string" ? safeText(claim.candidateSha) : "";
    const evidencePaths = Array.isArray(claim.evidencePaths)
      ? claim.evidencePaths
          .filter((path): path is string => typeof path === "string")
          .map((path) => safeText(path, 1000))
          .filter(Boolean)
          .slice(0, 64)
      : [];
    const artifactRefs = Array.isArray(claim.artifactRefs)
      ? claim.artifactRefs
          .filter((ref): ref is string => typeof ref === "string")
          .map((ref) => safeText(ref, 1000))
          .filter(Boolean)
          .slice(0, 32)
      : [];
    return deliverable && candidateSha && evidencePaths.length > 0
      ? [{ deliverable, candidateSha, evidencePaths, artifactRefs }]
      : [];
  });
  return claims.length > 0 ? claims : undefined;
}

const STAGES = new Set(["agent", "process", "review", "integration", "validation", "research"] as const);

function safeStage(value: unknown): WorkerActivity["stage"] {
  return typeof value === "string" && STAGES.has(value as NonNullable<WorkerActivity["stage"]>)
    ? (value as NonNullable<WorkerActivity["stage"]>)
    : undefined;
}

function stageLabel(stage: WorkerActivity["stage"]): string {
  return stage ? `${stage[0]!.toUpperCase()}${stage.slice(1)}` : "Execution";
}

/** Canonicalize arbitrary callback input at the runtime trust boundary. */
export function sanitizeWorkerActivity(value: unknown): WorkerActivity | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<WorkerActivity>;
  if (input.kind === "checkpoint") {
    const claims = safeCheckpointClaims(input.claims);
    if (!claims) return null;
    return { kind: "checkpoint", summary: "Checkpoint progress recorded", meaningfulProgress: true, claims };
  }
  if (input.kind === "tool") {
    if (input.phase !== "started" && input.phase !== "completed" && input.phase !== "failed") return null;
    const toolName = safeToolName(input.toolName);
    const verb =
      input.phase === "started" ? "Running tool" : input.phase === "completed" ? "Finished tool" : "Tool failed";
    return { kind: "tool", phase: input.phase, toolName, summary: `${verb}: ${toolName}`, meaningfulProgress: false };
  }
  if (input.kind === "heartbeat") {
    const elapsedMs = safeDuration(input.elapsedMs);
    const lastActivityMs = safeDuration(input.lastActivityMs);
    const stage = safeStage(input.stage);
    const summary =
      elapsedMs === undefined
        ? `${stageLabel(stage)} still running`
        : `${stageLabel(stage)} still running · elapsed ${duration(elapsedMs)}${lastActivityMs === undefined ? "" : ` · last activity ${duration(lastActivityMs)} ago`}`;
    return {
      kind: "heartbeat",
      summary: safeText(summary),
      meaningfulProgress: false,
      stage,
      elapsedMs,
      lastActivityMs,
    };
  }
  if (input.kind === "execution") {
    const stage = safeStage(input.stage);
    if (!stage || !input.phase || !["started", "completed", "failed", "canceled"].includes(input.phase)) return null;
    const verb = input.phase === "canceled" ? "canceled" : input.phase;
    return {
      kind: "execution",
      phase: input.phase,
      stage,
      summary: `${stageLabel(stage)} ${verb}`,
      meaningfulProgress: input.phase === "completed",
    };
  }
  if (input.kind === "state") {
    if (
      input.phase !== undefined &&
      input.phase !== "started" &&
      input.phase !== "completed" &&
      input.phase !== "failed" &&
      input.phase !== "canceled"
    ) {
      return null;
    }
    if (input.phase === "completed") {
      return { kind: "state", phase: "completed", summary: "Worker session completed", meaningfulProgress: true };
    }
    if (input.phase === "failed") {
      return { kind: "state", phase: "failed", summary: "Worker session failed", meaningfulProgress: false };
    }
    if (input.phase === "canceled") {
      return { kind: "state", phase: "canceled", summary: "Worker session canceled", meaningfulProgress: false };
    }
    const summary = input.summary === "Model response received" ? input.summary : "Worker session started";
    return {
      kind: "state",
      ...(input.phase ? { phase: input.phase } : {}),
      summary,
      meaningfulProgress: false,
    };
  }
  return null;
}

/**
 * Translate Pi session events into a deliberately small public activity shape.
 * Tool arguments and assistant content are never inspected or copied.
 */
export function activityFromSessionEvent(event: {
  type?: string;
  toolName?: unknown;
  isError?: boolean;
  message?: unknown;
  [key: string]: unknown;
}): WorkerActivity | null {
  if (event.type === "tool_execution_start") {
    const toolName = safeToolName(event.toolName);
    return sanitizeWorkerActivity({
      kind: "tool",
      phase: "started",
      toolName,
      summary: `Running tool: ${toolName}`,
      meaningfulProgress: false,
    });
  }
  if (event.type === "tool_execution_end") {
    const toolName = safeToolName(event.toolName);
    const failed = event.isError === true;
    return sanitizeWorkerActivity({
      kind: "tool",
      phase: failed ? "failed" : "completed",
      toolName,
      summary: `${failed ? "Tool failed" : "Finished tool"}: ${toolName}`,
      // Completion of an arbitrary tool call is activity, not proof that the
      // repository or task advanced. The orchestrator's DAG remains authoritative.
      meaningfulProgress: false,
    });
  }
  if (event.type === "message_end") {
    const role = (event.message as { role?: unknown } | undefined)?.role;
    if (role === "assistant") {
      return { kind: "state", summary: "Model response received", meaningfulProgress: false };
    }
  }
  return null;
}

export function emitWorkerActivity(req: { onActivity?: (event: WorkerActivity) => void }, event: WorkerActivity): void {
  const safe = sanitizeWorkerActivity(event);
  if (!safe) return;
  try {
    req.onActivity?.(safe);
  } catch {
    // Activity observers must never participate in worker execution.
  }
}
