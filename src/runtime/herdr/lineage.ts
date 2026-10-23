/**
 * LineageEmitter — builds the typed lineage events of the herdr-federated
 * engineering program (contract: herdr `docs/contracts/lineage-events.md`,
 * carried in envelope v2) and hands them to an envelope sink.
 *
 * Rules:
 *  - OFF unless a sink is configured: callers hold `LineageEmitter | null` and
 *    do nothing when it is absent; Pi never needs Herdr.
 *  - FIRE-AND-FORGET: no method throws, returns a promise the worker path must
 *    await, or blocks. Sink errors (sync throw or rejection) are counted and
 *    swallowed.
 *  - LINEAGE IS EXPLICIT: an edge is only built from ids the caller read from
 *    real durable data. A missing or malformed id means NOTHING is emitted
 *    (counted in `dropped`), never a guessed edge.
 *  - STABLE IDS: `agent:<logical>` survives session rollover and host
 *    migration, `attempt:<id>` is one worker run, `session:<id>` one model
 *    session. Node ids carry no host and no emitter source.
 *  - DETERMINISTIC EVENT IDS: event_id = hash(source, event type, subject ids,
 *    transition discriminator). A retry of the same transition re-derives the
 *    same id (the outbox dedupes it); a legitimately repeated transition passes
 *    a different discriminator (execution status, handoff state, checkpoint
 *    sequence) and so gets a distinct id. The source is part of the hash because
 *    the server answers 409 when one event_id arrives under a different
 *    (source, source_sequence).
 */

import { createHash } from "node:crypto";

import type { ControlPlaneIngest } from "./ControlPlaneIngest.ts";
import type { EnvelopeDraft, VisibilityScope } from "./envelope.ts";
import type { EnvelopeStore } from "./envelopeStore.ts";

export const LINEAGE_ENTITY_TYPE = "lineage";

export const LINEAGE_NODE_KINDS = [
  "room",
  "workspace",
  "mission",
  "plan",
  "task",
  "agent",
  "attempt",
  "session",
  "tab",
  "pane",
  "handoff",
  "thread",
  "message",
  "decision",
  "approach",
  "worktree",
  "commit",
  "pr",
  "ci",
  "review",
  "finding",
  "artifact",
  "gate",
  "issue",
] as const;
export type LineageNodeKind = (typeof LINEAGE_NODE_KINDS)[number];

export const LINEAGE_EDGE_TYPES = [
  "spawn",
  "handoff",
  "delegation",
  "consultation",
  "dependency",
  "issue_link",
  "fork",
  "supersession",
  "reviewed",
  "produced",
  "validated",
] as const;
export type LineageEdgeType = (typeof LINEAGE_EDGE_TYPES)[number];

/** node.state vocabulary used by Pi (the contract's examples plus the rollover marker). */
export type LineageState =
  | "pending"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled"
  | "superseded"
  | "selected"
  | "rolled_over"
  | "prepared"
  | "validated"
  | "acknowledged"
  | "committed"
  | "aborted";

/** The slice of EnvelopeStore / ControlPlaneIngest the emitter needs. */
export interface LineageSink {
  stage(draft: EnvelopeDraft): Promise<unknown>;
}

export interface LineageEmitterOptions {
  sink: LineageSink;
  /** The envelope `source` the sink stamps; hashed into event ids. */
  source: string;
  /** Host label recorded in attrs only (never in an id), so migration is visible but ids stay put. */
  host?: string;
  visibility?: VisibilityScope;
  /**
   * Scope ids stamped on every draft (e.g. the HCN room this Pi reports into, from the global YAML).
   * Per-call scope fields win; `mission_id` here is only a default for events that carry none.
   */
  defaultScope?: { room_id?: string; workspace_id?: string; mission_id?: string };
  /**
   * Names this Pi (`herdr.instance_id` in the global YAML). Stamped as `attrs.instance_id` on every node this
   * emitter upserts, which is what Herdr pins a steering request to: another instance sharing the same key is not
   * offered it. Absent = unpinned (any holder of the key may receive it).
   */
  instanceId?: string;
  /**
   * Keyed id derivation (EnvelopeStore.deriveEventId). Without it ids fall back to a bare
   * sha256 of public data, which is only acceptable for tests with a private sink.
   */
  deriveEventId?: (prefix: string, parts: readonly unknown[]) => string;
  now?: () => Date;
  /** Called (never throws into the caller) for each swallowed sink error. */
  onError?: (error: unknown) => void;
}

