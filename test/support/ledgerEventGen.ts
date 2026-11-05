/**
 * Seeded, synthetic-but-realistic Ledger event streams for projection tests and benchmarks.
 * Mix per work item: created, plan tasks (+ lifecycle), a candidate, evidence rows, status
 * updates, and agent runs (started, many heartbeats, completed/failed or left running).
 * Events are plain `LedgerEvent`s so `Ledger.fromEvents` or a JSONL file can ingest them.
 */
import type { LedgerEvent, WorkItem, WorkItemStatus } from "../../src/core/types.ts";

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES: WorkItemStatus[] = ["PLANNING", "READY", "EXECUTING", "VERIFYING", "COMPLETED", "BLOCKED"];

export interface GenOptions {
  /** Approximate number of events to emit (the stream stops at the first work item boundary at or past it). */
  events: number;
  seed: number;
  /** Epoch ms of the first event; timestamps advance monotonically from here. */
  startMs?: number;
}

export function generateEvents(opts: GenOptions): LedgerEvent[] {
  const rand = rng(opts.seed);
  const out: LedgerEvent[] = [];
  let clock = opts.startMs ?? Date.parse("2026-01-01T00:00:00Z");
  let seq = 0;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const emit = (
    type: LedgerEvent["type"],
    workItemId: string | null,
    payload: Record<string, unknown>,
    meta: Partial<LedgerEvent> = {},
  ): void => {
    clock += 1 + Math.floor(rand() * 2000);
    out.push({
      event_id: `EVT-${opts.seed}-${seq++}`,
      work_item_id: workItemId,
      timestamp: new Date(clock).toISOString(),
      actor: { type: "agent", role: "implementer", model: "m1", ...(meta.run_id ? { run_id: meta.run_id } : {}) },
      type,
      payload,
      ...meta,
    });
  };
  let n = 0;
  while (out.length < opts.events) {
    const id = `WI-${opts.seed}-${n++}`;
    const nowIso = new Date(clock).toISOString();
    const wi: WorkItem = {
      id,
      goal: `goal ${id}`,
      status: "DEFINED",
      risk: "low",
      repositories: ["r"],
      created_at: nowIso,
      updated_at: nowIso,
      current_candidate_id: null,
      incumbent_candidate_id: null,
    };
    emit("work_item.created", id, { workItem: wi });
    const taskCount = 1 + Math.floor(rand() * 4);
    for (let t = 0; t < taskCount; t++) {
      const tid = `${id}-T${t}`;
      emit("task.created", id, {
        task: {
          id: tid,
          work_item_id: id,
          title: `task ${t}`,
          kind: "implement",
          depends_on: [],
          status: "ready",
          scope_paths: [],
          risk: "low",
          result_work_item_id: rand() < 0.3 ? id : null,
        },
      });
      if (rand() < 0.7) emit("task.started", id, { task_id: tid, status: "started" });
      if (rand() < 0.5)
        emit(pick(["task.completed", "task.blocked"] as const), id, { task_id: tid, status: "completed" });
    }
    const cid = `CAND-${id}`;
    const head = `c${n}`;
    emit("candidate.created", id, {
      candidate: {
        id: cid,
        work_item_id: id,
        parent_id: null,
        status: "CREATED",
        base_commit: "b",
        branch: "x",
        worktree_path: null,
        producer_run_id: "p",
        producer_role: "implementer",
        diff: null,
        diff_artifact_uri: null,
        changed_files: [],
        evidence_ids: [],
        rejection_reason: null,
        created_at: nowIso,
        head_commit: head,
      },
    });
    emit("work_item.updated", id, { current_candidate_id: cid });
    // Agent runs: some finish, some fail, some are left running (so liveness derivation matters).
    const runCount = 1 + Math.floor(rand() * 3);
    for (let r = 0; r < runCount; r++) {
      const run = `RUN-${id}-${r}`;
      const meta = { run_id: run, task_id: id, session_id: `S-${n % 17}` };
      emit("agent.started", id, {}, meta);
      const beats = Math.floor(rand() * 40);
      for (let b = 0; b < beats; b++) {
        emit(
          "agent.heartbeat",
          id,
          { last_progress_at: new Date(clock).toISOString(), phase: rand() < 0.1 ? "waiting" : null },
          meta,
        );
        if (rand() < 0.1) emit("evidence.recorded", id, evidencePayload(id, cid, `${run}-b${b}`, head, rand), meta);
      }
      const end = rand();
      if (end < 0.6) emit("agent.completed", id, {}, meta);
      else if (end < 0.75) emit("agent.failed", id, {}, meta);
    }
    const evCount = Math.floor(rand() * 4);
    for (let e = 0; e < evCount; e++)
      emit("evidence.recorded", id, evidencePayload(id, cid, `${id}-E${e}`, rand() < 0.9 ? head : "stale", rand));
    emit("work_item.updated", id, { status: pick(STATUSES) });
  }
  return out;
}

function evidencePayload(
  _wi: string,
  candidateId: string,
  evId: string,
  head: string,
  rand: () => number,
): Record<string, unknown> {
  return {
    evidence: {
      id: `EVID-${evId}`,
      candidate_id: candidateId,
      type: rand() < 0.5 ? "verify.test" : "verify.lint",
      tool: "t",
      command: null,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:01Z",
      exit_code: 0,
      status: rand() < 0.85 ? "passed" : "failed",
      summary: { head_commit: head, required_stages: ["test"] },
      artifacts: [],
      trust: "deterministic",
    },
  };
}
