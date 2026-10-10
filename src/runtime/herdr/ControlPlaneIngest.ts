/**
 * ControlPlaneIngest — non-blocking, best-effort emitter for the HerdR Dev
 * Fabric control plane (Phase 2 emitter).
 *
 * POSTs agent / session / host / mission lifecycle events to the control
 * plane at http://dev.lan/api/v1/ingest. This client is deliberately:
 *
 *   - NON-BLOCKING: `emit()` returns immediately; sends are fire-and-forget
 *     and never awaited by callers.
 *   - BEST-EFFORT: every send failure (network, timeout, non-2xx, throw) is
 *     swallowed. It never throws to callers and never affects the runtime.
 *   - OFF-BY-DEFAULT: `enabled` defaults to false, so no network traffic is
 *     produced unless a caller opts in.
 *
 * Entity mapping (HerdR Dev Fabric control-plane vocabulary):
 *   host    = machine (hostname)
 *   mission = pi-engineering mission (missionId carried on AgentWorkerRequest)
 *   session = individual agent worker (RuntimeId)
 *   agent   = the agent process/worker (kept for parity with agent events)
 */

import { hostname as osHostname } from "node:os";

/** Control-plane entity kinds emitted by the ingest client. */
export type ControlPlaneEntity = "host" | "mission" | "session" | "agent";

/** A single lifecycle event POSTed to the control-plane ingest endpoint. */
export interface ControlPlaneIngestEvent {
  entity: ControlPlaneEntity;
  /** Lifecycle action, e.g. "created" | "started" | "working" | "completed". */
  action: string;
  /** Opaque id of the entity this event describes. */
  entityId: string;
  /** ISO-8601 timestamp of the event. */
  at: string;
  /** pi-engineering mission id (mission/session events). */
  missionId?: string;
  /** host/machine id (hostname). */
  host?: string;
  /** session id (individual agent worker / RuntimeId). */
  sessionId?: string;
  /** agent id (the agent process). */
  agentId?: string;
  /** Optional structured payload. */
  payload?: Record<string, unknown>;
}

export interface ControlPlaneIngestOptions {
  /** Master switch; defaults to false (off-by-default). */
  enabled?: boolean;
  /** Control-plane ingest endpoint; defaults to http://dev.lan/api/v1/ingest. */
  endpoint?: string;
  /** Host/machine id; defaults to the OS hostname. */
  hostname?: string;
  /** Per-request timeout in ms; defaults to 1500. */
  timeoutMs?: number;
  /** Injectable fetch (tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = "http://dev.lan/api/v1/ingest";
const DEFAULT_TIMEOUT_MS = 1500;

export class ControlPlaneIngest {
  readonly enabled: boolean;
  private readonly endpoint: string;
  private readonly hostname: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(opts: ControlPlaneIngestOptions = {}) {
    this.enabled = opts.enabled ?? false;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.hostname = opts.hostname ?? osHostname();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  /** Emit a raw lifecycle event. Fire-and-forget; never throws. */
  emit(ev: ControlPlaneIngestEvent): void {
    if (!this.enabled) return;
    const send = this.send(ev);
    this.inFlight.add(send);
    void send
      .catch(() => {})
      .finally(() => {
        this.inFlight.delete(send);
      });
  }

  /** Host/machine lifecycle event (host = machine). */
  host(action: string, payload?: Record<string, unknown>): void {
    this.emit({
      entity: "host",
      action,
      entityId: this.hostname,
      host: this.hostname,
      at: new Date().toISOString(),
      payload,
    });
  }

  /** pi-engineering mission lifecycle event (mission = missionId). */
  mission(action: string, missionId: string, payload?: Record<string, unknown>): void {
    this.emit({
      entity: "mission",
      action,
      entityId: missionId,
      missionId,
      host: this.hostname,
      at: new Date().toISOString(),
      payload,
    });
  }

  /** Session lifecycle event (session = individual agent worker / RuntimeId). */
  session(
    action: string,
    sessionId: string,
    opts: { missionId?: string; payload?: Record<string, unknown> } = {},
  ): void {
    this.emit({
      entity: "session",
      action,
      entityId: sessionId,
      sessionId,
      missionId: opts.missionId,
      host: this.hostname,
      at: new Date().toISOString(),
      payload: opts.payload,
    });
  }

  /** Agent process lifecycle event. */
  agent(
    action: string,
    agentId: string,
    opts: { missionId?: string; sessionId?: string; payload?: Record<string, unknown> } = {},
  ): void {
    this.emit({
      entity: "agent",
      action,
      entityId: agentId,
      agentId,
      sessionId: opts.sessionId,
      missionId: opts.missionId,
      host: this.hostname,
      at: new Date().toISOString(),
      payload: opts.payload,
    });
  }

  /**
   * Await all in-flight sends. Useful for shutdown or deterministic tests.
   * Best-effort: failures are ignored.
   */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /** Number of in-flight sends (tests / observability). */
  get pending(): number {
    return this.inFlight.size;
  }

  private async send(ev: ControlPlaneIngestEvent): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ev),
        signal: controller.signal,
      });
      // Best-effort: read to completion so sockets are not left dangling, but
      // never propagate the response outcome to callers.
      await res.arrayBuffer();
    } finally {
      clearTimeout(timer);
    }
  }
}