export interface LineageCounters {
  emitted: number;
  dropped: number;
  errors: number;
}

export interface LineageScope {
  mission_id?: string;
  task_id?: string;
  agent_id?: string;
  workspace_id?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

const KIND_SET: ReadonlySet<string> = new Set(LINEAGE_NODE_KINDS);
const EDGE_SET: ReadonlySet<string> = new Set(LINEAGE_EDGE_TYPES);

/** Longest id (after the `kind:` prefix) and label that are sent as-is. */
export const MAX_LINEAGE_ID_CHARS = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_RUNS = /[\u0000-\u001f\u007f]+/g;

/**
 * `kind:id`, or undefined when the id is empty or holds a control character (so
 * callers drop instead of guess). An id longer than 200 chars is truncated and
 * suffixed with a hash of the full id, so it stays bounded and distinct.
 */
export function lineageNodeId(kind: LineageNodeKind, id: string | null | undefined): string | undefined {
  if (!nonEmpty(id)) return undefined;
  const trimmed = id.trim();
  if (CONTROL_CHARS.test(trimmed)) return undefined;
  const bounded =
    trimmed.length > MAX_LINEAGE_ID_CHARS
      ? `${trimmed.slice(0, MAX_LINEAGE_ID_CHARS - 17)}~${createHash("sha256").update(trimmed).digest("hex").slice(0, 16)}`
      : trimmed;
  return `${kind}:${bounded}`;
}

/** A label with control characters removed and bounded length; undefined when nothing is left. */
function cleanLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const cleaned = label.replace(CONTROL_RUNS, " ").trim().slice(0, MAX_LINEAGE_ID_CHARS);
  return cleaned || undefined;
}

function kindOf(nodeId: string): string | undefined {
  const i = nodeId.indexOf(":");
  if (i <= 0 || i === nodeId.length - 1) return undefined;
  if (nodeId.length - i - 1 > MAX_LINEAGE_ID_CHARS || CONTROL_CHARS.test(nodeId)) return undefined;
  const kind = nodeId.slice(0, i);
  return KIND_SET.has(kind) ? kind : undefined;
}

export interface WorkerLineageInput {
  /** Logical agent id (stable across sessions and hosts). */
  agent: string;
  /** This worker run. */
  attempt: string;
  /** Current model session, if one exists yet. */
  session?: string | null;
  /** REAL parent data only: the parent's logical agent / attempt. */
  parentAgent?: string | null;
  parentAttempt?: string | null;
  missionId?: string | null;
  taskId?: string | null;
  role?: string | null;
  model?: string | null;
  /** False when the agent node already exists: skip its upsert (label/state are set once). Default true. */
  upsertAgent?: boolean;
  /** Discriminator of this transition (so a retry dedupes). */
  transition: string;
  at?: string | Date;
}

export interface HandoffLineageInput {
  /** Handoff record id. */
  id: string;
  kind: string;
  missionId?: string | null;
  fromSession: string;
  /** Only known once the successor acknowledged. */
  toSession?: string | null;
  state: LineageState;
  checkpointSha?: string | null;
  fromGeneration?: number;
  toGeneration?: number;
  at?: string | Date;
}

export interface CheckpointLineageInput {
  checkpointId: string;
  /** Producing attempt (the execution). */
  attempt: string;
  missionId?: string | null;
  taskId?: string | null;
  sequence: number;
  commit?: string | null;
  at?: string | Date;
}

/**
 * Decides whether an attempt's state change is a real transition and names it.
 * Unchanged state yields null (polling a blocked worker adds nothing), `done` and
 * `cancelled` are final (a later terminate cannot flip a completed run), and the
 * discriminator is a per-attempt change counter, not a timestamp, so two changes
 * in the same millisecond cannot collide and a replayed identical sequence derives
 * identical ids. `failed` may be left again (a resume).
 */
