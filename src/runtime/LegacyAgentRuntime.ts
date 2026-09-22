/**
 * LegacyAgentRuntime — the CURRENT runtime behind the AgentRuntime seam.
 *
 * This adapter wraps the existing fresh-context `WorkerExecutor` (Phase C of the
 * migration: put the current runtime behind AgentRuntime first, with contract
 * tests passing, before introducing Herdr). It is the rollback target: if Herdr
 * must be disabled, Pi-Engineering falls back to this adapter unchanged.
 *
 * The legacy runtime is a single-shot executor (`run(req) -> WorkerRun`): there
 * is no persistent process to send multiple tasks to. This adapter therefore
 * models each worker as a created record that settles on the first `sendTask`.
 * `interrupt`/`terminate` update the persisted status; they cannot abort an
 * in-flight `WorkerExecutor.run` because the legacy executor does not accept an
 * AbortSignal (a documented limitation, not a regression).
 *
 * Context limits are NOT hard-coded here: `maxTokens` is taken from the request
 * `ContextPolicy` (which callers resolve from runtime/InferWeave metadata).
 */

import { id } from "../core/ids.ts";
import type { WorkerExecutor, WorkerRequest } from "../workers/WorkerExecutor.ts";
import type {
  AgentCapabilities,
  AgentDuration,
  AgentHealth,
  AgentStatus,
  AgentWorker,
  AgentWorkerRequest,
  AgentWorkerResult,
  RuntimeId,
} from "./AgentRuntime.ts";
import type { AgentRuntime } from "./AgentRuntime.ts";

const VERSION = "legacy-0.2.0";

/** Internal mutable worker record. */
interface Record {
  worker: AgentWorker;
  request: AgentWorkerRequest;
  promise?: Promise<AgentWorker>;
  /** Settles when the underlying run resolves. */
  settle?: (w: AgentWorker) => void;
  settled?: boolean;
}

function toWorkerResult(r: Awaited<ReturnType<WorkerExecutor["run"]>>): AgentWorkerResult {
  const res = r.result;
  return {
    status: res.status,
    summary: res.summary ?? "",
    artifactRefs: res.evidence_refs ?? [],
    error: res.error ?? r.error,
    details: res.details ?? {},
  };
}

export interface LegacyAgentRuntimeOptions {
  worker: WorkerExecutor;
  /** Discovered context ceiling from runtime/InferWeave metadata (optional). */
  maxContextTokens?: number;
  /** Runtime identity/version string. */
  version?: string;
}

export class LegacyAgentRuntime implements AgentRuntime {
  readonly capabilities: AgentCapabilities;
  private readonly worker: WorkerExecutor;
  private readonly records = new Map<RuntimeId, Record>();

  constructor(opts: LegacyAgentRuntimeOptions) {
    this.worker = opts.worker;
    this.capabilities = {
      name: "legacy",
      version: opts.version ?? VERSION,
      persistent: true,
      worktrees: true,
      remoteHosts: false,
      recovery: false,
      boundedOutput: true,
      attach: false,
      maxContextTokens: opts.maxContextTokens,
      operations: [
        "create",
        "start",
        "sendTask",
        "get",
        "list",
        "boundedOutput",
        "waitFor",
        "interrupt",
        "terminate",
        "resume",
        "attach",
        "health",
        "capabilities",
      ],
    };
  }

  async create(req: AgentWorkerRequest): Promise<RuntimeId> {
    const now = new Date().toISOString();
    const worker: AgentWorker = {
      id: id("RT"),
      runtime: "legacy",
      status: "CREATED",
      role: req.role,
      objective: req.objective,
      worktree: req.worktree ?? null,
      model: req.modelOverride?.id ?? null,
      created_at: now,
      updated_at: now,
      currentOperation: "create",
      result: null,
    };
    this.records.set(worker.id, { worker, request: req });
    return worker.id;
  }

  async start(rid: RuntimeId): Promise<AgentWorker> {
    const rec = this.require(rid);
    this.mutate(rec, { status: "READY", currentOperation: "start" });
    return rec.worker;
  }

  async sendTask(rid: RuntimeId, task: string, req?: Partial<AgentWorkerRequest>): Promise<AgentWorker> {
    const rec = this.require(rid);
    const merged: AgentWorkerRequest = { ...rec.request, ...req, objective: task };
    rec.request = merged;
    if (rec.settled) {
      // Runtime-neutral resume: re-run the objective on a settled worker.
      rec.settled = false;
      rec.promise = undefined;
    }
    this.mutate(rec, {
      status: "WORKING",
      objective: task,
      currentOperation: "sendTask",
      result: null,
    });
    rec.promise = this.execute(rec);
    return rec.worker;
  }

  async get(rid: RuntimeId): Promise<AgentWorker | undefined> {
    return this.records.get(rid)?.worker;
  }

