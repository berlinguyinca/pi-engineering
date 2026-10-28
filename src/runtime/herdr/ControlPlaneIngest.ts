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

import { emitTelemetry } from "../../telemetry/sink.ts";

import type { EnvelopeDraft, EnvelopeV2 } from "./envelope.ts";
import { scopeIdsFromPayload } from "./envelopeAdapters.ts";
import type { EnvelopeStore } from "./envelopeStore.ts";
import type { OutboxStats } from "./outbox.ts";

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
  /** Optional control-plane API key (sent as X-API-Key; use an `ingest`-role key). */
  apiKey?: string;
  /**
   * Opt-in envelope v2 + durable outbox. When set, every emit is stamped with a
   * persisted source_sequence, appended to the local outbox and then delivered
   * in order; undelivered events replay on the next emit / {@link flushOutbox}.
   * Absent (the default) the client behaves exactly as before: v1 body, no disk.
   */
  envelopeStore?: EnvelopeStore;
  /** Delivery back-off / dead-letter tuning (outbox mode only). */
  backoff?: BackoffOptions;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

export interface BackoffOptions {
  /** First retry delay (default 1000); doubles per consecutive failure. */
  baseMs?: number;
  /** Cap on any delay (default 60000). */
  maxMs?: number;
  /** Consecutive 5xx on the same head event before it is dead-lettered (default 5). */
  deadLetterAfter?: number;
}

export interface ControlPlaneDiagnostics extends OutboxStats {
  source: string;
  sequenceFailures: number;
  consecutiveFailures: number;
  backoffUntil: string | null;
  lastStatus: number | null;
  credentialProblem: boolean;
  /** Events dead-lettered by a 409 that a sequence resync could not repair. */
  conflictDeadLettered: number;
  sequenceRegressions: number;
  sequenceResyncs: number;
  resequenced: number;
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers?.get("retry-after");
  const secs = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

/** Longest response body read to classify a refusal. */
const MAX_REFUSAL_BODY_BYTES = 4096;

interface RefusalBody {
  reason?: string;
  error?: string;
  /** The server's high-water mark for this source, when the refusal carries one (`last_sequence`). */
  lastSequence?: number;
}

/**
 * The classification fields of a JSON refusal body, or {} for anything else (non-JSON, oversized, unreadable,
 * slow). Defensive: an unreadable body never changes how a plain 401/403 is treated.
 */
async function refusalBody(res: Response): Promise<RefusalBody> {
  try {
    const read = async (): Promise<string> => {
      const reader = res.body?.getReader();
      if (!reader) return (await res.text()).slice(0, MAX_REFUSAL_BODY_BYTES + 1);
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total <= MAX_REFUSAL_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        total += value.byteLength;
      }
      void reader.cancel().catch(() => {});
      return Buffer.concat(chunks).toString("utf8");
    };
    const text = await Promise.race([
      read(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 1000).unref()),
    ]);
    if (Buffer.byteLength(text) > MAX_REFUSAL_BODY_BYTES) return {};
    const parsed = JSON.parse(text) as { reason?: unknown; error?: unknown; last_sequence?: unknown } | null;
    const hint = parsed?.last_sequence;
    return {
      ...(typeof parsed?.reason === "string" ? { reason: parsed.reason } : {}),
      ...(typeof parsed?.error === "string" ? { error: parsed.error.slice(0, 300) } : {}),
      ...(typeof hint === "number" && Number.isSafeInteger(hint) && hint >= 0 ? { lastSequence: hint } : {}),
    };
  } catch {
    return {};
  }
}

const refusalReason = async (res: Response): Promise<string | undefined> => (await refusalBody(res)).reason;

/** A 409 that says a (source, source_sequence) pair belongs to another event, as opposed to a content contradiction. */
function isSequenceCollision(body: RefusalBody): boolean {
  // The explicit classification Herdr is asked to send wins; the message text is the fallback for servers that only
  // send `reason: "conflict"` with a human sentence.
  if (body.reason === "sequence_conflict") return true;
  const text = body.error ?? "";
  return /sequence/i.test(text) && !/different content/i.test(text);
}