export class AttemptTransitions {
  private readonly seen = new Map<string, { state: LineageState; seq: number }>();

  private readonly maxTracked: number;

  constructor(maxTracked = 10_000) {
    this.maxTracked = maxTracked;
  }

  advance(key: string, state: LineageState, seedFrom?: LineageState): string | null {
    let cur = this.seen.get(key);
    if (!cur && seedFrom) cur = { state: seedFrom, seq: 0 };
    if (cur) {
      if (cur.state === state) return null;
      if (cur.state === "done" || cur.state === "cancelled") return null;
    }
    const seq = (cur?.seq ?? 0) + 1;
    this.seen.delete(key);
    this.seen.set(key, { state, seq });
    if (this.seen.size > this.maxTracked) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return `n${seq}`;
  }
}

export class LineageEmitter {
  readonly source: string;
  private readonly sink: LineageSink;
  private readonly host?: string;
  private readonly visibility?: VisibilityScope;
  private readonly defaultScope: { room_id?: string; workspace_id?: string; mission_id?: string };
  private readonly instanceId?: string;
  private readonly now: () => Date;
  private readonly onError?: (error: unknown) => void;
  private readonly deriveKeyed?: (prefix: string, parts: readonly unknown[]) => string;
  private readonly inflight = new Set<Promise<void>>();
  private readonly counters: LineageCounters = { emitted: 0, dropped: 0, errors: 0 };

  constructor(opts: LineageEmitterOptions) {
    this.sink = opts.sink;
    this.source = opts.source;
    this.host = opts.host;
    this.visibility = opts.visibility;
    this.defaultScope = opts.defaultScope ?? {};
    this.instanceId = opts.instanceId;
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError;
    this.deriveKeyed = opts.deriveEventId;
  }

  stats(): LineageCounters {
    return { ...this.counters };
  }

  /** Resolves once every event handed to the sink so far has settled. Test / shutdown aid. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // ── primitives ────────────────────────────────────────────────────────────

  nodeUpsert(
    nodeId: string | undefined,
    spec: { label?: string; state?: LineageState; attrs?: Record<string, unknown> },
    transition: string,
    scope: LineageScope = {},
    at?: string | Date,
  ): void {
    if (!nodeId || !kindOf(nodeId)) {
      this.drop();
      return;
    }
    const nodeType = kindOf(nodeId) as string;
    const payload: Record<string, unknown> = { node_type: nodeType, node_id: nodeId };
    const label = cleanLabel(spec.label);
    if (label) payload.label = label;
    if (spec.state) payload.state = spec.state;
    const attrs = this.withHost(this.instanceId ? { ...spec.attrs, instance_id: this.instanceId } : spec.attrs);
    if (attrs) payload.attrs = attrs;
    this.send("node.upsert", nodeId, payload, [nodeId, transition], scope, at);
  }

  nodeState(
    nodeId: string | undefined,
    state: LineageState,
    transition: string,
    opts: { reason?: string } = {},
    scope: LineageScope = {},
    at?: string | Date,
  ): void {
    if (!nodeId || !kindOf(nodeId)) {
      this.drop();
      return;
    }
    const payload: Record<string, unknown> = { node_id: nodeId, state };
    if (opts.reason) payload.reason = opts.reason;
    this.send("node.state", nodeId, payload, [nodeId, state, transition], scope, at);
  }

  edgeAdd(
    edgeType: LineageEdgeType,
    from: string | undefined,
    to: string | undefined,
    transition: string,
    attrs?: Record<string, unknown>,
    scope: LineageScope = {},
    at?: string | Date,
  ): void {
    if (!this.validEdge(edgeType, from, to, attrs)) {
      this.drop();
      return;
    }
    // Every edge endpoint exists as a node in the same emission batch: a minimal upsert
    // (same id as the caller's richer one, which therefore wins when staged first).
    this.ensureNode(from, transition, scope, at);
    this.ensureNode(to, transition, scope, at);
    const payload: Record<string, unknown> = { edge_type: edgeType, from_id: from, to_id: to };
    const a = this.withHost(attrs);
    if (a) payload.attrs = a;
    this.send("edge.add", from as string, payload, [edgeType, from, to, transition], scope, at);
  }

  private ensureNode(nodeId: string | undefined, transition: string, scope: LineageScope, at?: string | Date): void {
    if (!nodeId || !kindOf(nodeId)) return;
    this.send(
      "node.upsert",
      nodeId,
      { node_type: kindOf(nodeId) as string, node_id: nodeId },
      [nodeId, transition],
      scope,
      at,
    );
  }

  /** State of the LOGICAL agent (e.g. aggregated from its attempts). Never from a pane/tab closing. */
  agentState(
    input: { agent: string; missionId?: string | null; taskId?: string | null },
    state: LineageState,
    transition: string,
    reason?: string,
    at?: string | Date,
  ): void {
    try {
      this.nodeState(
        lineageNodeId("agent", input.agent),
        state,
        transition,
        { reason },
        scopeOf(input, input.agent),
        at,
      );
    } catch (error) {
      this.fail(error);
    }
  }

