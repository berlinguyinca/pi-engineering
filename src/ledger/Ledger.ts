import { newCandidateId, newEntityId, newEventId, newEvidenceId, newTaskId, newWorkItemId } from "../core/ids.ts";
import type {
  Actor,
  Candidate,
  CandidateStatus,
  EntityStatus,
  EventMeta,
  Evidence,
  LedgerEntity,
  LedgerEvent,
  RiskLevel,
  Task,
  WorkItem,
  WorkItemPrLink,
  WorkItemStatus,
  WorkerRole,
} from "../core/types.ts";
import { EventStore } from "./EventStore.ts";
import { LedgerAuthorityStaleError, LedgerRevisionConflictError } from "./errors.ts";
import type { FileLockOptions } from "./fileLock.ts";

export { LedgerAuthorityStaleError, LedgerRevisionConflictError } from "./errors.ts";
export { LedgerLockTimeoutError } from "./fileLock.ts";

/**
 * Append preconditions. `expected_revision` is the number of events the log
 * holds for the event's work item (null work item: the events with none), as
 * returned by `Ledger.revision()`; it is checked under the cross-process lock,
 * so a writer that read a stale revision is rejected and nothing is written.
 * (A fence on the writer's authority is `EventMeta.authority_generation`.)
 */
export interface AppendGuard {
  expected_revision?: number;
}

/**
 * Optional fencing for the typed helper methods (`createCandidate`, `promoteCandidate`, ...), the same two controls
 * `emitEvent` takes: `guard.expected_revision`, and `authority_generation` (stamped on every event the helper writes).
 * Absent = unfenced, exactly as before. A multi-event helper checks them ONCE, up front, under the lock.
 */
export interface LedgerWriteOptions {
  guard?: AppendGuard;
  authority_generation?: number;
}

/**
 * The Engineering Ledger (spec §9): durable, event-sourced shared memory.
 *
 * Immutable events are appended to an EventStore; a materialized in-memory view
 * is maintained for fast queries. The ledger is the authoritative representation
 * of requirements, facts, hypotheses, decisions, findings, tasks, candidates,
 * evidence, and promotions. It survives crashes by replaying events.
 */
function prLinkOf(p: Record<string, unknown>): WorkItemPrLink | undefined {
  const { host, owner, repo, number, url_canonical } = p;
  if (typeof host !== "string" || typeof owner !== "string" || typeof repo !== "string") return undefined;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return undefined;
  if (!host || !owner || !repo) return undefined;
  return {
    host,
    owner,
    repo,
    number,
    url_canonical:
      typeof url_canonical === "string" ? url_canonical : `https://${host}/${owner}/${repo}/pull/${number}`,
  };
}

const samePr = (a: WorkItemPrLink, b: WorkItemPrLink): boolean =>
  a.number === b.number &&
  a.host.toLowerCase() === b.host.toLowerCase() &&
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.repo.toLowerCase() === b.repo.toLowerCase();

export class Ledger {
  private readonly store: EventStore;

  private workItems = new Map<string, WorkItem>();
  private candidates = new Map<string, Candidate>();
  private tasks = new Map<string, Task>();
  private entities = new Map<string, LedgerEntity>();
  private evidence = new Map<string, Evidence>();
  /** Events by idempotency key; rebuilt on replay, so a restart keeps deduplicating. */
  private byIdempotencyKey = new Map<string, LedgerEvent>();
  /** Events per work item (key "" = none); the fence `expected_revision` compares against. */
  private revisions = new Map<string, number>();
  /** Highest `authority_generation` recorded per work item; lower generations are fenced off. */
  private authorities = new Map<string, number>();
  /** PRs linked to a work item by `work_item.pr_linked`, in first-seen order and de-duplicated by PR. */
  private prLinks = new Map<string, WorkItemPrLink[]>();

  private constructor(store: EventStore) {
    this.store = store;
  }

  static async create(eventFile: string, options: { lock?: FileLockOptions } = {}): Promise<Ledger> {
    const store = await EventStore.create(eventFile, { lock: options.lock });
    const ledger = new Ledger(store);
    // Rebuild materialized state from events (INV-012, AC-011).
    for (const evt of store.all()) ledger.ingest(evt);
    // Events another process appends are folded in under the append lock, before any fence is judged.
    store.setExternalHandler((evt) => ledger.ingest(evt));
    return ledger;
  }

