/**
 * Lifecycle telemetry (spec §24).
 *
 * Every routing choice, model invocation, review, verification and state
 * transition becomes one structured event. Events are OpenTelemetry-friendly
 * (name + attribute map) so they can be forwarded without reshaping, and are
 * written to a JSONL log plus a bounded in-memory buffer for `/engineering
 * status`.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AdmissionEvent } from "../inference/admissionEvents.ts";
import type { GateEvaluation, ModelRef, RoutingDecision } from "./types.ts";

export type TelemetryEventName =
  | "lifecycle.run.started"
  | "lifecycle.transition"
  | "lifecycle.gate.evaluated"
  | "lifecycle.remediation.requested"
  | "lifecycle.approval.decided"
  | "capability.refresh"
  | "routing.decision"
  | "model.invocation"
  | "review.completed"
  | "verification.completed"
  | "inference.retry.scheduled"
  | "inference.retry.waiting"
  | "inference.retry.started"
  | "inference.retry.succeeded"
  | "inference.retry.exhausted"
  | "inference.retry.cancelled"
  | "inference.fallback.triggered";

export interface TelemetryEvent {
  at: string;
  name: TelemetryEventName;
  runId?: string;
  sessionKey?: string;
  attributes: Record<string, string | number | boolean | undefined>;
  /** Trace-ish correlation so a whole lifecycle pass can be pulled up at once. */
  correlation?: string;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
  close(): Promise<void>;
}

/** In-memory sink with a bounded buffer; used by tests and as the read side. */
export class MemorySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  emit(event: TelemetryEvent): void {
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }

  async close(): Promise<void> {}

  recent(n = 20): TelemetryEvent[] {
    return this.events.slice(-n);
  }

  byRun(runId: string): TelemetryEvent[] {
    return this.events.filter((e) => e.runId === runId);
  }
}