  edgeRemove(
    edgeType: LineageEdgeType,
    from: string | undefined,
    to: string | undefined,
    reason: string,
    transition: string,
    scope: LineageScope = {},
    at?: string | Date,
  ): void {
    if (!this.validEdge(edgeType, from, to) || !nonEmpty(reason)) {
      this.drop();
      return;
    }
    this.send(
      "edge.remove",
      from as string,
      { edge_type: edgeType, from_id: from, to_id: to, reason },
      [edgeType, from, to, transition],
      scope,
      at,
    );
  }

  // ── transitions ───────────────────────────────────────────────────────────

  /** Worker spawn: agent + attempt (+ session) nodes; spawn edges only from real parent data. */
  workerSpawned(input: WorkerLineageInput): void {
    try {
      const agent = lineageNodeId("agent", input.agent);
      const attempt = lineageNodeId("attempt", input.attempt);
      if (!agent || !attempt) {
        this.drop();
        return;
      }
      const scope = scopeOf(input, input.agent);
      const t = input.transition;
      const attrs = { agent_id: agent, ...(input.taskId ? { task_id: input.taskId } : {}) };
      if (input.upsertAgent !== false) {
        this.nodeUpsert(
          agent,
          { label: input.role ?? undefined, state: "running", attrs: { ...(input.role ? { role: input.role } : {}) } },
          t,
          scope,
          input.at,
        );
      }
      this.nodeUpsert(
        attempt,
        { state: "pending", attrs: { ...attrs, ...(input.model ? { model: input.model } : {}) } },
        t,
        scope,
        input.at,
      );
      const session = lineageNodeId("session", input.session);
      if (session) {
        this.nodeUpsert(session, { state: "running", attrs: { ...attrs, attempt_id: attempt } }, t, scope, input.at);
      }
      const parentAgent = lineageNodeId("agent", input.parentAgent);
      if (parentAgent && parentAgent !== agent)
        this.edgeAdd("spawn", parentAgent, agent, t, undefined, scope, input.at);
      const parentAttempt = lineageNodeId("attempt", input.parentAttempt);
      if (parentAttempt && parentAttempt !== attempt) {
        this.edgeAdd("spawn", parentAttempt, attempt, t, undefined, scope, input.at);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** Worker end / state change. Never touches the agent node: only the run ended. */
  attemptState(
    input: { attempt: string; agent?: string | null; missionId?: string | null; taskId?: string | null },
    state: LineageState,
    transition: string,
    reason?: string,
    at?: string | Date,
  ): void {
    try {
      this.nodeState(
        lineageNodeId("attempt", input.attempt),
        state,
        transition,
        { reason },
        scopeOf(input, input.agent ?? undefined),
        at,
      );
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Session rollover: a NEW session node under the same attempt and agent; the old
   * session becomes `rolled_over`. Agent and attempt ids never change.
   */
  sessionRolledOver(input: {
    agent: string;
    attempt: string;
    fromSession: string;
    toSession: string;
    missionId?: string | null;
    taskId?: string | null;
    transition: string;
    at?: string | Date;
  }): void {
    try {
      const agent = lineageNodeId("agent", input.agent);
      const attempt = lineageNodeId("attempt", input.attempt);
      const from = lineageNodeId("session", input.fromSession);
      const to = lineageNodeId("session", input.toSession);
      if (!agent || !attempt || !from || !to || from === to) {
        this.drop();
        return;
      }
      const scope = scopeOf(input, input.agent);
      this.nodeUpsert(
        to,
        {
          state: "running",
          attrs: { agent_id: agent, attempt_id: attempt, previous_session_id: from },
        },
        input.transition,
        scope,
        input.at,
      );
      this.nodeState(from, "rolled_over", input.transition, { reason: "session rollover" }, scope, input.at);
    } catch (error) {
      this.fail(error);
    }
  }

  /** First model session observed for an attempt (no predecessor, so nothing rolls over). */
  sessionAttached(input: {
    agent: string;
    attempt: string;
    session: string;
    missionId?: string | null;
    taskId?: string | null;
    transition: string;
    at?: string | Date;
  }): void {
    try {
      const agent = lineageNodeId("agent", input.agent);
      const attempt = lineageNodeId("attempt", input.attempt);
      const session = lineageNodeId("session", input.session);
      if (!agent || !attempt || !session) {
        this.drop();
        return;
      }
      this.nodeUpsert(
        session,
        { state: "running", attrs: { agent_id: agent, attempt_id: attempt } },
        input.transition,
        scopeOf(input, input.agent),
        input.at,
      );
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Handoff node (every state) and, once a distinct successor session is known,
   * the `handoff` edge from -> to. A successor with the SAME session id (a
   * generation bump) is the same model session, so no edge and no new session.
   */
  handoff(input: HandoffLineageInput): void {
    try {
      const node = lineageNodeId("handoff", input.id);
      const from = lineageNodeId("session", input.fromSession);
      if (!node || !from) {
        this.drop();
        return;
      }
      const scope: LineageScope = input.missionId ? { mission_id: input.missionId } : {};
      const attrs: Record<string, unknown> = {
        handoff_kind: input.kind,
        from_session_id: from,
        ...(input.checkpointSha ? { checkpoint_sha: input.checkpointSha } : {}),
        ...(input.fromGeneration !== undefined ? { from_generation: input.fromGeneration } : {}),
        ...(input.toGeneration !== undefined ? { to_generation: input.toGeneration } : {}),
      };
      const to = lineageNodeId("session", input.toSession);
      if (to) attrs.to_session_id = to;
      this.nodeUpsert(node, { state: input.state, attrs }, input.state, scope, input.at);
      if (to && to !== from && (input.state === "acknowledged" || input.state === "committed")) {
        // Both endpoint sessions are upserted (with the handoff they belong to) before the edge.
        const endpointAttrs = { handoff_id: node, ...(input.missionId ? { mission_id: input.missionId } : {}) };
        this.nodeUpsert(from, { attrs: endpointAttrs }, input.id, scope, input.at);
        this.nodeUpsert(to, { attrs: endpointAttrs }, input.id, scope, input.at);
        this.edgeAdd("handoff", from, to, input.id, { handoff_id: node, handoff_kind: input.kind }, scope, input.at);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** A verified checkpoint: an artifact node (kind=checkpoint) produced by the attempt. */
  checkpointVerified(input: CheckpointLineageInput): void {
    try {
      const artifact = lineageNodeId("artifact", input.checkpointId);
      const attempt = lineageNodeId("attempt", input.attempt);
      if (!artifact || !attempt) {
        this.drop();
        return;
      }
      const scope: LineageScope = {
        ...(input.missionId ? { mission_id: input.missionId } : {}),
        ...(input.taskId ? { task_id: input.taskId } : {}),
      };
      const t = `seq${input.sequence}`;
      const attrs = {
        kind: "checkpoint",
        sequence: input.sequence,
        ...(input.commit ? { commit: input.commit } : {}),
      };
      this.nodeUpsert(artifact, { state: "done", attrs }, t, scope, input.at);
      this.edgeAdd(
        "produced",
        attempt,
        artifact,
        t,
        input.commit ? { commit: input.commit } : undefined,
        scope,
        input.at,
      );
    } catch (error) {
      this.fail(error);
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private validEdge(
    edgeType: string,
    from: string | undefined,
    to: string | undefined,
    attrs?: Record<string, unknown>,
  ): boolean {
    if (!EDGE_SET.has(edgeType) || !from || !to || from === to) return false;
    if (!kindOf(from) || !kindOf(to)) return false;
    // reviewed / validated are bound to an exact revision; without one they are not edges.
    if (edgeType === "validated" && !nonEmpty(attrs?.commit)) return false;
    if (edgeType === "reviewed" && !nonEmpty(attrs?.commit) && !nonEmpty(attrs?.plan_digest)) return false;
    return true;
  }

  private withHost(attrs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const merged = { ...(attrs ?? {}), ...(this.host ? { host: this.host } : {}) };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private drop(): void {
    this.counters.dropped++;
  }

  private fail(error: unknown): void {
    this.counters.errors++;
    try {
      this.onError?.(error);
    } catch {
      // the error hook must not throw into the worker path either
    }
  }

  private eventId(eventType: string, parts: readonly unknown[]): string {
    if (this.deriveKeyed) return this.deriveKeyed("lin", [this.source, eventType, ...parts]);
    const digest = createHash("sha256")
      .update(JSON.stringify([this.source, eventType, ...parts]))
      .digest("hex")
      .slice(0, 32);
    return `lin_${digest}`;
  }

  /** Build the draft and hand it to the sink without ever throwing or blocking. */
  private send(
    eventType: string,
    subject: string,
    payload: Record<string, unknown>,
    idParts: readonly unknown[],
    scope: LineageScope,
    at?: string | Date,
  ): void {
    try {
      const draft: EnvelopeDraft = {
        // Deliberately NOT event_id_derived: the store must keep this id so a retry dedupes.
        event_id: this.eventId(eventType, idParts),
        occurred_at: at ?? this.now(),
        entity_type: LINEAGE_ENTITY_TYPE,
        entity_id: subject,
        event_type: eventType,
        payload,
        ...this.defaultScope,
        ...scope,
        ...(this.visibility ? { visibility_scope: this.visibility } : {}),
      };
      this.counters.emitted++;
      const pending = Promise.resolve(this.sink.stage(draft)).then(
        () => undefined,
        (error) => this.fail(error),
      );
      this.inflight.add(pending);
      void pending.then(() => this.inflight.delete(pending));
    } catch (error) {
      this.fail(error);
    }
  }
}

function scopeOf(input: { missionId?: string | null; taskId?: string | null }, agent?: string | null): LineageScope {
  return {
    ...(input.missionId ? { mission_id: input.missionId } : {}),
    ...(input.taskId ? { task_id: input.taskId } : {}),
    ...(agent ? { agent_id: agent } : {}),
  };
}

export type LineageSinkSource = { store: EnvelopeStore } | { ingest: ControlPlaneIngest };

/**
 * Build an emitter over an envelope store (stage only; delivery is whoever
 * flushes that store) or over a ControlPlaneIngest (stage + deliver). Returns
 * null when there is nothing durable to stage into, so a v1-only ingest or an
 * absent configuration yields no emitter and therefore no behaviour change.
 */
export function createLineageEmitter(
  from: LineageSinkSource,
  opts: Omit<LineageEmitterOptions, "sink" | "source"> = {},
): LineageEmitter | null {
  if ("store" in from) {
    const store = from.store;
    return new LineageEmitter({
      ...opts,
      sink: store,
      source: store.source,
      deriveEventId: (prefix, parts) => store.deriveEventId(prefix, parts),
    });
  }
  const diag = from.ingest.diagnostics();
  if (!diag) return null;
  const ingest = from.ingest;
  return new LineageEmitter({
    host: ingest.host.hostId,
    ...opts,
    source: diag.source,
    deriveEventId: (prefix, parts) => ingest.deriveEventId(prefix, parts) as string,
    sink: { stage: (draft) => ingest.emitDraft(draft) },
  });
}
