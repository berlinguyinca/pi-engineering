/**
 * Remote worker contract (spec 12).
 *
 * Local and remote workers share ONE Worker contract (the WorkGraph Worker).
 * Remote hosts connect OUTBOUND over an authenticated channel; no public
 * inbound port is required. Commands are idempotent (keyed on worker id +
 * generation), so a retried or replayed command after a disconnect is a no-op.
 * Disconnects recover by reconnecting the same worker (generation preserved);
 * location/latency are placement attributes, not a second orchestration API.
 */

import { id } from "../core/ids.ts";
import type { WorkGraph } from "./WorkGraph.ts";

export type WorkerCommand =
  | { kind: "run_task"; taskRef: string }
  | { kind: "cancel" }
  | { kind: "restart" }
  | { kind: "heartbeat" };

export interface WorkerCommandEnvelope {
  workerId: string;
  /** Idempotency key: a command from a stale generation is ignored. */
  generation: number;
  command: WorkerCommand;
  issuedAt: string;
  /** Transport-level correlation id so a reply is matched to its command. */
  correlationId?: string;
}

export interface CommandResult {
  workerId: string;
  generation: number;
  ok: boolean;
  ack: string;
}

/**
 * An authenticated outbound channel to a remote worker host. The remote host
 * dials in (outbound connection) and the control plane dispatches commands over
 * it. `onDisconnect` is called by the transport when the channel drops.
 */
export interface WorkerChannel {
  readonly host: string;
  send(envelope: WorkerCommandEnvelope): Promise<CommandResult>;
  /** Transport must call this when the connection drops so recovery runs. */
  onDisconnect?: (reason: string) => void;
  close(): void;
}

export interface RemoteWorkerClientOptions {
  graph: WorkGraph;
  /** Heartbeat interval when attached. */
  heartbeatMs?: number;
  /** How long a single remote command may take before it is treated as failed. */
  commandTimeoutMs?: number;
  now?: () => number;
}

/** Longest a remote may hold a command. A remote is never trusted to answer. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** Longest acknowledgement a remote may return; anything more is truncated. */
export const MAX_ACK_LENGTH = 4_096;

/** Reject if `promise` has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, workerId: string, kind: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // NOT unref'd, unlike the heartbeat interval. This timer is the only thing
    // that will ever settle the promise, so letting the loop exit without it
    // firing reinstates the eternal wait it exists to end.
    const timer = setTimeout(() => {
      reject(new Error(`remote worker ${workerId} did not answer ${kind} within ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Check what a remote sent back before anyone acts on it.
 *
 * The raw object used to be returned to the caller typed as a `CommandResult`
 * by assertion alone, so a hostile or buggy host could report success for a
 * command it never ran, attribute the result to a DIFFERENT worker, claim an
 * arbitrary generation, and return an unbounded `ack` that every caller then
 * held and might log.
 */
function validateResult(raw: unknown, workerId: string, generation: number): CommandResult {
  const reject = (why: string): CommandResult => ({ workerId, generation, ok: false, ack: `invalid response: ${why}` });
  if (!raw || typeof raw !== "object") return reject("not an object");
  const r = raw as Partial<CommandResult>;
  if (r.workerId !== workerId) return reject("workerId mismatch");
  if (r.generation !== generation) return reject("generation mismatch");
  if (typeof r.ok !== "boolean") return reject("ok is not a boolean");
  const ack = typeof r.ack === "string" ? r.ack.slice(0, MAX_ACK_LENGTH) : "";
  return { workerId, generation, ok: r.ok, ack };
}

export class RemoteWorkerClient {
  private readonly graph: WorkGraph;
  private readonly heartbeatMs: number;
  private readonly commandTimeoutMs: number;
  private readonly now: () => number;
  private channels = new Map<string, WorkerChannel>();
  private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Workers with a heartbeat still outstanding, so two never overlap. */
  private inFlightHeartbeat = new Set<string>();