/** JSONL file sink. Write failures degrade to dropping the event, never throwing. */
export class JsonlSink implements TelemetrySink {
  private writeChain: Promise<void> = Promise.resolve();
  readonly memory = new MemorySink(200);
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  emit(event: TelemetryEvent): void {
    this.memory.emit(event);
    const op = this.writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(event)}\n`, "utf-8");
    });
    this.writeChain = op.catch(() => {});
    void op;
  }

  async close(): Promise<void> {
    await this.writeChain;
  }

  recent(n = 20): TelemetryEvent[] {
    return this.memory.recent(n);
  }

  byRun(runId: string): TelemetryEvent[] {
    return this.memory.byRun(runId);
  }
}

export class LifecycleTelemetry {
  private readonly sinkList: TelemetrySink[];
  private readonly enabled: boolean;

  constructor(sinks: TelemetrySink[], enabled = true) {
    this.sinkList = sinks;
    this.enabled = enabled;
  }

  static file(path: string, enabled = true): LifecycleTelemetry {
    return new LifecycleTelemetry([new JsonlSink(path)], enabled);
  }

  static memory(enabled = true): LifecycleTelemetry {
    return new LifecycleTelemetry([new MemorySink()], enabled);
  }

  emit(
    name: TelemetryEventName,
    attributes: TelemetryEvent["attributes"],
    coords: { runId?: string; sessionKey?: string; correlation?: string } = {},
  ): void {
    if (!this.enabled) return;
    const event: TelemetryEvent = { at: new Date().toISOString(), name, attributes, ...coords };
    for (const sink of this.sinkList) sink.emit(event);
  }

  runStarted(args: { runId: string; sessionKey: string; request: string; categories: string[]; risk: string }): void {
    this.emit(
      "lifecycle.run.started",
      {
        run_id: args.runId,
        request_chars: args.request.length,
        categories: args.categories.join(","),
        risk: args.risk,
      },
      { runId: args.runId, sessionKey: args.sessionKey, correlation: args.runId },
    );
  }

  transition(args: {
    runId: string;
    sessionKey: string;
    from: string;
    to: string;
    trigger: string;
    detail?: string;
  }): void {
    this.emit(
      "lifecycle.transition",
      { from: args.from, to: args.to, trigger: args.trigger, detail: args.detail },
      { runId: args.runId, sessionKey: args.sessionKey, correlation: args.runId },
    );
  }

  routing(args: { runId?: string; sessionKey?: string; decision: RoutingDecision; attempt?: number }): void {
    this.emit(
      "routing.decision",
      {
        role: args.decision.role,
        selected: args.decision.selected
          ? `${args.decision.selected.provider}/${args.decision.selected.id}`
          : undefined,
        candidates: args.decision.candidates.length,
        rejected: args.decision.rejected.length,
        rejection_stages: [...new Set(args.decision.rejected.map((r) => r.stage))].join(","),
        override: args.decision.overrideApplied
          ? `${args.decision.overrideApplied.override}:${args.decision.overrideApplied.source}`
          : undefined,
        attempt: args.attempt ?? 0,
        rationale: args.decision.rationale.join(" | ").slice(0, 600),
        fallback_of: args.decision.fallbackOf
          ? `${args.decision.fallbackOf.provider}/${args.decision.fallbackOf.id}`
          : undefined,
      },
      { runId: args.runId, sessionKey: args.sessionKey, correlation: args.runId },
    );
  }

  invocation(args: {
    runId?: string;
    role: string;
    model: ModelRef;
    ok: boolean;
    durationMs: number;
    input?: number;
    output?: number;
    costUsd?: number;
    error?: string;
  }): void {
    this.emit(
      "model.invocation",
      {
        role: args.role,
        model: `${args.model.provider}/${args.model.id}`,
        ok: args.ok,
        duration_ms: args.durationMs,
        input_tokens: args.input,
        output_tokens: args.output,
        cost_usd: args.costUsd,
        error: args.error,
      },
      { runId: args.runId, correlation: args.runId },
    );
  }

  review(args: {
    runId: string;
    role: string;
    model: ModelRef;
    verdict: string;
    findings: number;
    blockers: number;
    durationMs: number;
  }): void {
    this.emit(
      "review.completed",
      {
        role: args.role,
        model: `${args.model.provider}/${args.model.id}`,
        verdict: args.verdict,
        findings: args.findings,
        blocking_findings: args.blockers,
        duration_ms: args.durationMs,
      },
      { runId: args.runId, correlation: args.runId },
    );
  }

  verification(args: {
    runId: string;
    stage: string;
    status: string;
    passed: number;
    failed: number;
    other: number;
    durationMs: number;
  }): void {
    this.emit(
      "verification.completed",
      {
        stage: args.stage,
        status: args.status,
        passed: args.passed,
        failed: args.failed,
        other: args.other,
        duration_ms: args.durationMs,
      },
      { runId: args.runId, correlation: args.runId },
    );
  }

  gate(args: { runId: string; gate: GateEvaluation; round: number }): void {
    this.emit(
      "lifecycle.gate.evaluated",
      {
        pass: args.gate.pass,
        round: args.round,
        blockers: args.gate.blockers.length,
        blocker_detail: args.gate.blockers.join(" | ").slice(0, 800),
        items: args.gate.items.map((i) => `${i.key}=${i.status}`).join(","),
      },
      { runId: args.runId, correlation: args.runId },
    );
  }

  approval(args: {
    runId?: string;
    command: string;
    risk: string;
    decision: string;
    approved?: boolean;
    reason: string;
  }): void {
    this.emit(
      "lifecycle.approval.decided",
      {
        risk: args.risk,
        decision: args.decision,
        approved: args.approved,
        reason: args.reason,
        command_chars: args.command.length,
      },
      { runId: args.runId, correlation: args.runId },
    );
  }

  refresh(args: { models: number; sources: string; changed: boolean; reason: string; errors?: string }): void {
    this.emit("capability.refresh", {
      models: args.models,
      sources: args.sources,
      changed: args.changed,
      reason: args.reason,
      errors: args.errors,
    });
  }

  /** Most recent events across the first memory-backed sink (for diagnostics). */
  recent(n = 100): TelemetryEvent[] {
    for (const sink of this.sinkList) {
      const maybe = sink as { recent?: (k: number) => TelemetryEvent[] };
      if (typeof maybe.recent === "function") return maybe.recent(n);
    }
    return [];
  }

  async close(): Promise<void> {
    for (const sink of this.sinkList) await sink.close();
  }

  get sinks(): TelemetrySink[] {
    return this.sinkList;
  }
}

/** Map one admission-bus event to a lifecycle telemetry event. */
export function admissionToTelemetry(event: AdmissionEvent): TelemetryEvent {
  return {
    at: event.at,
    name: event.name as TelemetryEventName,
    runId: event.runId,
    sessionKey: event.sessionId,
    correlation: event.logicalRequestId,
    attributes: {
      provider: event.provider,
      model: event.model,
      logical_request_id: event.logicalRequestId,
      server_request_id: event.serverRequestId,
      reason: event.reason,
      http_status: event.httpStatus,
      attempt: event.attempt,
      max_attempts: event.maxAttempts,
      retry_after_ms: event.retryAfterMs,
      delay_used_ms: event.delayUsedMs,
      delay_source: event.delaySource,
      elapsed_wait_ms: event.elapsedWaitMs,
      active: event.activeWorkers,
      active_limit: event.workerLimit,
      queued: event.queueDepth,
      queue_limit: event.queueLimit,
      classification: event.classification,
      terminated_by: event.terminatedBy,
      session_id: event.sessionId,
      agent_id: event.agentId,
      role: event.role,
      worker_id: event.workerId,
    },
  };
}

/** Subscribe a lifecycle telemetry to an admission event bus. Returns unsubscribe. */
export function bridgeAdmissionToTelemetry(
  bus: { subscribe(listener: (event: AdmissionEvent) => void): () => void },
  telemetry: LifecycleTelemetry,
  enabled = true,
): () => void {
  if (!enabled) return () => {};
  return bus.subscribe((event) => {
    telemetry.emit(admissionToTelemetry(event).name, admissionToTelemetry(event).attributes, {
      runId: event.runId,
      sessionKey: event.sessionId,
      correlation: event.logicalRequestId,
    });
  });
}

/** Aggregate telemetry into the metrics a reviewer of the system itself wants. */
export interface LifecycleMetrics {
  runs: number;
  passes: number;
  escalations: number;
  averageRemediationRounds: number;
  routingFailures: number;
  modelInvocations: number;
  failedInvocations: number;
  totalCostUsd: number;
  reviewsByRole: Record<string, { approve: number; request_changes: number; failed: number }>;
}

export function summarizeMetrics(events: TelemetryEvent[]): LifecycleMetrics {
  const metrics: LifecycleMetrics = {
    runs: 0,
    passes: 0,
    escalations: 0,
    averageRemediationRounds: 0,
    routingFailures: 0,
    modelInvocations: 0,
    failedInvocations: 0,
    totalCostUsd: 0,
    reviewsByRole: {},
  };
  const roundTotals: number[] = [];
  for (const event of events) {
    switch (event.name) {
      case "lifecycle.run.started":
        metrics.runs++;
        break;
      case "lifecycle.transition":
        if (event.attributes.to === "COMPLETE") metrics.passes++;
        if (event.attributes.to === "ESCALATED") metrics.escalations++;
        if (event.attributes.to === "REMEDIATING") {
          const round = Number(event.attributes.round ?? 0);
          if (round > 0) roundTotals.push(round);
        }
        break;
      case "routing.decision":
        if (!event.attributes.selected) metrics.routingFailures++;
        break;
      case "model.invocation":
        metrics.modelInvocations++;
        if (event.attributes.ok !== true) metrics.failedInvocations++;
        metrics.totalCostUsd += Number(event.attributes.cost_usd ?? 0);
        break;
      case "review.completed": {
        const role = String(event.attributes.role ?? "unknown");
        let bucket = metrics.reviewsByRole[role];
        if (!bucket) {
          bucket = { approve: 0, request_changes: 0, failed: 0 };
          metrics.reviewsByRole[role] = bucket;
        }
        const verdict = String(event.attributes.verdict ?? "failed");
        if (verdict === "approve") bucket.approve++;
        else if (verdict === "request_changes") bucket.request_changes++;
        else bucket.failed++;
        break;
      }
      default:
        break;
    }
  }
  metrics.averageRemediationRounds = roundTotals.length
    ? roundTotals.reduce((a, b) => a + b, 0) / roundTotals.length
    : 0;
  return metrics;
}

export function defaultTelemetryFile(persistDir: string): string {
  return join(persistDir, "telemetry.jsonl");
}
