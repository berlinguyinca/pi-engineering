/**
 * Admission-retry status rendering + controller (spec 04 §1-2).
 *
 * The waiting state is rendered once (a stable status-bar line + widget panel)
 * instead of spamming `Error: 429`. The controller is UI-agnostic and talks to
 * a small sink; terminal events notify once per logical request.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdmissionEvent } from "../../src/inference/admissionEvents.ts";
import {
  AdmissionStatusController,
  isAdmissionEventName,
  renderStatusBar,
  renderWaitingPanel,
  terminalNotifyText,
} from "../../src/inference/admissionStatus.ts";
import type { AdmissionState } from "../../src/inference/admissionTransport.ts";

function state(overrides: Partial<AdmissionState> = {}): AdmissionState {
  return {
    phase: "ADMISSION_WAIT",
    provider: "inferweave",
    model: "qwen",
    logicalRequestId: "lr-1",
    attempt: 3,
    maxAttempts: 50,
    waitedMs: 60_000,
    elapsedMs: 65_000,
    delayMs: 30_000,
    reason: "queue_timeout",
    httpStatus: 429,
    queueDepth: 26,
    queueLimit: 100,
    activeWorkers: 4,
    workerLimit: 4,
    ...overrides,
  };
}

test("renderStatusBar shows the waiting state compactly", () => {
  const line = renderStatusBar(state());
  assert.ok(line);
  assert.match(line!, /IW:waiting 30s/);
  assert.match(line!, /q:26\/100/);
  assert.match(line!, /active:4\/4/);
  assert.match(line!, /attempt 3/);
  assert.match(line!, /waited 1m/);
});

test("renderStatusBar shows requesting/retrying and omits wait-only fields", () => {
  const retrying = renderStatusBar(state({ phase: "RETRYING", attempt: 2 }));
  assert.match(retrying!, /IW:retrying attempt 2/);
  const requesting = renderStatusBar(state({ phase: "REQUESTING", attempt: 1, waitedMs: 0 }));
  assert.match(requesting!, /IW:requesting attempt 1/);
  assert.equal(renderStatusBar(state({ phase: "SUCCEEDED" })), undefined);
});

test("renderStatusBar tolerates missing queue/active figures", () => {
  const line = renderStatusBar(
    state({ queueDepth: undefined, queueLimit: undefined, activeWorkers: undefined, workerLimit: undefined }),
  );
  assert.match(line!, /IW:waiting 30s/);
  assert.ok(!/q:/.test(line!));
  assert.ok(!/active:/.test(line!));
});

test("renderWaitingPanel lists model, reason, capacity, countdown, attempt, waited", () => {
  const lines = renderWaitingPanel(state());
  const joined = lines.join("\n");
  assert.match(joined, /InferWeave capacity busy/);
  assert.match(joined, /Model:\s+qwen/);
  assert.match(joined, /Reason:\s+queue_timeout/);
  assert.match(joined, /Active:\s+4 \/ 4/);
  assert.match(joined, /Queue:\s+26 \/ 100/);
  assert.match(joined, /Retry in:\s+30s/);
  assert.match(joined, /Attempt:\s+3/);
  assert.match(joined, /Waited:\s+1m/);
  assert.match(joined, /Esc to cancel/);
});

test("terminalNotifyText renders each terminal outcome", () => {
  const base = {
    name: "inference.retry.exhausted" as const,
    provider: "inferweave",
    model: "qwen",
    reason: "queue_timeout",
    attempt: 3,
    elapsedWaitMs: 60_000,
  } as AdmissionEvent;
  assert.match(terminalNotifyText(base), /budget exhausted for inferweave\/qwen/);
  assert.match(
    terminalNotifyText({ ...base, name: "inference.fallback.triggered" }),
    /handed inferweave\/qwen to model routing/,
  );
  assert.match(
    terminalNotifyText({ ...base, name: "inference.retry.cancelled" }),
    /Admission wait cancelled for inferweave\/qwen/,
  );
});

test("isAdmissionEventName recognises the full event set", () => {
  for (const n of [
    "inference.retry.scheduled",
    "inference.retry.waiting",
    "inference.retry.started",
    "inference.retry.succeeded",
    "inference.retry.exhausted",
    "inference.retry.cancelled",
    "inference.fallback.triggered",
  ]) {
    assert.ok(isAdmissionEventName(n), n);
  }
  assert.ok(!isAdmissionEventName("inference.something.else"));
});

test("controller sets a status + widget on wait and clears on success", () => {
  const calls: string[] = [];
  const sink = {
    setStatus: (_k: string, t: string | undefined) => calls.push(`status:${t ?? "clear"}`),
    setWidget: (_k: string, l: string[] | undefined) => calls.push(`widget:${l === undefined ? "clear" : l.length}`),
    notify: () => calls.push("notify"),
  };
  const controller = new AdmissionStatusController(sink, undefined);
  controller.handleState(state());
  assert.ok(calls.includes("status:IW:waiting 30s | q:26/100 | active:4/4 | attempt 3 | waited 1m"));
  assert.ok(calls.some((c) => c.startsWith("widget:") && c !== "widget:clear"));
  controller.handleState(state({ phase: "SUCCEEDED" }));
  assert.ok(calls.includes("status:clear"));
  assert.ok(calls.includes("widget:clear"));
  controller.dispose();
});

test("controller notifies once per terminal event via the bus", () => {
  let notified = 0;
  const sink = {
    setStatus: () => {},
    setWidget: () => {},
    notify: () => {
      notified++;
    },
  };
  const bus = new (class {
    listeners: Array<(e: AdmissionEvent) => void> = [];
    subscribe(fn: (e: AdmissionEvent) => void): () => void {
      this.listeners.push(fn);
      return () => {};
    }
    emit(e: AdmissionEvent): void {
      for (const l of [...this.listeners]) l(e);
    }
  })();
  const controller = new AdmissionStatusController(sink, bus as never);
  const ev = {
    name: "inference.retry.exhausted",
    logicalRequestId: "lr-1",
    provider: "inferweave",
    model: "qwen",
    attempt: 3,
    elapsedWaitMs: 60_000,
  } as AdmissionEvent;
  bus.emit(ev);
  bus.emit(ev); // duplicate same logical request -> single notify
  assert.equal(notified, 1);
  controller.dispose();
});
