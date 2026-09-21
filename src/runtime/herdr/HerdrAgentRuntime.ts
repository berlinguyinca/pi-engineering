/**
 * HerdrAgentRuntime — Herdr behind the AgentRuntime seam (herdr spec 03).
 *
 * All Herdr access flows through `HerdrCli`; all of Pi-Engineering's access to
 * Herdr flows through THIS class (and then the `AgentRuntime` interface). Herdr
 * is the persistent process/agent runtime; Pi-Engineering decides why a worker
 * exists, Herdr decides how to run it.
 *
 * Runtime IDs are opaque Pi-generated ids; the Herdr pane/workspace target is an
 * internal detail. Context/request budgeting is NOT Herdr's job (spec 06) — this
 * adapter passes the objective through and relies on Pi-Engineering to have
 * already bounded it.
 */

import { id } from "../../core/ids.ts";
import type {
  AgentCapabilities,
  AgentHealth,
  AgentStatus,
  AgentWorker,
  AgentWorkerRequest,
  AgentWorkerResult,
  RuntimeId,
} from "../AgentRuntime.ts";
import type { AgentRuntime } from "../AgentRuntime.ts";
import { type HerdrAgent, type HerdrCli, HerdrError } from "./HerdrCli.ts";

const VERSION = "herdr-0.9.1";

interface Rec {
  worker: AgentWorker;
  request: AgentWorkerRequest;
  target: string;
  provisioned: boolean;
}

/** Map a Herdr agent status to the normalized AgentStatus. */
function normalizeStatus(s: HerdrAgent["agent_status"]): AgentStatus {
  switch (s) {
    case "idle":
      return "READY";
    case "working":
      return "WORKING";
    case "blocked":
      return "BLOCKED";
    case "done":
      return "COMPLETED";
    default:
      return "LOST";
  }
}

export interface HerdrAgentRuntimeOptions {
  cli: HerdrCli;
  /** Discovered context ceiling from InferWeave/runtime metadata. */
  maxContextTokens?: number;
  /** Agent kind Herdr should start (defaults to the Pi integration kind). */
  agentKind?: string;
}

export class HerdrAgentRuntime implements AgentRuntime {
  readonly capabilities: AgentCapabilities;
  private readonly cli: HerdrCli;
  private readonly agentKind: string;
  private readonly records = new Map<RuntimeId, Rec>();

