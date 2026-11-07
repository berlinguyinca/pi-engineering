/**
 * E05 — the durable sink for E02 error *occurrences*: a thin adapter over the EXISTING per-session event stream
 * (`SessionEventStore`). No new storage and no new format: an occurrence is a normal `StoredEvent` whose `type`
 * is `error.occurrence`, so a reader keeps occurrences apart from the deduplicated **incidents** of
 * `IncidentController` (`incident.detected`) sharing the namespace. It records THAT something failed, never
 * decides incident identity (it only carries `incidentFingerprint` for the incident layer to group by), and E04
 * gates every write. A session id is never taken from the occurrence (the envelope's is the store's) and scope
 * maps from the writer's scope, else the occurrence's own `runId`/`taskId`.
 */
import { createHash } from "node:crypto";
import { sanitizeForPersistence } from "../../incidents/errorSanitize.ts";
import { type ErrorOccurrence, parseErrorOccurrence } from "../../incidents/errorEvent.ts";
import { incidentFingerprint } from "../../incidents/fingerprint.ts";
import type { StoredEvent } from "../../platform/eventstore/backend.ts";
import { SessionEventStore } from "./SessionEventStore.ts";
export const ERROR_OCCURRENCE_EVENT_TYPE = "error.occurrence"; // distinct from every incident type: what keeps occurrences separable on read
/** Scope the writer cannot read off an occurrence (E02 has no project/worker field). A gap stays null. */
export interface SessionErrorWriterScope { projectId?: string | null; runId?: string | null; workerId?: string | null }
const canonical = (value: Record<string, unknown>): string => JSON.stringify(Object.keys(value).sort().map((k) => [k, value[k]])); // sorted keys → a digest that survives key-order churn
export class SessionErrorWriter {
  readonly store: SessionEventStore; readonly scope: Required<SessionErrorWriterScope>;
  constructor(store: SessionEventStore, scope: SessionErrorWriterScope = {}) { this.store = store; this.scope = { projectId: scope.projectId ?? null, runId: scope.runId ?? null, workerId: scope.workerId ?? null }; }
  private project(occ: ErrorOccurrence): StoredEvent { // one sanitized occurrence, projected into the event its stream will hold
    // an occurrence has no repo/command/worktree: scope gives the project, layer stands in for the operation
    const payload: Record<string, unknown> = { ...occ, fingerprint: incidentFingerprint({ repo: this.scope.projectId ?? "", failure_class: occ.code, command: occ.layer, root_cause: occ.summary, worktree: this.store.worktreeId }) };
    const [projectId, runId, workerId] = [this.scope.projectId, this.scope.runId ?? occ.runId, this.scope.workerId ?? occ.taskId];
    const digest = createHash("sha256").update(`${this.store.sessionId}\u0000${canonical(payload)}\u0000${canonical({ projectId, runId, workerId })}`).digest("hex").slice(0, 40); // the stream's session id enters the digest: two sessions recording one failure keep two occurrences (grouping is the fingerprint's job) while a retry inside one stream can produce no second
    return { event_id: `err-${digest}`, timestamp: occ.timestamp, type: ERROR_OCCURRENCE_EVENT_TYPE, project_id: projectId, run_id: runId, worker_id: workerId, payload };
  }
  /** Sanitize (E04) then append and return the stored event — or `null` when E04 refuses the input (nothing
   * attributable): the documented failure mode, which writes nothing and throws nothing. Guard, commit and
   * materialization share the store's one non-yielding section, so a retried `record()` lands no second line. */
  async record(input: unknown): Promise<StoredEvent | null> {
    const sanitized = sanitizeForPersistence(input); if (!sanitized) return null; // E04 is the last pass before a durable sink
    const event = this.project(sanitized);
    const written = await this.store.appendConditionally(event, () => this.store.get(event.event_id) === undefined);
    return written ?? this.store.get(event.event_id) ?? null;
  }
  /** Sequential drain of `record`, so every event gets its own idempotency guard (`appendAll` offers none). */
  async recordMany(inputs: readonly unknown[]): Promise<(StoredEvent | null)[]> { const out: (StoredEvent | null)[] = []; for (const input of inputs) out.push(await this.record(input)); return out; }
  /** Every surviving occurrence in the namespace, in the store's merged order (not only this session's). */
  listOccurrences(): ErrorOccurrence[] {
    this.store.refresh(); // occurrences other sessions appended since this session last read
    const out: ErrorOccurrence[] = []; // incident events are IncidentController's, and a payload E02 no longer admits is not an occurrence: skip both, never repair
    for (const event of this.store.all()) if (event.type === ERROR_OCCURRENCE_EVENT_TYPE) { const parsed = parseErrorOccurrence(event.payload); if (parsed.ok) out.push(parsed.event); }
    return out;
  }
}
/** Bind an error writer to an open per-session stream; the session id stays the store's, never invented here. */
export function createSessionErrorWriter(store: SessionEventStore, scope: SessionErrorWriterScope = {}): SessionErrorWriter { return new SessionErrorWriter(store, scope); }
