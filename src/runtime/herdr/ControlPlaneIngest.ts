/**
 * ControlPlaneIngest — non-blocking lifecycle reporter to the HerdR Dev Fabric
 * control plane (the Python control-plane stack served on `dev.lan`).
 *
 * This is the Phase 2 emitter. It POSTs host / mission / session lifecycle
 * events to the control plane's `POST /api/v1/ingest` endpoint so the operator
 * dashboard tracks ~30 agents across hosts without custom per-host reporters.
 *
 * Hard invariants:
 *  - BEST-EFFORT and NON-BLOCKING: a failure to reach the control plane must
 *    never break or slow down agent lifecycle. Every emit is fire-and-forget
 *    with a short timeout and all errors swallowed.
 *  - OFF BY DEFAULT: the runtime emits nothing unless an ingest client is
 *    constructed and wired in.
 *  - IDEMPOTENT entity ids: the control plane upserts on `(entity_type,
 *    entity_id)`, so repeated heartbeats never duplicate a host/session.
 *
 * Entity mapping (agreed with the operator):
 *  - host    = the machine running agents  (host.registered / host.heartbeat)
 *  - mission = a pi-engineering mission    (mission.started, once per id)
 *  - session = an individual agent worker  (session.started / updated / terminated)
 */

import os from "node:os";

export interface ControlPlaneIngestOptions {
  /** Control-plane base URL, e.g. "http://dev.lan" (no trailing slash). */
  url: string;
  /** Host identity. Defaults to `os.hostname()` for hostId/hostName. */
  host?: { hostId?: string; hostName?: string; tailnetIp?: string };
  /** Default mission for sessions that don't carry an explicit missionId. */
  defaultMissionId?: string;
  /** Injectable fetch for tests (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in ms (default 1500). */
  timeoutMs?: number;
}

export class ControlPlaneIngest {
  readonly url: string;
  readonly host: { hostId: string; hostName: string; tailnetIp?: string };
  readonly defaultMissionId?: string;
  enabled = true;

  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly seenMissions = new Set<string>();

  constructor(opts: ControlPlaneIngestOptions) {
    const hostId = opts.host?.hostId ?? os.hostname();
    this.url = opts.url.replace(/\/+$/, "");
    this.host = {
      hostId,
      hostName: opts.host?.hostName ?? hostId,
      tailnetIp: opts.host?.tailnetIp,
    };
    this.defaultMissionId = opts.defaultMissionId;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 1500;
  }

  /**
   * Best-effort emit to `POST {url}/api/v1/ingest`. Never throws and never
   * rejects the returned promise; callers may `void` it for fire-and-forget.
   * Returns false when disabled or on any failure.
   */
  async emit(
    entityType: string,
    entityId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!this.enabled) return false;
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        res = await this.fetchImpl(`${this.url}/api/v1/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entity_type: entityType, entity_id: entityId, event_type: eventType, payload }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Report the host once (host.registered). Idempotent on the control plane. */
  hostRegistered(): Promise<boolean> {
    return this.emit("host", this.host.hostId, "host.registered", {
      host_name: this.host.hostName,
      tailnet_ip: this.host.tailnetIp,
    });
  }

  /** Report host liveness (host.heartbeat). */
  hostHeartbeat(): Promise<boolean> {
    return this.emit("host", this.host.hostId, "host.heartbeat", {
      host_name: this.host.hostName,
      tailnet_ip: this.host.tailnetIp,
    });
  }

  /**
   * Report a mission once (deduped by missionId). title defaults to the id
   * until pi-engineering provides richer mission metadata.
   */
  missionStarted(missionId: string, title?: string): Promise<boolean> {
    if (this.seenMissions.has(missionId)) return Promise.resolve(true);
    this.seenMissions.add(missionId);
    return this.emit("mission", missionId, "mission.started", {
      title: title ?? missionId,
      stage: "active",
    });
  }

  /** Report an agent/session lifecycle event, resolving its mission. */
  session(
    sessionId: string,
    eventType: "session.started" | "session.updated" | "session.terminated",
    payload: { missionId?: string; hostId?: string; agentRole?: string; model?: string; status?: string } = {},
  ): Promise<boolean> {
    const missionId = payload.missionId ?? this.defaultMissionId;
    if (missionId) void this.missionStarted(missionId);
    return this.emit("session", sessionId, eventType, {
      host_id: payload.hostId ?? this.host.hostId,
      mission_id: missionId ?? null,
      agent_role: payload.agentRole ?? "",
      model: payload.model ?? null,
      status: payload.status ?? null,
    });
  }
}
