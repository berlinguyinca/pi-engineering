/** Bounded public activity for planner/worker missions; model text never enters this view. */
import { stripVTControlCharacters } from "node:util";
import { redactSecrets } from "../security/SecurityPolicy.ts";
import type { WorkerActivity } from "../workers/WorkerExecutor.ts";
import {
  TOOL_PROGRESS_SUMMARY,
  WAITING_FOR_INFERENCE_SUMMARY,
  safeWorkerOutputPreview,
  sanitizeWorkerActivity,
} from "../workers/activity.ts";
import type { PlannerWorkerEvent } from "./executor.ts";

export function safeActivityText(value: string, max = 200): string {
  return redactSecrets(stripVTControlCharacters(value))
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export interface PlannerWorkerActivity {
  id: string;
  task_id: string;
  role: string;
  model: string;
  backing?: string;
  status: "running" | "waiting" | "completed" | "failed" | "stalled";
  summary: string;
  started_at: number;
  action_started_at: number;
  last_event_at: number;
  last_heartbeat_at: number | null;
  last_output_at: number | null;
  last_output_preview?: string;
  last_progress_at: number | null;
  ended_at: number | null;
  inactivity_ms: number;
  retry_at?: number;
  recent: Array<{ at: number; text: string }>;
}

export class PlannerActivity {
  private readonly workers = new Map<string, PlannerWorkerActivity>();
  private serial = 0;

  start(
    task: string,
    role: string,
    model: { provider: string; id: string } | undefined,
    backing: string | undefined,
    inactivityMs: number,
    now = Date.now(),
  ): string {
    const id = `${task}:${role}:${++this.serial}`;
    this.workers.set(id, {
      id,
      task_id: safeActivityText(task),
      role: safeActivityText(role),
      model: model ? safeActivityText(`${model.provider}/${model.id}`) : "session default",
      ...(backing ? { backing: safeActivityText(backing) } : {}),
      status: "running",
      summary: "Waiting for worker activity",
      started_at: now,
      action_started_at: now,
      last_event_at: now,
      last_heartbeat_at: null,
      last_output_at: null,
      last_progress_at: null,
      ended_at: null,
      inactivity_ms: inactivityMs,
      recent: [],
    });
    // Keep active workers plus a bounded tail of finished attempts.
    const finished = [...this.workers.values()].filter((w) => w.ended_at !== null);
    for (const old of finished.slice(0, Math.max(0, finished.length - 31))) this.workers.delete(old.id);
    return id;
  }

  note(id: string, input: WorkerActivity, now = Date.now()): void {
    const worker = this.workers.get(id);
    const event = sanitizeWorkerActivity(input);
    if (!worker || !event || worker.ended_at !== null) return;
    if (event.kind === "heartbeat") {
      worker.last_heartbeat_at = now;
      return;
    }
    worker.last_event_at = now;
    if (event.meaningfulProgress) worker.last_progress_at = now;
    if (
      event.summary === "Model response received" ||
      event.summary === "Model streaming" ||
      event.summary === TOOL_PROGRESS_SUMMARY
    )
      worker.last_output_at = now;
    if (event.outputPreview) {
      worker.last_output_at = now;
      worker.last_output_preview = event.outputPreview;
    }
    // A stream/output update does not restart the current tool's elapsed timer.
    if (event.summary !== TOOL_PROGRESS_SUMMARY && event.summary !== worker.summary) {
      worker.summary = safeActivityText(event.summary);
      worker.action_started_at = now;
    }
    worker.status = event.summary === WAITING_FOR_INFERENCE_SUMMARY ? "waiting" : "running";
    worker.recent.push({ at: now, text: safeActivityText(event.summary) });
    worker.recent = worker.recent.slice(-12);
  }

  describe(id: string, text: string, now = Date.now(), retryAt?: number): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.summary = safeActivityText(text);
    worker.action_started_at = now;
    worker.last_event_at = now;
    worker.retry_at = retryAt;
    if (retryAt !== undefined) worker.status = "waiting";
    worker.recent.push({ at: now, text: worker.summary });
    worker.recent = worker.recent.slice(-12);
  }

  output(id: string, now = Date.now()): void {
    const worker = this.workers.get(id);
    if (worker) worker.last_output_at = worker.last_event_at = now;
  }

  /** Verification tails arrive at completion; keep the timestamp of its real output event. */
  setOutputPreview(id: string, text: string): void {
    const worker = this.workers.get(id);
    const preview = safeWorkerOutputPreview(text);
    if (worker && worker.last_output_at !== null && preview) worker.last_output_preview = preview;
  }

  stall(id: string, reason: string, now = Date.now()): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.summary = safeActivityText(reason);
    worker.status = "stalled";
    worker.recent.push({ at: now, text: worker.summary });
    worker.recent = worker.recent.slice(-12);
  }

  finish(id: string, status: "completed" | "failed", now = Date.now()): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    if (worker.status !== "stalled") worker.status = status;
    worker.ended_at = now;
  }

  snapshot(): PlannerWorkerActivity[] {
    return structuredClone([...this.workers.values()]);
  }
}

