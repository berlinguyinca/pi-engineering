/**
 * APS Phase 2 — worker session activity adapter + event fields.
 *
 * (a) A synthetic REPEATING tool-call stream driven through the adapter and
 *     the existing session event-bus shape emits EXACTLY ONE
 *     `agent.loop_candidate` event carrying the observability fields
 *     (role, model provider/id, family, tool name, no_progress_turns,
 *     repeated_calls, session/run/work-item ids, context-utilization).
 * (b) A non-looping stream (progress each turn) emits NO loop_candidate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { contextUtilization } from "../../src/aps/context.ts";
import { AgentProgressSupervisor, type AgentProgressSupervisorOptions } from "../../src/aps/supervisor.ts";
import type { AgentLoopCandidateEvent, AgentLoopEvent } from "../../src/aps/types.ts";
import { WorkerActivityAdapter } from "../../src/aps/workerActivity.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { TelemetryNotice } from "../../src/telemetry/sink.ts";
import { setTelemetrySink } from "../../src/telemetry/sink.ts";

/**
 * Minimal stand-in for the EXISTING session event bus
 * (`AgentSession.subscribe`): records listeners, lets the test emit events,
 * and supports unsubscribe.
 */
class FakeSessionBus {
  private listeners: Array<(event: any) => void> = [];
  subscribe(listener: (event: any) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  emit(event: any): void {
    for (const l of [...this.listeners]) l(event);
  }
  get listenerCount(): number {
    return this.listeners.length;
  }
}

let tc = 0;
function emitTool(bus: FakeSessionBus, tool: string, args: Record<string, unknown>, result: unknown): void {
  tc += 1;
  const toolCallId = `tc-${tc}`;
  bus.emit({ type: "tool_execution_start", toolCallId, toolName: tool, args });
  bus.emit({ type: "tool_execution_end", toolCallId, toolName: tool, result, isError: false });
}

function emitUsage(bus: FakeSessionBus, input: number): void {
  bus.emit({
    type: "message_end",
    message: { role: "assistant", usage: { input, output: 10, totalTokens: input + 10 } },
  });
}

interface Harness {
  adapter: WorkerActivityAdapter;
  bus: FakeSessionBus;
  events: AgentLoopEvent[];
  notices: TelemetryNotice[];
  store: JsonlEventStore;
  detach: () => void;
}

function setup(
  supervisorOptions: AgentProgressSupervisorOptions = {},
  adapterOptions: Partial<ConstructorParameters<typeof WorkerActivityAdapter>[0]> = {},
): Harness {
  const bus = new FakeSessionBus();
  const events: AgentLoopEvent[] = [];
  const notices: TelemetryNotice[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n));
  test.after(uninstall);
  const store = JsonlEventStore.inMemory();
  const supervisor = new AgentProgressSupervisor({
    ...supervisorOptions,
    eventStore: store,
    onEvent: (e) => events.push(e),
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const adapter = new WorkerActivityAdapter({
    role: "implementer",
    sessionId: "sess-1",
    runId: "run-1",
    workItemId: "WI-1",
    model: { provider: "anthropic", id: "claude-test-1" },
    maxContextTokens: 10_000,
    rootPrefix: "/home/u/proj",
    supervisor,
    ...adapterOptions,
  });
  const detach = adapter.attach(bus);
  test.after(detach);
  return { adapter, bus, events, notices, store, detach };
}

test("(a) repeating tool-call stream emits EXACTLY ONE agent.loop_candidate with the expected fields", async () => {
  const { adapter, bus, events, notices, store } = setup();

  // The session's context usage (4000 of 10000 configured tokens).
  emitUsage(bus, 4000);
  // Four identical tool executions: same intent, same target, same result.
  const sameResult = { content: [{ type: "text", text: "same file content" }] };
  for (let i = 0; i < 4; i++) emitTool(bus, "read_file", { path: "/home/u/proj/src/x.ts" }, sameResult);

  // Detection is synchronous per action, but persistence is async: let it settle.
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(events.length, 1, "exactly one loop_candidate event");
  const ev = events[0]!;
  assert.equal(ev.type, "agent.loop_candidate");
  // Identity fields.
  assert.equal(ev.sessionId, "sess-1");
  assert.equal(ev.runId, "run-1");
  assert.equal(ev.workItemId, "WI-1");
  assert.equal(ev.role, "implementer");
  assert.equal(ev.phase, "execute");
  // Model (provider/id), strategy family, and the raw tool name.
  assert.deepEqual(ev.model, { provider: "anthropic", id: "claude-test-1" });
  assert.equal(ev.family, "READ_FILE");
  assert.equal(ev.tool, "read_file");
  assert.equal(ev.target, "src/x.ts");
  // Progress metrics.
  assert.equal(ev.metrics.noProgressTurns, 2);
  assert.equal(ev.metrics.repeatedCalls, 3);
  assert.equal(ev.reason, "repeated_call");
  // Context utilization: 4000 input tokens / 10000 configured.
  assert.equal(ev.contextUtilization, 0.4);
  assert.match(ev.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(ev.timestamp, "2026-01-01T00:00:00.000Z");

  // The adapter recorded one AgentAction per tool execution, with model + usage attached.
  assert.equal(adapter.actions.length, 4);
  assert.equal(adapter.actions[0]!.modelProvider, "anthropic");
  assert.equal(adapter.actions[0]!.modelId, "claude-test-1");
  assert.equal(adapter.actions[0]!.inputTokens, 4000);
  assert.equal(adapter.actions[0]!.maxContextTokens, 10_000);

  // The existing telemetry bus got the structured notice with the event detail.
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.level, "warning");
  assert.equal((notices[0]!.detail as { type: string })?.type, "agent.loop_candidate");
  assert.deepEqual((notices[0]!.detail as AgentLoopCandidateEvent).model, {
    provider: "anthropic",
    id: "claude-test-1",
  });

  // The existing event store persisted the same fields.
  assert.equal(store.count(), 1);
  const stored = store.all()[0]!;
  assert.equal(stored.type, "agent.loop_candidate");
  const payload = stored.payload as {
    tool: string;
    model: { provider: string; id: string } | null;
    contextUtilization: number | null;
  };
  assert.equal(payload.tool, "read_file");
  assert.deepEqual(payload.model, { provider: "anthropic", id: "claude-test-1" });
  assert.equal(payload.contextUtilization, 0.4);
});

test("(b) non-looping stream (progress each turn) emits NO loop_candidate", async () => {
  const { bus, events, notices, store } = setup();

  // Different target / tool / result every turn: steady progress.
  emitTool(bus, "repo_search", { query: "fingerprint" }, { content: [{ type: "text", text: "5 hits" }] });
  emitTool(bus, "read_file", { path: "src/a.ts" }, { content: [{ type: "text", text: "content A" }] });
  emitTool(bus, "read_file", { path: "src/b.ts" }, { content: [{ type: "text", text: "content B" }] });
  emitTool(bus, "bash", { command: "npm test" }, { content: [{ type: "text", text: "exit 0" }] });
  emitTool(bus, "edit_file", { path: "src/a.ts" }, { content: [{ type: "text", text: "file changed" }] });
  emitTool(bus, "read_file", { path: "src/a.ts" }, { content: [{ type: "text", text: "content A (updated)" }] });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(events.length, 0, "no loop_candidate events");
  assert.equal(notices.length, 0, "no telemetry notices");
  assert.equal(store.count(), 0, "nothing persisted");
});

test("(b2) repeated tool with a CHANGED result is progress, not a loop", async () => {
  const { bus, events } = setup();
  // Same tool + target, but the observed state changes each turn.
  emitTool(bus, "read_file", { path: "src/x.ts" }, { content: [{ type: "text", text: "v1" }] });
  emitTool(bus, "read_file", { path: "src/x.ts" }, { content: [{ type: "text", text: "v2" }] });
  emitTool(bus, "read_file", { path: "src/x.ts" }, { content: [{ type: "text", text: "v3" }] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events.length, 0, "state change each turn is progress");
});

test("adapter creates its own per-session supervisor when none is provided", async () => {
  const bus = new FakeSessionBus();
  const adapter = new WorkerActivityAdapter({ role: "reviewer" });
  const detach = adapter.attach(bus);
  test.after(detach);
  assert.match(adapter.sessionId, /^APSSESS-[0-9A-Za-z]{6}$/, "generated session identity");
  // A fresh loop is still detected and recorded on the adapter's own supervisor.
  for (let i = 0; i < 3; i++)
    emitTool(bus, "read_file", { path: "src/z.ts" }, { content: [{ type: "text", text: "z" }] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(adapter.supervisor.emittedEvents.length, 1, "default supervisor detects the loop");
  assert.equal(adapter.supervisor.emittedEvents[0]!.role, "reviewer");
  assert.equal(adapter.supervisor.emittedEvents[0]!.model, null, "unknown model reports null");
});

test("detach stops observation", async () => {
  const { bus, events, detach } = setup();
  emitTool(bus, "read_file", { path: "src/x.ts" }, { content: [{ type: "text", text: "same" }] });
  emitTool(bus, "read_file", { path: "src/x.ts" }, { content: [{ type: "text", text: "same" }] });
  detach();
  assert.equal(bus.listenerCount, 0, "subscriber removed from the existing bus");
  emitTool(bus, "read_file", { path: "src/x.ts" }, { content: [{ type: "text", text: "same" }] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events.length, 0, "no detection after detach");
});

test("contextUtilization: clamps to [0,1], null when data is unavailable", () => {
  assert.equal(contextUtilization(4000, 10_000), 0.4);
  assert.equal(contextUtilization(0, 10_000), 0);
  assert.equal(contextUtilization(12_000, 10_000), 1, "clamped to 1");
  assert.equal(contextUtilization(-5, 10_000), 0, "clamped to 0");
  assert.equal(contextUtilization(undefined, 10_000), null, "no usage data");
  assert.equal(contextUtilization(null, 10_000), null);
  assert.equal(contextUtilization(4000, undefined), null, "no configured budget");
  assert.equal(contextUtilization(4000, 0), null, "non-positive budget");
  assert.equal(contextUtilization(Number.NaN, 10_000), null, "non-finite usage");
});

test("contextUtilization is reported in the event only when usage and budget are known", async () => {
  // No usage events at all: utilization must be null, not a guess.
  const { bus, events } = setup();
  for (let i = 0; i < 3; i++)
    emitTool(bus, "read_file", { path: "src/x.ts" }, { content: [{ type: "text", text: "s" }] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.contextUtilization, null);

  // No configured budget (maxContextTokens omitted): also null.
  const noBudget = setup({}, { maxContextTokens: undefined });
  emitUsage(noBudget.bus, 4000);
  for (let i = 0; i < 3; i++)
    emitTool(noBudget.bus, "read_file", { path: "src/y.ts" }, { content: [{ type: "text", text: "s" }] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(noBudget.events.length, 1);
  assert.equal(noBudget.events[0]!.contextUtilization, null);
});
