import { createHmac, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { redactSecrets } from "../security/SecurityPolicy.ts";
import type { WorkerActivity } from "./WorkerExecutor.ts";
import { buildToolOf, isBuildTool } from "./buildActivity.ts";
import type { CheckpointProgressClaim } from "./checkpointProgressTool.ts";

export const MAX_WORKER_ACTIVITY_SUMMARY = 160;
export const MAX_WORKER_OUTPUT_PREVIEW = 1000;

/** Redact before truncating, so a tail boundary cannot cut off a secret's prefix. */
export function safeWorkerOutputPreview(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const plain = [...stripVTControlCharacters(value).replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, "")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      // Keep line breaks for multiline private-key redaction. Strip other
      // controls before redaction so they cannot split a credential prefix.
      return code === 9 || code === 10 || code === 13 || (code >= 32 && (code < 127 || code > 159));
    })
    .join("");
  const redacted = redactSecrets(plain);
  const clean = [...redacted]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(-MAX_WORKER_OUTPUT_PREVIEW) || undefined;
}

function toolOutputPreview(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  return safeWorkerOutputPreview(
    content
      .flatMap((block: unknown) => {
        if (!block || typeof block !== "object") return [];
        const item = block as { type?: unknown; text?: unknown };
        return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
      })
      .join("\n"),
  );
}

/** Live context size of a worker session; carries `context` (numbers + model id), never content. */
export const CONTEXT_USAGE_SUMMARY = "Context usage";
/** The provider refused the run for quota; carries `inferenceFailure: "quota"`. A distinct cause from context pressure. */
export const QUOTA_EXHAUSTED_SUMMARY = "Inference quota exhausted";
const SAFE_MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,128}$/;

/** Per-turn summary (mission.obs.worker): fixed shape, so the metrics are computable from events. */
export const TURN_SUMMARY = /^Turn ended: stop=[a-zA-Z_]{1,32} tool_error=[a-z_]{1,32}$/;

const FILE_TOOLS = new Set(["read", "edit", "write"]);
const COMMAND_LABELS = new Set([
  "npm test",
  "npm run test",
  "npm run build",
  "npm run lint",
  "npm run typecheck",
  "pnpm test",
  "pnpm build",
  "pnpm lint",
  "pnpm run test",
  "pnpm run build",
  "pnpm run lint",
  "pnpm run typecheck",
  "yarn test",
  "yarn build",
  "yarn lint",
  "yarn typecheck",
  "cargo test",
  "cargo build",
  "cargo check",
  "cargo clippy",
  "go test",
  "go build",
  "go vet",
  "git diff",
  "git status",
  "git log",
  "git show",
  "git add",
  "git commit",
  "tsc",
  "pytest",
  "ruff check",
  "ruff format",
  "biome check",
  "biome format",
]);
// A process-local key makes low-entropy secret arguments impractical to recover
// from a public signature. Loop evidence naturally restarts with the runtime.
const INVOCATION_KEY = randomBytes(32);

function invocationSignature(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  let visited = 0;
  const canonicalize = (value: unknown, depth = 0): unknown => {
    if (++visited > 10_000 || depth > 20) throw new Error("Unbounded tool arguments");
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, depth + 1));
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry, depth + 1)]),
    );
  };
  try {
    const serialized = JSON.stringify([toolName, canonicalize(args)]);
    if (serialized.length > 1_000_000) return undefined;
    return createHmac("sha256", INVOCATION_KEY).update(serialized).digest("hex");
  } catch {
    return undefined;
  }
}

function safeToolTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) return undefined;
  // Refuse terminal controls, bidi overrides and URLs; file details must not
  // smuggle terminal instructions, credentials or query strings into the bar.
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    }) ||
    /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]|:\/\/|[?#]/u.test(value)
  )
    return undefined;
  const redacted = redactSecrets(value.trim()).replaceAll("\\", "/");
  const normalized = posix.normalize(redacted).replace(/^\/(?:home|Users)\/[^/]+\//, "~/");
  return safeText(normalized, 112) || undefined;
}

