/**
 * Ledger feeder — the panel's view of an engineering run.
 *
 * A read model over what the ledger already records: the work item, its latest
 * candidate's changed files, the review findings against it, and per-model
 * spend. Nothing here writes to the ledger.
 *
 * Attribution ("who reviewed, which model") deliberately reads the ledger
 * EVENTS rather than the entities: `LedgerEntity` carries no actor — the
 * reviewing role and model live on the event that recorded it.
 */

import type { Actor, LedgerEntity } from "../../core/types.ts";
import type { Ledger } from "../../ledger/Ledger.ts";
import type { RuntimePhaseEvent } from "../../runtime/EngineeringRuntime.ts";
import type { PanelFinding, PanelSpend, PanelState } from "../PanelState.ts";

export interface LedgerFeederOptions {
  ledger: Ledger;
  state: PanelState;
}

export class LedgerFeeder {
  private readonly ledger: Ledger;
  private readonly state: PanelState;
  /** Spend accumulates in memory: per-model usage is not persisted anywhere. */
  private spendByModel = new Map<string, PanelSpend>();
  private activeWorkItemId = "";

  constructor(opts: LedgerFeederOptions) {
    this.ledger = opts.ledger;
    this.state = opts.state;
  }

  /**
   * Consume a pipeline phase event and republish the run view.
   *
   * Every read is wrapped: a malformed or unreadable ledger marks the run
   * section and leaves the rest of the panel working, rather than throwing
   * into Pi's render loop.
   */
  onPhase(event: RuntimePhaseEvent): void {
    try {
      if (event.phase === "settled") {
        // Parallel tournament legs and DAG waves each settle, so only the run
        // actually on display may clear it.
        if (event.workItemId === this.activeWorkItemId) this.clear();
        return;
      }

      if (event.workItemId !== this.activeWorkItemId) {
        this.activeWorkItemId = event.workItemId;
        this.spendByModel = new Map();
      }

      if (event.model && event.usage) this.accumulate(event.model, event.usage);

      this.publish(event);
      this.state.clearError("run");
    } catch (err) {
      this.state.noteError("run", err instanceof Error ? err.message : String(err));
    }
  }

  /** Rebuild the current run view from the ledger (e.g. when the panel opens). */
  refresh(): void {
    if (!this.activeWorkItemId) return;
    try {
      this.publish({ workItemId: this.activeWorkItemId, phase: this.state.snapshot.run?.phase ?? "running" });
      this.state.clearError("run");
    } catch (err) {
      this.state.noteError("run", err instanceof Error ? err.message : String(err));
    }
  }

  private clear(): void {
    this.activeWorkItemId = "";
    this.spendByModel = new Map();
    this.state.set({ run: undefined });
  }

  private accumulate(model: string, usage: { input: number; output: number; cost: number }): void {
    const current = this.spendByModel.get(model) ?? { model, input: 0, output: 0, cost: 0 };
    this.spendByModel.set(model, {
      model,
      input: current.input + usage.input,
      output: current.output + usage.output,
      cost: current.cost + usage.cost,
    });
  }

  private publish(event: { workItemId: string; phase: string; goal?: string }): void {
    const workItem = this.ledger.getWorkItem(event.workItemId);
    // A phase for a work item this ledger does not know is not renderable —
    // publishing a placeholder would be inventing state.
    if (!workItem) return;

    const candidates = this.ledger.listCandidates(event.workItemId);
    const candidate = candidates.at(-1);
    const attribution = this.attributionByEntity(event.workItemId);
    const findings = this.ledger
      .listEntities("finding", event.workItemId)
      .map((entity) => toFinding(entity, attribution.get(entity.id)));

    this.state.set({
      run: {
        workItemId: workItem.id,
        goal: event.goal ?? workItem.goal,
        phase: event.phase,
        risk: workItem.risk,
        ...(candidate ? { candidateId: candidate.id } : {}),
        // "changed", not "modified": `changed_files` is a list of PATHS
        // (core/types.ts), so the ledger never recorded what happened to them.
        // Labelling them modified put a fact on screen that nothing had
        // observed — found by a fresh-context review of the read model.
        files: (candidate?.changed_files ?? []).map((path) => ({ path, change: "changed" as const })),
        findings,
        spend: [...this.spendByModel.values()],
      },
      updatedAt: Date.now(),
    });
  }

  /**
   * entity id -> the actor that recorded it.
   *
   * Findings are emitted as `finding.created` / `finding.resolved` carrying
   * `payload.entity`; a later `entity.updated` overwrites with the most recent
   * actor, which is the one the panel should show.
   */
  private attributionByEntity(workItemId: string): Map<string, Actor> {
    const map = new Map<string, Actor>();
    for (const event of this.ledger.events(workItemId)) {
      const entity = (event.payload as { entity?: { id?: string } } | undefined)?.entity;
      if (entity?.id) map.set(entity.id, event.actor);
    }
    return map;
  }
}

function toFinding(entity: LedgerEntity, actor: Actor | undefined): PanelFinding {
  return {
    id: entity.id,
    severity: entity.severity ?? "info",
    claim: entity.claim,
    status: entity.status,
    ...(actor?.role ? { role: actor.role } : {}),
    ...(actor?.model ? { model: actor.model } : {}),
    ...(entity.candidate_id ? { candidateId: entity.candidate_id } : {}),
  };
}
