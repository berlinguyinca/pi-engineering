/**
 * HTTP transport for remote workers (spec 12, Phase 2-lite).
 *
 * The RemoteWorkerClient contract (a `WorkerChannel.send(envelope)` that awaits
 * a `CommandResult`) is satisfied over plain Node HTTP with no external
 * dependencies:
 *
 *   GET  /worker/attach?workerId=W&projectId=P&role=R&node=N&generation=G
 *        (auth)  -> opens an SSE stream from the control plane to the remote
 *                   node agent. The control plane pushes command envelopes as
 *                   `event: command` frames. The worker is created as REMOTE
 *                   (location host=N) if it does not already exist, and a
 *                   channel is attached so the platform's RemoteWorkerClient
 *                   can dispatch to it.
 *   POST /worker/result  (auth) -> the remote agent answers a command. Body:
 *                   { correlationId, workerId, generation, ok, ack }
 *                   Resolves the pending `send()` for that command.
 *
 * The remote node dials IN over this outbound connection (no public inbound
 * port needed on the controller) and is authenticated with the same bearer
 * token as the rest of the control plane. Commands stay idempotent and bounded
 * (the platform already enforces a command timeout and validates the reply).
 */
import type { ServerResponse } from "node:http";
import type { IncomingMessage } from "node:http";
import type { CommandResult, WorkerChannel, WorkerCommandEnvelope } from "./RemoteWorker.ts";
import type { Platform } from "./index.ts";

/** Keep-alive sent on an idle SSE stream so a proxy does not time it out. */
const SSE_KEEPALIVE_MS = 15_000;

interface Pending {
  workerId: string;
  resolve: (result: CommandResult) => void;
}

export class RemoteHttpTransport {
  private readonly platform: Platform;
  /** workerId -> the open SSE response (one channel per worker). */
  private streams = new Map<string, ServerResponse>();
  /** correlationId -> pending send, awaiting the remote's /worker/result. */
  private pending = new Map<string, Pending>();

  constructor(platform: Platform) {
    this.platform = platform;
  }

  private correlationId(): string {
    return `cor_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  }

  /** True if a worker has an open remote channel. */
  isAttached(workerId: string): boolean {
    return this.streams.has(workerId);
  }

  /**
   * Handle `GET /worker/attach`. Opens an SSE stream and attaches a channel.
   * Creates the worker as REMOTE if it does not already exist.
   */
  attach(
    workerId: string,
    opts: { projectId: string; role: string; node: string; generation?: number },
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    let worker = this.platform.graph.getWorker(workerId);
    if (!worker) {
      worker = this.platform.graph.createWorker({
        id: workerId,
        projectId: opts.projectId,
        role: opts.role,
        location: { host: opts.node || "remote", remote: true },
      });
    }

    const channel: WorkerChannel = {
      host: opts.node || "remote",
      send: (envelope) => this.send(envelope),
      close: () => this.handleDisconnect(worker.id, "agent closed"),
    };

    // Replace any prior channel for this worker (a reconnect).
    this.handleDisconnect(worker.id, "reconnect");
    this.platform.remote.attach(worker.id, channel);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("event: ready\ndata: {}\n\n");
    this.streams.set(worker.id, res);

    const keepalive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* stream already closed */
      }
    }, SSE_KEEPALIVE_MS);
    keepalive.unref?.();

    res.on("close", () => {
      clearInterval(keepalive);
      this.handleDisconnect(worker.id, "agent disconnected");
    });
    res.on("error", () => {
      clearInterval(keepalive);
      this.handleDisconnect(worker.id, "transport error");
    });
  }

  /**
   * Handle `POST /worker/result`. Resolves the pending send for a command.
   */
  result(body: Record<string, unknown>): CommandResult | null {
    const correlationId = typeof body.correlationId === "string" ? body.correlationId : "";
    const pending = correlationId ? this.pending.get(correlationId) : undefined;
    if (!pending) return null;
    this.pending.delete(correlationId);
    const workerId = typeof body.workerId === "string" ? body.workerId : pending.workerId;
    const generation = typeof body.generation === "number" ? body.generation : 0;
    const ok = body.ok === true;
    const ack = typeof body.ack === "string" ? body.ack.slice(0, 4_096) : "";
    const result: CommandResult = { workerId, generation, ok, ack };
    pending.resolve(result);
    return result;
  }

  /** Send a command over the worker's SSE stream and await its result. */
  private send(envelope: WorkerCommandEnvelope): Promise<CommandResult> {
    const res = this.streams.get(envelope.workerId);
    if (!res) {
      return Promise.resolve({ workerId: envelope.workerId, generation: envelope.generation, ok: false, ack: "no channel" });
    }
    const correlationId = this.correlationId();
    const framed: WorkerCommandEnvelope = { ...envelope, correlationId };
    const promise = new Promise<CommandResult>((resolve) => {
      this.pending.set(correlationId, { workerId: envelope.workerId, resolve });
    });
    try {
      res.write(`event: command\ndata: ${JSON.stringify(framed)}\n\n`);
    } catch {
      this.pending.delete(correlationId);
      this.handleDisconnect(envelope.workerId, "write failed");
      return Promise.resolve({ workerId: envelope.workerId, generation: envelope.generation, ok: false, ack: "write failed" });
    }
    return promise;
  }

  private handleDisconnect(workerId: string, reason: string): void {
    const res = this.streams.get(workerId);
    this.streams.delete(workerId);
    if (res) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    // Drop any commands still awaiting an answer from a vanished agent.
    for (const [cid, p] of this.pending) {
      if (p.workerId === workerId) {
        this.pending.delete(cid);
        p.resolve({ workerId, generation: 0, ok: false, ack: `agent disconnected: ${reason}` });
      }
    }
    this.platform.remote.handleDisconnect(workerId, reason);
  }

  /** Close all streams (shutdown). */
  dispose(): void {
    for (const [workerId] of this.streams) this.handleDisconnect(workerId, "shutdown");
    for (const [cid, p] of this.pending) {
      this.pending.delete(cid);
      p.resolve({ workerId: p.workerId, generation: 0, ok: false, ack: "shutdown" });
    }
  }
}