  /** Reconstruct a ledger directly from an in-memory event list (for tests). */
  static fromEvents(events: LedgerEvent[]): Ledger {
    const ledger = new Ledger(EventStore.inMemory());
    for (const evt of events) ledger.ingest(evt);
    return ledger;
  }

  /** Materialize an event that is already in the log. */
  private ingest(event: LedgerEvent): void {
    this.apply(event);
    this.track(event);
  }

  private track(event: LedgerEvent): void {
    const scope = event.work_item_id ?? "";
    this.revisions.set(scope, (this.revisions.get(scope) ?? 0) + 1);
    if (event.authority_generation !== undefined) {
      this.authorities.set(scope, Math.max(this.authorities.get(scope) ?? 0, event.authority_generation));
    }
  }

  /** Current revision of a work item's slice of the log (what `expected_revision` is checked against). */
  revision(workItemId: string | null = null): number {
    return this.revisions.get(workItemId ?? "") ?? 0;
  }

  /** Highest `authority_generation` recorded anywhere in the log (0 when none): a floor for a new owner's generation. */
  highestAuthorityGeneration(): number {
    let max = 0;
    for (const g of this.authorities.values()) max = Math.max(max, g);
    return max;
  }

  /** Throws when `event` is fenced off. Runs under the append lock, after catching up with other writers. */
  private assertFences(event: LedgerEvent, guard: AppendGuard | undefined): void {
    const scope = event.work_item_id ?? "";
    if (guard?.expected_revision !== undefined && guard.expected_revision !== this.revision(event.work_item_id)) {
      throw new LedgerRevisionConflictError(
        event.work_item_id,
        guard.expected_revision,
        this.revision(event.work_item_id),
      );
    }
    const generation = event.authority_generation;
    const current = this.authorities.get(scope);
    if (generation !== undefined && current !== undefined && generation < current) {
      throw new LedgerAuthorityStaleError(event.work_item_id, generation, current);
    }
  }

  // ------------------------------------------------------------------ events

  /**
   * Public passthrough for emitting an arbitrary ledger event (used by
   * optional adapters such as Blackhole so their lifecycle transitions are
   * recorded in the authoritative EventStore). The EventStore remains the
   * system of record; this only appends to it.
   */
  async emitEvent(
    type: LedgerEvent["type"],
    workItemId: string | null,
    actor: Actor,
    payload: Record<string, unknown>,
    meta?: EventMeta,
    guard?: AppendGuard,
  ): Promise<LedgerEvent> {
    return this.emit(type, workItemId, actor, payload, meta, guard);
  }

  private makeEvent(
    type: LedgerEvent["type"],
    workItemId: string | null,
    actor: Actor,
    payload: Record<string, unknown>,
    meta?: EventMeta,
  ): LedgerEvent {
    const event: LedgerEvent = {
      event_id: newEventId(),
      work_item_id: workItemId,
      timestamp: new Date().toISOString(),
      actor,
      type,
      payload,
    };
    const defined = meta ? Object.entries(meta).filter(([, v]) => v !== undefined && v !== "") : [];
    if (defined.length > 0) {
      event.schema_version = 2;
      Object.assign(event, Object.fromEntries(defined));
    }
    return event;
  }

  private emitWith(
    type: LedgerEvent["type"],
    workItemId: string | null,
    actor: Actor,
    payload: Record<string, unknown>,
    write?: LedgerWriteOptions,
  ): Promise<LedgerEvent> {
    return this.emit(
      type,
      workItemId,
      actor,
      payload,
      write?.authority_generation !== undefined ? { authority_generation: write.authority_generation } : undefined,
      write?.guard,
    );
  }

  /**
   * Several events as one atomic unit: one lock acquisition, fences checked once before anything is written, and then
   * every event appended in order or none. `build` runs under the lock after catching up with other processes, so
   * payloads that depend on current state see the true tail of the log.
   */
  private async emitBatch(
    actor: Actor,
    write: LedgerWriteOptions | undefined,
    build: () => Array<{ type: LedgerEvent["type"]; workItemId: string | null; payload: Record<string, unknown> }>,
  ): Promise<LedgerEvent[]> {
    const meta: EventMeta | undefined =
      write?.authority_generation !== undefined ? { authority_generation: write.authority_generation } : undefined;
    const stored = await this.store.appendBatch(
      () => {
        const specs = build();
        const events = specs.map((s) => this.makeEvent(s.type, s.workItemId, actor, s.payload, meta));
        const first = events[0];
        if (!first) return undefined;
        if (events.some((e) => e.work_item_id !== first.work_item_id))
          throw new Error("a multi-event ledger write must stay inside one work item");
        this.assertFences(first, write?.guard);
        return events;
      },
      (events) => {
        for (const e of events) this.track(e);
      },
    );
    for (const e of stored ?? []) this.apply(e);
    return stored ?? [];
  }