  async list(): Promise<AgentWorker[]> {
    return [...this.records.values()].map((r) => r.worker);
  }

  async boundedOutput(rid: RuntimeId, maxChars?: number): Promise<string> {
    const rec = this.require(rid);
    const out = rec.worker.boundedOutput ?? rec.worker.result?.summary ?? "";
    const cap = maxChars ?? 4000;
    return out.length > cap ? `${out.slice(0, cap)}…` : out;
  }

  async waitFor(rid: RuntimeId, timeoutMs?: number, signal?: AbortSignal): Promise<AgentWorker> {
    const rec = this.require(rid);
    if (rec.settled && rec.promise) return rec.promise;
    if (!rec.promise) {
      // No task sent yet; a no-op wait resolves with the current state.
      return rec.worker;
    }
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`waitFor timeout after ${timeoutMs ?? 0}ms`)), timeoutMs ?? 0);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("waitFor aborted"));
      });
      if (!timeoutMs || timeoutMs <= 0) clearTimeout(t);
    });
    return Promise.race([rec.promise, timeout]);
  }

  async interrupt(rid: RuntimeId): Promise<AgentWorker> {
    const rec = this.require(rid);
    if (rec.worker.status === "WORKING") {
      this.mutate(rec, {
        status: "INTERRUPTED",
        currentOperation: "interrupt",
        boundedOutput: `${rec.worker.boundedOutput ?? ""}\n[interrupted by operator]`,
      });
    }
    return rec.worker;
  }

  async terminate(rid: RuntimeId): Promise<boolean> {
    const rec = this.records.get(rid);
    if (!rec) return false;
    this.mutate(rec, { status: "TERMINATED", currentOperation: "terminate" });
    return true;
  }

  /** Legacy runtime has no durable restart; reconcile re-asserts current state. */
  async resumeOrReconcile(rid: RuntimeId): Promise<AgentWorker> {
    const rec = this.require(rid);
    // Classify: a settled worker is completed-offline; an unsettled WORKING one
    // is missing (legacy cannot resume an in-flight run). Pi-Engineering must
    // not blindly rerun work that may have mutated Git (spec 13).
    const status: AgentStatus = rec.settled ? rec.worker.status : "LOST";
    this.mutate(rec, { status, currentOperation: "resumeOrReconcile" });
    return rec.worker;
  }

  async attach(rid: RuntimeId): Promise<AgentWorker> {
    const rec = this.require(rid);
    this.mutate(rec, { currentOperation: "attach" });
    return rec.worker;
  }

  async health(): Promise<AgentHealth> {
    const active = [...this.records.values()].filter(
      (r) => r.worker.status === "WORKING" || r.worker.status === "READY" || r.worker.status === "STARTING",
    ).length;
    return {
      runtime: "legacy",
      ok: true,
      activeWorkers: active,
      detail: { version: this.capabilities.version, totalWorkers: this.records.size },
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async execute(rec: Record): Promise<AgentWorker> {
    const req = rec.request;
    const workerReq: WorkerRequest = {
      role: req.role as WorkerRequest["role"],
      task: req.objective,
      tools: req.permissions ?? [
        "ledger_read",
        "ledger_claim",
        "artifact_read",
        "repo_search",
        "symbol",
        "tests_for",
        "bash",
      ],
      cwd: req.worktree ?? req.cwd ?? process.cwd(),
      timeoutMs: req.timeoutMs,
      maxContextTokens: req.contextPolicy?.maxTokens,
      modelOverride: req.modelOverride ?? undefined,
      systemPromptOverride: req.systemPromptOverride,
      images: req.images,
      resultTool: req.resultTool,
      kickoff: req.kickoff,
    };
    try {
      const run = await this.worker.run(workerReq);
      const result = toWorkerResult(run);
      const status: AgentStatus =
        result.status === "completed" ? "COMPLETED" : result.status === "blocked" ? "BLOCKED" : "FAILED";
      this.mutate(rec, {
        status,
        currentOperation: "done",
        boundedOutput: result.summary,
        result,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.mutate(rec, {
        status: "FAILED",
        currentOperation: "failed",
        boundedOutput: msg,
        result: { status: "failed", summary: msg, artifactRefs: [], error: msg },
      });
    }
    rec.settled = true;
    rec.settle?.(rec.worker);
    return rec.worker;
  }

  private require(rid: RuntimeId): Record {
    const rec = this.records.get(rid);
    if (!rec) throw new Error(`unknown runtime id: ${rid}`);
    return rec;
  }

  private mutate(rec: Record, patch: Partial<AgentWorker>): void {
    rec.worker = { ...rec.worker, ...patch, updated_at: new Date().toISOString() };
    this.records.set(rec.worker.id, rec);
  }
}