  constructor(opts: RemoteWorkerClientOptions) {
    this.graph = opts.graph;
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Attach a remote channel to a worker (outbound connection from the host). */
  attach(workerId: string, channel: WorkerChannel): void {
    const worker = this.graph.getWorker(workerId);
    if (!worker) throw new Error(`unknown worker ${workerId}`);
    this.channels.set(workerId, channel);
    // Location is a placement attribute, not an orchestration API.
    this.graph.setWorkerStatus(workerId, "RUNNING");
    const existing = channel.onDisconnect;
    channel.onDisconnect = (reason: string) => {
      existing?.(reason);
      this.handleDisconnect(workerId, reason);
    };
    this.startHeartbeat(workerId);
  }

  /** True when a live channel is attached to the worker. */
  isAttached(workerId: string): boolean {
    return this.channels.has(workerId);
  }

  /**
   * Dispatch an idempotent command. If the envelope's generation is stale
   * relative to the worker's current generation, the command is ignored.
   */
  async dispatch(workerId: string, command: WorkerCommand): Promise<CommandResult> {
    const channel = this.channels.get(workerId);
    const worker = this.graph.getWorker(workerId);
    if (!channel || !worker) {
      return { workerId, generation: worker?.generation ?? 0, ok: false, ack: "no channel" };
    }
    const envelope: WorkerCommandEnvelope = {
      workerId,
      generation: worker.generation,
      command,
      issuedAt: new Date().toISOString(),
    };
    // Idempotency: a restart bumps generation; anything sent for the old
    // generation is dropped by the worker/transport.
    //
    // Bounded and validated, because a remote may be slow, absent or hostile.
    // This used to `return channel.send(envelope)` bare: a hung remote never
    // settled, and since the heartbeat also dispatches, one hung worker
    // accumulated a never-settling promise per interval forever. And whatever
    // came back was handed to the caller typed as a `CommandResult` by
    // assertion alone — a hostile host could claim success for a command it
    // never ran, attribute it to a different worker, and return an unbounded
    // `ack`.
    let raw: unknown;
    try {
      raw = await withTimeout(channel.send(envelope), this.commandTimeoutMs, workerId, command.kind);
    } catch (err) {
      // A remote that did not answer is a failed command, not an exception the
      // caller has to model. The worker is marked recovering so supervision can
      // act on it.
      this.graph.setWorkerStatus(workerId, "RECOVERING");
      return {
        workerId,
        generation: worker.generation,
        ok: false,
        ack: err instanceof Error ? err.message : "remote command failed",
      };
    }
    return validateResult(raw, workerId, worker.generation);
  }

  /** Reconnect a dropped worker (generation preserved) — recovery after disconnect. */
  reconnect(workerId: string, channel: WorkerChannel): void {
    this.handleDisconnect(workerId, "reconnect");
    this.attach(workerId, channel);
  }

  /** Mark a worker recovering on disconnect, and clear its channel + heartbeat. */
  handleDisconnect(workerId: string, reason: string): void {
    const timer = this.heartbeatTimers.get(workerId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(workerId);
    }
    this.channels.delete(workerId);
    const worker = this.graph.getWorker(workerId);
    if (worker && worker.status !== "COMPLETED" && worker.status !== "CANCELLED") {
      this.graph.setWorkerStatus(workerId, "RECOVERING");
    }
  }

  private startHeartbeat(workerId: string): void {
    const existing = this.heartbeatTimers.get(workerId);
    if (existing) clearInterval(existing);
    const timer = setInterval(() => {
      // Never two in flight for one worker: a remote slower than the interval
      // otherwise grows an unbounded backlog of outstanding dispatches.
      if (this.inFlightHeartbeat.has(workerId)) return;
      this.inFlightHeartbeat.add(workerId);
      void this.dispatch(workerId, { kind: "heartbeat" })
        .then((result) => {
          // Liveness is recorded from the REMOTE's answer, not before asking.
          // Calling `graph.heartbeat` up front meant the heartbeat measured
          // that this process's own timer was running: a worker that answered
          // nothing at all still looked fresh, and `staleWorkers` was
          // structurally incapable of reporting a hung remote.
          if (result.ok) this.graph.heartbeat(workerId);
        })
        .finally(() => {
          this.inFlightHeartbeat.delete(workerId);
        });
    }, this.heartbeatMs);
    // Do not keep the process alive for a remote heartbeat.
    timer.unref?.();
    this.heartbeatTimers.set(workerId, timer);
  }

  /** Stop all timers and close channels (shutdown). */
  dispose(): void {
    for (const [workerId, timer] of this.heartbeatTimers) {
      clearInterval(timer);
      void this.channels.get(workerId)?.close();
    }
    this.heartbeatTimers.clear();
    this.channels.clear();
  }
}

/** A stable correlation/ack id helper. */
export const newAck = (): string => id("ACK");