  private async emit(
    type: LedgerEvent["type"],
    workItemId: string | null,
    actor: Actor,
    payload: Record<string, unknown>,
    meta?: EventMeta,
    guard?: AppendGuard,
  ): Promise<LedgerEvent> {
    const event = this.makeEvent(type, workItemId, actor, payload, meta);
    const key = event.idempotency_key;
    if (key) {
      const prior = this.byIdempotencyKey.get(key);
      if (prior) return this.sameRequest(prior, event);
    }
    // The conditions and the index updates all run inside the store's append
    // chain and under the file lock, so neither two appends with one key nor a
    // stale writer can commit. A replayed key is answered before any fence.
    const stored = await this.store.appendConditionally(
      event,
      () => {
        if (key && this.byIdempotencyKey.has(key)) return false;
        this.assertFences(event, guard);
        return true;
      },
      () => {
        if (key) this.byIdempotencyKey.set(key, event);
        this.track(event);
      },
    );
    if (!stored) return this.sameRequest(this.byIdempotencyKey.get(key as string) as LedgerEvent, event);
    this.apply(event);
    return stored;
  }

  /**
   * A key names one request. Answering a different request with the first
   * one's event would silently drop a write, so a mismatch is an error.
   */
  private sameRequest(prior: LedgerEvent, wanted: LedgerEvent): LedgerEvent {
    if (prior.type !== wanted.type || prior.work_item_id !== wanted.work_item_id) {
      throw new Error(
        `idempotency key ${wanted.idempotency_key} already recorded ${prior.type} for ${prior.work_item_id}; refusing ${wanted.type} for ${wanted.work_item_id}`,
      );
    }
    return prior;
  }