export function safeToolCommandLabel(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  // Inspect only the first literal executable and verb. Do not parse shell
  // substitutions, environment assignments, quoting or arbitrary npm scripts.
  const words = command.trim().split(/\s+/);
  if (words[0] === "npx" || (words[0] === "pnpm" && words[1] === "exec")) {
    words.splice(0, words[0] === "npx" ? 1 : 2);
  }
  for (const count of [3, 2, 1]) {
    const label = words.slice(0, count).join(" ");
    if (COMMAND_LABELS.has(label)) return label;
  }
  return undefined;
}

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
    if (deliverable && claim.tipBound === true)
      return [{ deliverable, candidateSha: "", evidencePaths: [], artifactRefs: [], tipBound: true }];
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
    // Only a label from the fixed BUILD_TOOLS set crosses this boundary, and
    // a build's duration only on its completion.
    const buildTool = isBuildTool(input.buildTool) ? input.buildTool : undefined;
    const elapsedMs = buildTool && input.phase !== "started" ? safeDuration(input.elapsedMs) : undefined;
    const toolTarget = FILE_TOOLS.has(toolName) ? safeToolTarget(input.toolTarget) : undefined;
    const toolCommand =
      toolName === "bash" && typeof input.toolCommand === "string" && COMMAND_LABELS.has(input.toolCommand)
        ? input.toolCommand
        : undefined;
    const signature =
      typeof input.invocationSignature === "string" && /^[a-f0-9]{64}$/.test(input.invocationSignature)
        ? input.invocationSignature
        : undefined;
    const detail = toolTarget ?? toolCommand;
    const outputPreview = input.phase !== "started" ? safeWorkerOutputPreview(input.outputPreview) : undefined;
    return {
      kind: "tool",
      phase: input.phase,
      toolName,
      summary: safeText(`${verb}: ${toolName}${detail ? ` · ${detail}` : ""}`),
      meaningfulProgress: false,
      ...(buildTool ? { buildTool } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(toolTarget ? { toolTarget } : {}),
      ...(toolCommand ? { toolCommand } : {}),
      ...(signature ? { invocationSignature: signature } : {}),
      ...(outputPreview ? { outputPreview } : {}),
    };
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
  if (input.kind === "state" && input.summary === CONTEXT_USAGE_SUMMARY && input.phase === undefined) {
    const c = input.context;
    if (
      !c ||
      !Number.isFinite(c.tokens) ||
      !Number.isFinite(c.window) ||
      c.tokens < 0 ||
      c.window <= 0 ||
      typeof c.model !== "string" ||
      !SAFE_MODEL_ID.test(c.model)
    ) {
      return null;
    }
    return {
      kind: "state",
      summary: CONTEXT_USAGE_SUMMARY,
      meaningfulProgress: false,
      context: { tokens: Math.round(c.tokens), window: Math.round(c.window), model: c.model },
    };
  }
  if (input.kind === "state" && input.summary === QUOTA_EXHAUSTED_SUMMARY && input.phase === undefined) {
    if (input.inferenceFailure !== "quota") return null;
    return { kind: "state", summary: QUOTA_EXHAUSTED_SUMMARY, meaningfulProgress: false, inferenceFailure: "quota" };
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
    const summary =
      input.summary === "Model response received" ||
      input.summary === STREAMING_SUMMARY ||
      input.summary === WAITING_FOR_INFERENCE_SUMMARY ||
      input.summary === AWAITING_MODEL_RESPONSE_SUMMARY ||
      input.summary === TOOL_PROGRESS_SUMMARY ||
      (typeof input.summary === "string" && TURN_SUMMARY.test(input.summary))
        ? input.summary
        : "Worker session started";
    const outputPreview = summary === TOOL_PROGRESS_SUMMARY ? safeWorkerOutputPreview(input.outputPreview) : undefined;
    return {
      kind: "state",
      ...(input.phase ? { phase: input.phase } : {}),
      summary,
      meaningfulProgress: false,
      ...(outputPreview ? { outputPreview } : {}),
    };
  }
  return null;
}

/**
 * Translate Pi session events into a deliberately small public activity shape.
 * Assistant content and raw tool arguments are never copied. Known file tools
 * expose a normalized/redacted path; shell operations expose only fixed labels.
 * Invocation signatures distinguish repeated calls without exposing arguments.
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
    const args = event.args as { command?: unknown; path?: unknown } | undefined;
    const buildTool = toolName === "bash" ? buildToolOf(args?.command) : undefined;
    return sanitizeWorkerActivity({
      kind: "tool",
      phase: "started",
      toolName,
      summary: `Running tool: ${toolName}`,
      meaningfulProgress: false,
      ...(buildTool ? { buildTool } : {}),
      toolTarget: FILE_TOOLS.has(toolName) ? safeToolTarget(args?.path) : undefined,
      toolCommand: toolName === "bash" ? safeToolCommandLabel(args?.command) : undefined,
      invocationSignature: invocationSignature(toolName, event.args),
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
      outputPreview: toolOutputPreview(event.result),
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

const STREAMING_SUMMARY = "Model streaming";

/**
 * A worker holding for the model gateway (admission, queue, cooldown). It is
 * liveness, not progress: the owner's inactivity watchdog must never treat a
 * worker waiting for inference capacity as hung.
 */
export const WAITING_FOR_INFERENCE_SUMMARY = "Waiting for inference capacity";

/**
 * A non-streaming model request still in flight on an open connection: the
 * answer arrives all at once, so the open request is the sign of life.
 */
export const AWAITING_MODEL_RESPONSE_SUMMARY = "Awaiting model response";

/**
 * A running tool (a long test suite, a build) that keeps producing output. It
 * is liveness: only a tool silent for the whole inactivity window looks hung.
 */
export const TOOL_PROGRESS_SUMMARY = "Tool still producing output";

/**
 * Streamed tokens are activity: a worker writing a long answer is not idle,
 * and its heartbeat's "last activity" must not read as minutes of silence.
 * Token events arrive per delta, so they are reduced to one bounded state
 * activity per interval. Model content is never inspected or copied; actual tool
 * updates carry only a redacted, bounded preview of text output.
 */
export class StreamingActivityThrottle {
  private lastAt = Number.NEGATIVE_INFINITY;
  private lastToolAt = Number.NEGATIVE_INFINITY;
  private readonly intervalMs: number;

  constructor(intervalMs = 30_000) {
    this.intervalMs = intervalMs;
  }

  note(
    event: { type?: string; message?: unknown; partialResult?: unknown },
    nowMs: number = Date.now(),
  ): WorkerActivity | null {
    if (event.type === "tool_execution_update") {
      if (nowMs - this.lastToolAt < this.intervalMs) return null;
      this.lastToolAt = nowMs;
      const outputPreview = toolOutputPreview(event.partialResult);
      return {
        kind: "state",
        summary: TOOL_PROGRESS_SUMMARY,
        meaningfulProgress: false,
        ...(outputPreview ? { outputPreview } : {}),
      };
    }
    if (event.type !== "message_update") return null;
    if ((event.message as { role?: unknown } | undefined)?.role !== "assistant") return null;
    if (nowMs - this.lastAt < this.intervalMs) return null;
    this.lastAt = nowMs;
    return { kind: "state", summary: STREAMING_SUMMARY, meaningfulProgress: false };
  }
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