function age(now: number, then: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function renderActivity(worker: PlannerWorkerActivity, now = Date.now()): string {
  const at = worker.ended_at ?? now;
  const deadline = worker.status === "running" ? ` · silence limit ${age(worker.inactivity_ms, 0)}` : "";
  return `${worker.task_id} · ${worker.role} · ${worker.model}${worker.backing ? ` → ${worker.backing}` : ""} · ${worker.status.toUpperCase()}\n  ${worker.summary} · ${age(at, worker.action_started_at)} · elapsed ${age(at, worker.started_at)}${worker.retry_at !== undefined && worker.ended_at === null ? ` · retry in ${age(worker.retry_at, now)}` : ""}\n  last event ${age(at, worker.last_event_at)} ago · output ${worker.last_output_at === null ? "not observed" : `${age(at, worker.last_output_at)} ago`} · progress ${worker.last_progress_at === null ? "not recorded" : `${age(at, worker.last_progress_at)} ago`}${worker.last_heartbeat_at === null ? "" : ` · heartbeat ${age(at, worker.last_heartbeat_at)} ago`}${deadline}`;
}

export interface PlannerLiveSnapshot {
  status: string;
  passed: number;
  total: number;
  activity: PlannerWorkerActivity[];
}

export function startPlannerDisplay(
  ui: {
    setWidget?: (key: string, lines: string[] | undefined) => void;
    setStatus?: (key: string, text: string | undefined) => void;
    notify: (text: string, level: "warning") => void;
  },
  missionId: string,
  snapshot: () => PlannerLiveSnapshot,
): { event: (event: PlannerWorkerEvent) => void; stop: () => void } {
  const key = `planner-worker-${missionId}`;
  let phase = "starting";
  const notified = new Set<string>();
  const render = () => {
    try {
      const state = snapshot();
      const active = state.activity.filter((w) => w.ended_at === null);
      const workers = active.length ? active : state.activity.slice(-1);
      const progress = state.total
        ? `${state.passed}/${state.total} contracts verified (${Math.floor((state.passed / state.total) * 100)}%)`
        : "planning · total not known";
      const headline = `Mission ${missionId} [${state.status}] · ${progress}`;
      ui.setWidget?.(key, [
        headline,
        `Now: ${phase}`,
        ...workers.flatMap((worker) => renderActivity(worker).split("\n")),
        "Inspect: /engineering-workers [task] · /engineering-status",
      ]);
      ui.setStatus?.(
        key,
        `${headline} · ${workers[0] ? `${workers[0].summary} · ${age(Date.now(), workers[0].action_started_at)}` : phase}`,
      );
    } catch {
      /* UI observers never interrupt execution. */
    }
  };
  render();
  const timer = setInterval(render, 1000);
  timer.unref?.();
  return {
    event(event) {
      if (event.type !== "activity") phase = safeActivityText(event.text);
      if (event.type === "stalled") {
        const state = snapshot();
        const worker = state.activity.filter((w) => w.task_id === event.task_id).at(-1);
        const dedup = `${event.task_id}:${worker?.id ?? ""}:${event.text}`;
        if (!notified.has(dedup)) {
          notified.add(dedup);
          ui.notify(
            `[${missionId}] STALLED ${safeActivityText(event.task_id ?? "")}: ${safeActivityText(event.text)}`,
            "warning",
          );
        }
      }
      render();
    },
    stop() {
      clearInterval(timer);
      try {
        ui.setWidget?.(key, undefined);
        ui.setStatus?.(key, undefined);
      } catch {
        /* Detached UI. */
      }
    },
  };
}