/** Largest body accepted from the ingest sources listing. */
const MAX_SOURCES_BYTES = 2 * 1024 * 1024;

/** Hard cap on events replayed by one flush pass. */
const MAX_FLUSH = 500;

export class ControlPlaneIngest {
  readonly url: string;
  readonly host: { hostId: string; hostName: string; tailnetIp?: string };
  readonly defaultMissionId?: string;
  enabled = true;

  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;
  private readonly seenMissions = new Set<string>();
  private readonly envelopeStore?: EnvelopeStore;
  private flushChain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly backoff: Required<BackoffOptions>;
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;
  private lastStatus: number | undefined;
  private credentialProblem = false;
  private headId: string | undefined;
  private headFailures = 0;

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
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.envelopeStore = opts.envelopeStore;
    this.now = opts.now ?? Date.now;
    this.backoff = { baseMs: 1000, maxMs: 60_000, deadLetterAfter: 5, ...opts.backoff };
  }

  private async post(body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.url}/api/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Deliver pending outbox events in order. Per response:
   *  - 2xx: delivered (an acknowledged duplicate is also 2xx).
   *  - 400 / 409 / 422: terminal server rejection -> dead-letter, continue.
   *  - 401 / 403: credentials problem -> keep everything queued, back off, never drop.
   *  - 408 / 425 / 429: transient -> back off (honouring Retry-After), never dead-letter.
   *  - 5xx: transient with back-off; after `deadLetterAfter` consecutive 5xx on the
   *    SAME head event it is dead-lettered so one poison event cannot block the queue.
   *  - network error / timeout: transient, never counts toward dead-lettering.
   *  - any other 4xx (404, 413, ...): terminal -> dead-letter, continue.
   * Back-off is time-based (no timers): a pass during back-off does nothing.
   * Never throws. Returns the ids delivered by this pass.
   */
  flushOutbox(): Promise<Set<string>> {
    const store = this.envelopeStore;
    if (!store || !this.enabled) return Promise.resolve(new Set());
    const run = this.flushChain.then(async () => {
      const acked = new Set<string>();
      const toAck: string[] = [];
      try {
        if (this.now() < this.nextAttemptAt) return acked;
        let restart = true;
        for (let round = 0; restart && round < 3; round++) {
          restart = false;
          const pending = await store.outbox.peek(MAX_FLUSH);
          for (const envelope of pending) {
            let res: Response;
            try {
              res = await this.post(envelope);
            } catch {
              this.failed(); // network / timeout: transient
              break;
            }
            const status = res.status;
            if (res.ok) {
              acked.add(envelope.event_id);
              toAck.push(envelope.event_id);
              this.succeeded();
              store.outbox.markHealthy();
            } else if (status === 409 && (await this.resyncAfterCollision(res, envelope, store))) {
              // The pending queue was re-numbered; start over from the head with the new numbers.
              restart = true;
              break;
            } else if (status === 400 || status === 409 || status === 422) {
              await store.outbox.deadLetter(envelope, "server_rejected", status);
              if (status === 409) this.conflictDeadLettered++;
              this.headId = undefined;
            } else if (status === 403 && (await refusalReason(res)) === "lineage_forbidden") {
              // A graph-ownership refusal of THIS event (not a credentials problem): terminal,
              // never delivered, the queue continues.
              await store.outbox.deadLetter(envelope, "lineage_forbidden", status);
              this.headId = undefined;
            } else if (status === 401 || status === 403) {
              this.credentialProblem = true;
              this.failed(status);
              break;
            } else if (status === 408 || status === 425 || status === 429) {
              this.failed(status, retryAfterMs(res));
              break;
            } else if (status >= 500) {
              if (this.headId !== envelope.event_id) {
                this.headId = envelope.event_id;
                this.headFailures = 0;
              }
              if (++this.headFailures >= this.backoff.deadLetterAfter) {
                await store.outbox.deadLetter(envelope, "repeated_5xx", status);
                this.headId = undefined;
                continue;
              }
              this.failed(status);
              break;
            } else if (status >= 400) {
              await store.outbox.deadLetter(envelope, "client_error", status);
              this.headId = undefined;
            } else {
              this.failed(status); // unexpected non-2xx below 400
              break;
            }
          }
        }
      } catch {
        // best-effort: leave the rest pending for the next pass
      }
      try {
        await store.outbox.ackMany(toAck); // one lock + one write for the whole pass
      } catch {
        acked.clear(); // not durably acked: will be re-sent and deduped by the server
      }
      return acked;
    });
    this.flushChain = run.catch(() => {});
    return run;
  }

  /** Events dead-lettered by a 409 the sequence resync could not repair. */
  conflictDeadLettered = 0;
  private readonly resequencedIds = new Set<string>();

  /** Ask the server for its high-water mark of `source` (best effort; undefined when it cannot be learned). */
  private async serverHighWater(source: string): Promise<number | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}/api/v1/ingest/sources`, {
        method: "GET",
        headers: this.apiKey ? { "x-api-key": this.apiKey } : {},
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const text = await res.text();
      if (text.length > MAX_SOURCES_BYTES) return undefined;
      const rows = (JSON.parse(text) as { sources?: unknown }).sources;
      if (!Array.isArray(rows)) return undefined;
      let high: number | undefined;
      for (const row of rows as Array<{ source?: unknown; last_sequence?: unknown }>) {
        const seq = row.last_sequence;
        if (row.source === source && typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
          high = Math.max(high ?? 0, seq);
        }
      }
      return high;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A 409 whose text says the sequence number is taken by another event means OUR counter is behind the server's
   * (state restored from an older copy, sequence file lost, cloned install). Dead-lettering would lose this event and
   * every later one, silently, forever. Instead: learn the server's high-water mark (the 409 body's `last_sequence`
   * when the server sends one, else the ingest sources listing), move the allocator above it and re-number every
   * pending envelope. Returns true when the queue was re-numbered; false means "treat as a plain rejection"
   * (not a sequence collision, already re-numbered once, or the high-water mark cannot be learned) and the failure is
   * reported through telemetry at error level.
   */
  private async resyncAfterCollision(res: Response, envelope: EnvelopeV2, store: EnvelopeStore): Promise<boolean> {
    const body = await refusalBody(res);
    if (!isSequenceCollision(body)) return false;
    if (this.resequencedIds.has(envelope.event_id)) {
      this.reportConflict(envelope, "still collides after a resync");
      return false;
    }
    const high = body.lastSequence ?? (await this.serverHighWater(store.source));
    if (high === undefined) {
      this.reportConflict(envelope, "the server's high-water mark for this source could not be learned");
      return false;
    }
    try {
      for (const e of await store.outbox.peek()) this.resequencedIds.add(e.event_id);
      await store.resync(high);
      return true;
    } catch {
      this.reportConflict(envelope, "re-numbering the pending queue failed");
      return false;
    }
  }

  private reportConflict(envelope: EnvelopeV2, why: string): void {
    emitTelemetry({
      level: "error",
      key: `herdr-sequence-conflict:${envelope.event_id}`,
      text: `control-plane rejected event ${envelope.event_id} (source_sequence ${envelope.source_sequence}) and it is being dead-lettered: ${why}. See the dead-letter file next to the outbox.`,
    });
  }

  private failed(status?: number, retryAfter?: number): void {
    this.consecutiveFailures++;
    this.lastStatus = status;
    const exp = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** (this.consecutiveFailures - 1));
    this.nextAttemptAt = this.now() + Math.max(exp, Math.min(retryAfter ?? 0, this.backoff.maxMs));
  }

  private succeeded(): void {
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
    this.credentialProblem = false;
    this.headId = undefined;
    this.lastStatus = undefined;
  }

  /** Keyed event-id derivation of the underlying envelope store (see EnvelopeStore.deriveEventId). */
  deriveEventId(prefix: string, parts: readonly unknown[]): string | undefined {
    return this.envelopeStore?.deriveEventId(prefix, parts);
  }

  /** Health / diagnostic snapshot: queue depth, loss counters and back-off state. */
  diagnostics(): ControlPlaneDiagnostics | undefined {
    const store = this.envelopeStore;
    if (!store) return undefined;
    return {
      ...store.stats(),
      consecutiveFailures: this.consecutiveFailures,
      backoffUntil: this.nextAttemptAt > this.now() ? new Date(this.nextAttemptAt).toISOString() : null,
      lastStatus: this.lastStatus ?? null,
      credentialProblem: this.credentialProblem,
      conflictDeadLettered: this.conflictDeadLettered,
    };
  }

  /** Terminal server rejections (kept for compatibility with the counter's earlier home). */
  get rejected(): number {
    return this.envelopeStore?.outbox.rejected ?? 0;
  }

  /** Stage a draft in the outbox and try to deliver. False when disabled/failed/not (yet) delivered. */
  async emitDraft(draft: EnvelopeDraft): Promise<boolean> {
    const store = this.envelopeStore;
    if (!this.enabled || !store) return false;
    let staged: Awaited<ReturnType<EnvelopeStore["stage"]>>;
    try {
      staged = await store.stage(draft);
    } catch {
      return false;
    }
    if (!("envelope" in staged)) return staged.status === "delivered";
    const acked = await this.flushOutbox();
    return acked.has(staged.envelope.event_id);
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
    if (this.envelopeStore) {
      return this.emitDraft({
        occurred_at: new Date(),
        entity_type: entityType,
        entity_id: entityId,
        event_type: eventType,
        payload,
        ...scopeIdsFromPayload(payload),
      });
    }
    try {
      const res = await this.post({ entity_type: entityType, entity_id: entityId, event_type: eventType, payload });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Agent-inspector telemetry (docs/contracts/agent-inspector-event.md in herdr-engineering):
   * one `inspector.batch` ingest for entity `inspector` keyed by the session id. Same
   * best-effort / non-blocking / timeout behaviour as {@link emit}. The caller bounds the
   * batch (<= 100 events); see InspectorFeed.
   */
  emitBatch(sessionId: string, events: ReadonlyArray<Record<string, unknown>>): Promise<boolean> {
    return this.emit("inspector", sessionId, "inspector.batch", { events });
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
    payload: {
      missionId?: string;
      hostId?: string;
      agentRole?: string;
      model?: string;
      status?: string;
      /** `pane:<host>:<pane>` link to the herdr pane (see CollabLayout). */
      instanceId?: string;
      /** Session that started this one, so the fabric view can draw the parent link. */
      parentSessionId?: string;
      name?: string;
      /** Bare herdr pane id; the control plane stores this one today. */
      paneId?: string;
      /** Which Pi binary this agent runs on, plus engine/CPU/RSS (see `runtimeFacts`). Runtime metrics only. */
      runtime?: Record<string, unknown>;
    } = {},
  ): Promise<boolean> {
    const missionId = payload.missionId ?? this.defaultMissionId;
    if (missionId) void this.missionStarted(missionId);
    return this.emit("session", sessionId, eventType, {
      host_id: payload.hostId ?? this.host.hostId,
      mission_id: missionId ?? null,
      agent_role: payload.agentRole ?? "",
      model: payload.model ?? null,
      status: payload.status ?? null,
      ...(payload.instanceId ? { instance_id: payload.instanceId } : {}),
      ...(payload.parentSessionId ? { parent_session_id: payload.parentSessionId } : {}),
      ...(payload.name ? { name: payload.name } : {}),
      ...(payload.paneId ? { pane_id: payload.paneId } : {}),
      ...(payload.runtime ? { runtime: payload.runtime } : {}),
    });
  }
}