  constructor(opts: HerdrAgentRuntimeOptions) {
    this.cli = opts.cli;
    this.agentKind = opts.agentKind ?? "pi";
    this.capabilities = {
      name: "herdr",
      version: VERSION,
      persistent: true,
      worktrees: true,
      remoteHosts: true,
      recovery: true,
      boundedOutput: true,
      attach: true,
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
      id: id("HERD"),
      runtime: "herdr",
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
    // The Herdr target (pane/workspace) is internal and opaque to Pi.
    this.records.set(worker.id, { worker, request: req, target: worker.id, provisioned: false });
    return worker.id;
  }

  async start(rid: RuntimeId): Promise<AgentWorker> {
    const rec = this.require(rid);
    await this.provision(rec);
    this.mutate(rec, { status: "READY", currentOperation: "start" });
    return rec.worker;
  }

  async sendTask(rid: RuntimeId, task: string, req?: Partial<AgentWorkerRequest>): Promise<AgentWorker> {
    const rec = this.require(rid);
    if (req) rec.request = { ...rec.request, ...req };
    rec.worker.objective = task;
    await this.provision(rec);
    await this.cli.prompt(rec.target, task);
    this.mutate(rec, { status: "WORKING", objective: task, currentOperation: "sendTask", result: null });
    return rec.worker;
  }

  async get(rid: RuntimeId): Promise<AgentWorker | undefined> {
    const rec = this.records.get(rid);
    if (!rec) return undefined;
    await this.sync(rec);
    return rec.worker;
  }

  async list(): Promise<AgentWorker[]> {
    for (const rec of [...this.records.values()]) await this.sync(rec).catch(() => {});
    return [...this.records.values()].map((r) => r.worker);
  }

  async boundedOutput(rid: RuntimeId, maxChars?: number): Promise<string> {
    const rec = this.require(rid);
    let out: string;
    try {
      out = await this.cli.readAgent(rec.target, 200);
    } catch {
      out = rec.worker.boundedOutput ?? rec.worker.result?.summary ?? "";
    }
    const cap = maxChars ?? 4000;
    return out.length > cap ? `${out.slice(0, cap)}…` : out;
  }

  async waitFor(rid: RuntimeId, timeoutMs?: number, signal?: AbortSignal): Promise<AgentWorker> {
    const rec = this.require(rid);
    if (signal?.aborted) throw new Error("waitFor aborted");
    const until = ["done", "blocked", "working", "idle"];
    const agent = await this.cli.wait(rec.target, until, timeoutMs ?? 300_000);
    const status = normalizeStatus(agent.agent_status);
    const result: AgentWorkerResult =
      status === "COMPLETED"
        ? {
            status: "completed",
            summary: rec.worker.boundedOutput ?? `completed ${rec.worker.objective}`,
            artifactRefs: [],
          }
        : status === "BLOCKED"
          ? { status: "blocked", summary: "blocked", artifactRefs: [] }
          : { status: "failed", summary: "did not reach a terminal state", artifactRefs: [] };
    this.mutate(rec, { status, currentOperation: "waitFor", result });
    return rec.worker;
  }

  async interrupt(rid: RuntimeId): Promise<AgentWorker> {
    const rec = this.require(rid);
    try {
      await this.cli.sendKeys(rec.target, "\\x03");
    } catch {
      /* best-effort */
    }
    this.mutate(rec, { status: "INTERRUPTED", currentOperation: "interrupt" });
    return rec.worker;
  }

  async terminate(rid: RuntimeId): Promise<boolean> {
    const rec = this.records.get(rid);
    if (!rec) return false;
    try {
      await this.cli.closePane(rec.target);
    } catch {
      /* best-effort */
    }
    this.mutate(rec, { status: "TERMINATED", currentOperation: "terminate" });
    return true;
  }

  async resumeOrReconcile(rid: RuntimeId): Promise<AgentWorker> {
    const rec = this.require(rid);
    // Classify the persisted worker against the live runtime (spec 13).
    const live = await this.cli.getAgent(rec.target).catch(() => null);
    let status: AgentStatus;
    if (live) {
      status = normalizeStatus(live.agent_status);
      if (status === "WORKING" || status === "READY") status = "RECOVERING";
      if (status === "LOST") status = "LOST";
    } else {
      status = rec.worker.status === "COMPLETED" || rec.worker.status === "TERMINATED" ? rec.worker.status : "LOST";
    }
    this.mutate(rec, { status, currentOperation: "resumeOrReconcile" });
    return rec.worker;
  }

  async attach(rid: RuntimeId): Promise<AgentWorker> {
    const rec = this.require(rid);
    this.mutate(rec, { currentOperation: "attach" });
    return rec.worker;
  }

  async health(): Promise<AgentHealth> {
    const st = await this.cli.status().catch(() => null);
    const active = [...this.records.values()].filter((r) => r.worker.status === "WORKING").length;
    return {
      runtime: "herdr",
      ok: st?.ok ?? false,
      activeWorkers: active,
      detail: { serverVersion: st?.serverVersion ?? "unreachable", protocol: st?.protocol ?? 0 },
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async provision(rec: Rec): Promise<void> {
    if (rec.provisioned) return;
    if (rec.request.isolation === "worktree") {
      try {
        const wt = await this.cli.createWorktree(rec.request.cwd ?? process.cwd());
        rec.target = wt.workspaceId;
        rec.worker.worktree = wt.path;
      } catch {
        // Fall back to the opaque target; provisioning is best-effort.
      }
    }
    try {
      await this.cli.startAgent(rec.target, this.agentKind, rec.worker.role);
    } catch (err) {
      if (err instanceof HerdrError && err.code === "agent_start_failed") throw err;
      throw new HerdrError(
        "agent_start_failed",
        `could not start Herdr agent: ${err instanceof Error ? err.message : err}`,
      );
    }
    rec.provisioned = true;
  }

  private async sync(rec: Rec): Promise<void> {
    const live = await this.cli.getAgent(rec.target).catch(() => null);
    if (live) {
      this.mutate(rec, { status: normalizeStatus(live.agent_status) });
    }
  }

  private require(rid: RuntimeId): Rec {
    const rec = this.records.get(rid);
    if (!rec) throw new HerdrError("unknown_runtime_id", `unknown runtime id: ${rid}`);
    return rec;
  }

  private mutate(rec: Rec, patch: Partial<AgentWorker>): void {
    rec.worker = { ...rec.worker, ...patch, updated_at: new Date().toISOString() };
    this.records.set(rec.worker.id, rec);
  }
}
