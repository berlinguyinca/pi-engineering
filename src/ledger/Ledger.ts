import { newCandidateId, newEntityId, newEventId, newEvidenceId, newTaskId, newWorkItemId } from "../core/ids.ts";
import type {
  Actor,
  Candidate,
  CandidateStatus,
  EntityStatus,
  Evidence,
  LedgerEntity,
  LedgerEvent,
  RiskLevel,
  Task,
  WorkItem,
  WorkItemStatus,
  WorkerRole,
} from "../core/types.ts";
import { EventStore } from "./EventStore.ts";

/**
 * The Engineering Ledger (spec §9): durable, event-sourced shared memory.
 *
 * Immutable events are appended to an EventStore; a materialized in-memory view
 * is maintained for fast queries. The ledger is the authoritative representation
 * of requirements, facts, hypotheses, decisions, findings, tasks, candidates,
 * evidence, and promotions. It survives crashes by replaying events.
 */
export class Ledger {
  private readonly store: EventStore;

  private workItems = new Map<string, WorkItem>();
  private candidates = new Map<string, Candidate>();
  private tasks = new Map<string, Task>();
  private entities = new Map<string, LedgerEntity>();
  private evidence = new Map<string, Evidence>();

  private constructor(store: EventStore) {
    this.store = store;
  }

  static async create(eventFile: string): Promise<Ledger> {
    const store = await EventStore.create(eventFile);
    const ledger = new Ledger(store);
    // Rebuild materialized state from events (INV-012, AC-011).
    for (const evt of store.all()) ledger.apply(evt);
    return ledger;
  }

  /** Reconstruct a ledger directly from an in-memory event list (for tests). */
  static fromEvents(events: LedgerEvent[]): Ledger {
    const ledger = new Ledger(EventStore.inMemory());
    for (const evt of events) ledger.apply(evt);
    return ledger;
  }

  // ------------------------------------------------------------------ events

  private async emit(
    type: LedgerEvent["type"],
    workItemId: string | null,
    actor: Actor,
    payload: Record<string, unknown>,
  ): Promise<LedgerEvent> {
    const event: LedgerEvent = {
      event_id: newEventId(),
      work_item_id: workItemId,
      timestamp: new Date().toISOString(),
      actor,
      type,
      payload,
    };
    await this.store.append(event);
    this.apply(event);
    return event;
  }

