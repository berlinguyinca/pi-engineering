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
  now?: () => number;
}

export class RemoteWorkerClient {
  private readonly graph: WorkGraph;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private channels = new Map<string, WorkerChannel>();
  private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(opts: RemoteWorkerClientOptions) {
    this.graph = opts.graph;
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
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
    return channel.send(envelope);
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
      this.graph.heartbeat(workerId);
      void this.dispatch(workerId, { kind: "heartbeat" });
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
