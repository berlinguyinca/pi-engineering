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
import { paneLink, tidyAgentName } from "./CollabLayout.ts";
import type { ControlPlaneIngest } from "./ControlPlaneIngest.ts";
import { type HerdrAgent, type HerdrCli, HerdrError } from "./HerdrCli.ts";
import { AttemptTransitions, type LineageEmitter, type LineageState } from "./lineage.ts";

const VERSION = "herdr-0.9.1";

interface Rec {
  worker: AgentWorker;
  request: AgentWorkerRequest;
  target: string;
  provisioned: boolean;
  /** True once the lineage spawn was emitted; attempt states are only sent for a known attempt. */
  lineageSpawned?: boolean;
}

/** Runtime status -> lineage attempt state. Unlisted statuses (READY, CREATED, INTERRUPTED...) are not transitions. */
const LINEAGE_STATE: Partial<Record<AgentStatus, LineageState>> = {
  WORKING: "running",
  RECOVERING: "running",
  BLOCKED: "blocked",
  COMPLETED: "done",
  FAILED: "failed",
  LOST: "failed",
  TERMINATED: "cancelled",
};

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
  /**
   * Optional control-plane emitter (Phase 2). When present, agent/session/
   * host/mission lifecycle is reported to the Dev Fabric control plane. Off
   * by default (no emitter = no network).
   */
  ingest?: ControlPlaneIngest;
  /**
   * Optional lineage emitter (T02). Off by default: without it no lineage is
   * built and behaviour is unchanged.
   */
  lineage?: LineageEmitter;
}

export class HerdrAgentRuntime implements AgentRuntime {
  readonly capabilities: AgentCapabilities;
  private readonly cli: HerdrCli;
  private readonly agentKind: string;
  private readonly records = new Map<RuntimeId, Rec>();
  private readonly ingest?: ControlPlaneIngest;
  private readonly lineage?: LineageEmitter;
  private readonly lineageTransitions = new AttemptTransitions();

  constructor(opts: HerdrAgentRuntimeOptions) {
    this.cli = opts.cli;
    this.agentKind = opts.agentKind ?? "pi";
    this.ingest = opts.ingest;
    this.lineage = opts.lineage;
    if (this.ingest) void this.ingest.hostRegistered().catch(() => {});
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
      missionId: req.missionId,
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
    this.emitSession(rec, "session.started", rec.worker.status);
    this.emitSpawn(rec);
    this.emitSurface(rec, "open", "surface-open");
    return rec.worker;
  }

  async sendTask(rid: RuntimeId, task: string, req?: Partial<AgentWorkerRequest>): Promise<AgentWorker> {
    const rec = this.require(rid);
    if (req) rec.request = { ...rec.request, ...req };
    rec.worker.objective = task;
    await this.provision(rec);
    await this.cli.prompt(rec.target, task);
    this.mutate(rec, { status: "WORKING", objective: task, currentOperation: "sendTask", result: null });
    this.emitSession(rec, "session.updated", "WORKING");
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
    let agent: HerdrAgent;
    try {
      agent = await this.cli.wait(rec.target, until, timeoutMs ?? 300_000);
    } catch (err) {
      // A wait that times out or fails leaves the attempt neither running nor done: say so.
      this.emitAttemptState(
        rec,
        "failed",
        `wait failed: ${err instanceof Error ? err.message : "error"}`.slice(0, 200),
      );
      throw err;
    }
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
    this.emitSession(rec, "session.updated", status);
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
    this.emitSession(rec, "session.updated", "INTERRUPTED");
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
    this.emitSurface(rec, "closed", "surface-closed", "pane closed by Pi terminate");
    this.mutate(rec, { status: "TERMINATED", currentOperation: "terminate" });
    this.emitSession(rec, "session.terminated", "TERMINATED");
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
    if (!live && status === "LOST") this.emitSurface(rec, "gone", "surface-gone", "agent no longer present in Herdr");
    this.mutate(rec, { status, currentOperation: "resumeOrReconcile" });
    this.emitSession(rec, "session.updated", status);
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
    // The attempt state follows the runtime status through this one choke point, so polling
    // (sync), waiting, resuming and terminating all share the same dedupe and finality rules.
    const state = patch.status ? LINEAGE_STATE[patch.status] : undefined;
    if (state) this.emitAttemptState(rec, state);
  }

  /** Lineage: this runtime worker is one agent, one attempt, one session. start() is idempotent per id. */
  private emitSpawn(rec: Rec): void {
    const lineage = this.lineage;
    if (!lineage) return;
    try {
      const wid = rec.worker.id;
      const parent = rec.request.parentRuntimeId;
      lineage.workerSpawned({
        agent: wid,
        attempt: wid,
        session: wid,
        // parentRuntimeId is the one real parent datum; absent => no spawn edge.
        parentAgent: parent,
        parentAttempt: parent,
        missionId: rec.worker.missionId,
        role: rec.worker.role,
        model: rec.worker.model,
        transition: "start",
        at: rec.worker.updated_at,
      });
      rec.lineageSpawned = true;
    } catch {
      /* observational */
    }
  }

  /** The worker's tab (top-level) or pane (helper). A surface fact only: it never moves the agent or attempt. */
  private emitSurface(rec: Rec, state: "open" | "closed" | "gone", transition: string, reason?: string): void {
    const lineage = this.lineage;
    if (!lineage || !rec.lineageSpawned) return;
    try {
      lineage.surfaceState(
        {
          surface: rec.request.parentRuntimeId ? "pane" : "tab",
          id: rec.worker.id,
          agent: rec.worker.id,
          missionId: rec.worker.missionId,
          at: rec.worker.updated_at,
        },
        state,
        transition,
        reason,
      );
    } catch {
      /* observational */
    }
  }

  private emitAttemptState(rec: Rec, state: LineageState, reason?: string): void {
    const lineage = this.lineage;
    if (!lineage || !rec.lineageSpawned) return;
    try {
      // Unchanged state => null; done/cancelled are final, so terminate() on a completed worker is a no-op.
      const transition = this.lineageTransitions.advance(rec.worker.id, state);
      if (transition === null) return;
      lineage.attemptState(
        { attempt: rec.worker.id, agent: rec.worker.id, missionId: rec.worker.missionId },
        state,
        transition,
        reason,
        rec.worker.updated_at,
      );
    } catch {
      /* observational */
    }
  }

  /** Fire-and-forget control-plane session event (best-effort, never blocks). */
  private emitSession(
    rec: Rec,
    eventType: "session.started" | "session.updated" | "session.terminated",
    status: string,
  ): void {
    this.ingest
      ?.session(rec.worker.id, eventType, {
        missionId: rec.worker.missionId,
        agentRole: rec.worker.role,
        model: rec.worker.model ?? undefined,
        status,
        parentSessionId: rec.request.parentRuntimeId,
        // rec.target is a workspace id after worktree provisioning; only a pane id (`w2B:p1`) is a pane
        paneId: rec.target.includes(":") ? rec.target : undefined,
        // rec.target is a workspace id after worktree provisioning; only a pane id (`w2B:p1`) makes a pane link
        instanceId:
          this.ingest && rec.target.includes(":")
            ? (paneLink(this.ingest.host.hostId, rec.target) ?? undefined)
            : undefined,
        name: tidyAgentName(`${rec.worker.role}-${rec.worker.id.slice(-6)}`) ?? undefined,
      })
      .catch(() => {});
  }
}