  private apply(event: LedgerEvent): void {
    if (event.idempotency_key && !this.byIdempotencyKey.has(event.idempotency_key)) {
      this.byIdempotencyKey.set(event.idempotency_key, event);
    }
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
      case "work_item.pr_linked": {
        const link = prLinkOf(p);
        const id = event.work_item_id;
        if (link && id) {
          const list = this.prLinks.get(id) ?? [];
          if (!list.some((l) => samePr(l, link))) this.prLinks.set(id, [...list, link]);
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
      case "task.blocked":
      case "task.failed":
      case "task.updated": {
        const t = this.tasks.get(p.task_id as string);
        if (t) {
          if (typeof p.status === "string") {
            t.status = p.status as Task["status"];
            t.blocked_reason = event.type === "task.blocked" && typeof p.reason === "string" ? p.reason : null;
          }
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

  async createWorkItem(
    goal: string,
    risk: RiskLevel,
    repositories: string[],
    actor: Actor,
    write?: LedgerWriteOptions,
  ): Promise<WorkItem> {
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
    await this.emitWith("work_item.created", wi.id, actor, { workItem: wi }, write);
    return wi;
  }

  async updateWorkItem(
    id: string,
    changes: Partial<WorkItem>,
    actor: Actor,
    write?: LedgerWriteOptions,
  ): Promise<void> {
    await this.emitWith("work_item.updated", id, actor, changes as Record<string, unknown>, write);
  }

  /**
   * Record that `workItemId` produced or was handed this pull request. Idempotent: a PR already linked writes
   * nothing. Additive: it changes no WorkItem field, so projections of work state are unaffected.
   */
  async recordPrLink(
    workItemId: string,
    link: Pick<WorkItemPrLink, "host" | "owner" | "repo" | "number">,
    actor: Actor,
    write?: LedgerWriteOptions,
  ): Promise<boolean> {
    const full = prLinkOf({
      ...link,
      url_canonical: `https://${link.host}/${link.owner}/${link.repo}/pull/${link.number}`,
    });
    if (!full || !this.workItems.has(workItemId)) return false;
    if (this.listPrLinks(workItemId).some((l) => samePr(l, full))) return false;
    await this.emitWith("work_item.pr_linked", workItemId, actor, { ...full }, write);
    return true;
  }

  listPrLinks(workItemId: string): WorkItemPrLink[] {
    return [...(this.prLinks.get(workItemId) ?? [])];
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
    write?: LedgerWriteOptions,
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
    await this.emitBatch(actor, write, () => [
      { type: "candidate.created", workItemId, payload: { candidate } },
      { type: "work_item.updated", workItemId, payload: { current_candidate_id: candidate.id } },
    ]);
    return candidate;
  }

  async changeCandidate(
    id: string,
    changes: Partial<Candidate>,
    workItemId: string,
    actor: Actor,
    write?: LedgerWriteOptions,
  ): Promise<void> {
    await this.emitWith("candidate.changed", workItemId, actor, { candidate_id: id, changes }, write);
  }

  async rejectCandidate(
    id: string,
    workItemId: string,
    reason: string,
    actor: Actor,
    write?: LedgerWriteOptions,
  ): Promise<void> {
    await this.emitWith("candidate.rejected", workItemId, actor, { candidate_id: id, reason }, write);
  }

  async promoteCandidate(id: string, workItemId: string, actor: Actor, write?: LedgerWriteOptions): Promise<void> {
    await this.emitBatch(actor, write, () => [
      { type: "candidate.promoted", workItemId, payload: { candidate_id: id } },
      { type: "work_item.updated", workItemId, payload: { incumbent_candidate_id: id } },
    ]);
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
    write?: LedgerWriteOptions,
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
    await this.emitWith("task.created", workItemId, actor, { task }, write);
    return task;
  }

  async setTaskStatus(
    id: string,
    status: Task["status"],
    workItemId: string,
    actor: Actor,
    write?: LedgerWriteOptions,
  ): Promise<void> {
    const type =
      status === "completed"
        ? "task.completed"
        : status === "blocked"
          ? "task.blocked"
          : status === "failed"
            ? "task.failed"
            : "task.started";
    await this.emitWith(type, workItemId, actor, { task_id: id, status }, write);
  }

  /**
   * Update task fields (e.g. depends_on resolved after ids are generated, or
   * link an executed task to its result work item). Emitted as a task.updated
   * event so the audit log does not misrepresent field updates as task starts.
   */
  async updateTask(
    id: string,
    changes: Partial<Pick<Task, "depends_on" | "scope_paths" | "result_work_item_id">>,
    workItemId: string,
    actor: Actor,
    write?: LedgerWriteOptions,
  ): Promise<void> {
    const t = this.tasks.get(id);
    if (!t) return;
    await this.emitWith("task.updated", workItemId, actor, { task_id: id, ...changes }, write);
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
    write?: LedgerWriteOptions,
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
    await this.emitWith(eventType, workItemId, actor, { entity }, write);
    return entity;
  }

  async updateEntityStatus(
    id: string,
    status: EntityStatus,
    workItemId: string | null,
    actor: Actor,
    write?: LedgerWriteOptions,
  ): Promise<void> {
    const e = this.entities.get(id);
    if (!e) return;
    // One in-place event so replay stays consistent (no duplicate entity with a fresh id). The in-memory entity is
    // replaced by apply() once the event is durable, so a fenced (rejected) write leaves no phantom update behind.
    const updated: LedgerEntity = { ...e, status, created_at: e.created_at };
    await this.emitWith("entity.updated", workItemId, actor, { entity: updated }, write);
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
    write?: LedgerWriteOptions,
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
    await this.emitBatch(actor, write, () => {
      const specs: Array<{ type: LedgerEvent["type"]; workItemId: string | null; payload: Record<string, unknown> }> = [
        { type: "evidence.recorded", workItemId, payload: { evidence: ev } },
      ];
      // Built under the lock, so the candidate's evidence list is the current one, not a stale replay.
      const c = candidateId ? this.candidates.get(candidateId) : undefined;
      if (c && workItemId)
        specs.push({
          type: "candidate.changed",
          workItemId,
          payload: { candidate_id: candidateId, changes: { evidence_ids: [...c.evidence_ids, ev.id] } },
        });
      return specs;
    });
    if (!workItemId && candidateId) {
      const c = this.candidates.get(candidateId);
      if (c) c.evidence_ids = [...c.evidence_ids, ev.id]; // unchanged legacy behaviour: no work item, so memory only
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