  private apply(event: LedgerEvent): void {
    const p = event.payload;
    switch (event.type) {
      case "work_item.created": {
        const wi = p.workItem as WorkItem;
        this.workItems.set(wi.id, wi);
        break;
      }
      case "work_item.updated": {
        const wi = this.workItems.get(event.work_item_id!);
        if (wi) {
          const upd = p as Partial<WorkItem>;
          Object.assign(wi, upd);
          wi.updated_at = event.timestamp;
          if (event.work_item_id) this.workItems.set(event.work_item_id, wi);
        }
        break;
      }
      case "candidate.created": {
        const c = p.candidate as Candidate;
        this.candidates.set(c.id, c);
        break;
      }
      case "candidate.changed": {
        const c = this.candidates.get(p.candidate_id as string);
        if (c) Object.assign(c, p.changes as Partial<Candidate>);
        break;
      }
      case "candidate.rejected": {
        const c = this.candidates.get(p.candidate_id as string);
        if (c) {
          c.status = "REJECTED";
          c.rejection_reason = (p.reason as string) ?? null;
        }
        break;
      }
      case "candidate.promoted": {
        const c = this.candidates.get(p.candidate_id as string);
        if (c) c.status = "PROMOTED";
        break;
      }
      case "task.created": {
        const t = p.task as Task;
        this.tasks.set(t.id, t);
        break;
      }
      case "task.completed":
      case "task.started":
      case "task.blocked": {
        const t = this.tasks.get(p.task_id as string);
        if (t) {
          if (typeof p.status === "string") t.status = p.status as Task["status"];
          if (Array.isArray(p.depends_on)) t.depends_on = p.depends_on as string[];
          if (Array.isArray(p.scope_paths)) t.scope_paths = p.scope_paths as string[];
          if (typeof p.result_work_item_id === "string") t.result_work_item_id = p.result_work_item_id;
        }
        break;
      }
      case "fact.verified":
      case "hypothesis.created":
      case "hypothesis.rejected":
      case "decision.proposed":
      case "decision.accepted":
      case "finding.created":
      case "finding.resolved":
      case "entity.updated": {
        const e = p.entity as LedgerEntity;
        this.entities.set(e.id, e);
        break;
      }
      case "requirement.created":
      case "invariant.created":
      case "test-obligation.created": {
        const e = p.entity as LedgerEntity;
        this.entities.set(e.id, e);
        break;
      }
      case "evidence.recorded": {
        const e = p.evidence as Evidence;
        this.evidence.set(e.id, e);
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- work items

  async createWorkItem(goal: string, risk: RiskLevel, repositories: string[], actor: Actor): Promise<WorkItem> {
    const now = new Date().toISOString();
    const wi: WorkItem = {
      id: newWorkItemId(),
      goal,
      risk,
      status: "DEFINED",
      repositories,
      created_at: now,
      updated_at: now,
      current_candidate_id: null,
      incumbent_candidate_id: null,
    };
    await this.emit("work_item.created", wi.id, actor, { workItem: wi });
    return wi;
  }

  async updateWorkItem(id: string, changes: Partial<WorkItem>, actor: Actor): Promise<void> {
    await this.emit("work_item.updated", id, actor, changes as Record<string, unknown>);
  }

  getWorkItem(id: string): WorkItem | undefined {
    return this.workItems.get(id);
  }

  listWorkItems(): WorkItem[] {
    return [...this.workItems.values()];
  }

  // ---------------------------------------------------------------- candidates

  async createCandidate(
    workItemId: string,
    baseCommit: string,
    branch: string,
    worktreePath: string | null,
    producerRole: WorkerRole,
    producerRunId: string,
    parentId: string | null,
    actor: Actor,
  ): Promise<Candidate> {
    const now = new Date().toISOString();
    const candidate: Candidate = {
      id: newCandidateId(),
      work_item_id: workItemId,
      parent_id: parentId,
      status: "CREATED",
      base_commit: baseCommit,
      branch,
      worktree_path: worktreePath,
      producer_run_id: producerRunId,
      producer_role: producerRole,
      diff: null,
      diff_artifact_uri: null,
      changed_files: [],
      evidence_ids: [],
      rejection_reason: null,
      created_at: now,
    };
    await this.emit("candidate.created", workItemId, actor, { candidate });
    await this.updateWorkItem(workItemId, { current_candidate_id: candidate.id }, actor);
    return candidate;
  }

  async changeCandidate(id: string, changes: Partial<Candidate>, workItemId: string, actor: Actor): Promise<void> {
    await this.emit("candidate.changed", workItemId, actor, { candidate_id: id, changes });
  }

  async rejectCandidate(id: string, workItemId: string, reason: string, actor: Actor): Promise<void> {
    await this.emit("candidate.rejected", workItemId, actor, { candidate_id: id, reason });
  }

  async promoteCandidate(id: string, workItemId: string, actor: Actor): Promise<void> {
    await this.emit("candidate.promoted", workItemId, actor, { candidate_id: id });
    await this.updateWorkItem(workItemId, { incumbent_candidate_id: id }, actor);
  }

  getCandidate(id: string): Candidate | undefined {
    return this.candidates.get(id);
  }

  listCandidates(workItemId?: string): Candidate[] {
    const all = [...this.candidates.values()];
    return workItemId ? all.filter((c) => c.work_item_id === workItemId) : all;
  }

  // ---------------------------------------------------------------- tasks

  async createTask(
    workItemId: string,
    title: string,
    kind: Task["kind"],
    risk: RiskLevel,
    actor: Actor,
    scopePaths: string[] = [],
    dependsOn: string[] = [],
  ): Promise<Task> {
    const task: Task = {
      id: newTaskId(),
      work_item_id: workItemId,
      title,
      kind,
      depends_on: dependsOn,
      status: "ready",
      scope_paths: scopePaths,
      risk,
      result_work_item_id: null,
    };
    await this.emit("task.created", workItemId, actor, { task });
    return task;
  }

  async setTaskStatus(id: string, status: Task["status"], workItemId: string, actor: Actor): Promise<void> {
    const type = status === "completed" ? "task.completed" : status === "blocked" ? "task.blocked" : "task.started";
    await this.emit(type, workItemId, actor, { task_id: id, status });
  }

  /**
   * Update task fields (e.g. depends_on resolved after ids are generated, or
   * link an executed task to its result work item). Emitted as a task.started
   * event so the change is durable and replayed.
   */
  async updateTask(
    id: string,
    changes: Partial<Pick<Task, "depends_on" | "scope_paths" | "result_work_item_id">>,
    workItemId: string,
    actor: Actor,
  ): Promise<void> {
    const t = this.tasks.get(id);
    if (!t) return;
    await this.emit("task.started", workItemId, actor, { task_id: id, ...changes });
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listTasks(workItemId: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.work_item_id === workItemId);
  }

  // ---------------------------------------------------------------- entities

  async recordEntity(
    kind: LedgerEntity["kind"],
    claim: string,
    status: EntityStatus,
    actor: Actor,
    workItemId: string | null,
    opts: {
      evidence?: string[];
      confidence?: number;
      severity?: LedgerEntity["severity"];
      candidateId?: string;
    } = {},
  ): Promise<LedgerEntity> {
    const entity: LedgerEntity = {
      id: newEntityId(kind === "test-obligation" ? "TESTOB" : kind),
      kind,
      claim,
      status,
      evidence: opts.evidence ?? [],
      confidence: opts.confidence,
      severity: opts.severity,
      candidate_id: opts.candidateId,
      work_item_id: workItemId ?? undefined,
      created_at: new Date().toISOString(),
    };
    const eventType = (
      kind === "finding"
        ? status === "resolved"
          ? "finding.resolved"
          : "finding.created"
        : kind === "hypothesis"
          ? status === "rejected"
            ? "hypothesis.rejected"
            : "hypothesis.created"
          : kind === "fact"
            ? "fact.verified"
            : kind === "decision"
              ? status === "accepted"
                ? "decision.accepted"
                : "decision.proposed"
              : `${kind}.created`
    ) as LedgerEvent["type"];
    await this.emit(eventType, workItemId, actor, { entity });
    return entity;
  }

  async updateEntityStatus(id: string, status: EntityStatus, workItemId: string | null, actor: Actor): Promise<void> {
    const e = this.entities.get(id);
    if (!e) return;
    // Update in place and emit a single in-place event so replay stays
    // consistent (no duplicate entity with a fresh id).
    const updated: LedgerEntity = { ...e, status, created_at: e.created_at };
    this.entities.set(id, updated);
    await this.emit("entity.updated", workItemId, actor, { entity: updated });
  }

  getEntity(id: string): LedgerEntity | undefined {
    return this.entities.get(id);
  }

  listEntities(kind?: LedgerEntity["kind"], workItemId?: string): LedgerEntity[] {
    let out = [...this.entities.values()];
    if (kind) out = out.filter((e) => e.kind === kind);
    if (workItemId) out = out.filter((e) => e.work_item_id === workItemId);
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listOpenFindings(): LedgerEntity[] {
    return this.listEntities("finding").filter((f) => f.status === "open");
  }

  // ---------------------------------------------------------------- evidence

  async recordEvidence(
    candidateId: string | null,
    type: string,
    tool: string,
    command: string | null,
    exitCode: number,
    status: Evidence["status"],
    summary: Record<string, unknown>,
    artifacts: string[],
    trust: Evidence["trust"],
    workItemId: string | null,
    actor: Actor,
  ): Promise<Evidence> {
    const now = new Date().toISOString();
    const ev: Evidence = {
      id: newEvidenceId(),
      candidate_id: candidateId,
      type,
      tool,
      command,
      started_at: now,
      finished_at: now,
      exit_code: exitCode,
      status,
      summary,
      artifacts,
      trust,
    };
    await this.emit("evidence.recorded", workItemId, actor, { evidence: ev });
    if (candidateId) {
      const c = this.candidates.get(candidateId);
      if (c) {
        c.evidence_ids = [...c.evidence_ids, ev.id];
        if (workItemId)
          await this.emit("candidate.changed", workItemId, actor, {
            candidate_id: candidateId,
            changes: { evidence_ids: c.evidence_ids },
          });
      }
    }
    return ev;
  }

  getEvidence(id: string): Evidence | undefined {
    return this.evidence.get(id);
  }

  listEvidence(candidateId?: string): Evidence[] {
    const all = [...this.evidence.values()];
    return candidateId ? all.filter((e) => e.candidate_id === candidateId) : all;
  }

  events(workItemId?: string): LedgerEvent[] {
    return workItemId ? this.store.byWorkItem(workItemId) : this.store.all();
  }

  count(): number {
    return this.store.count();
  }
}
