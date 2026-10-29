import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeMissionActivityEvent } from "../../src/runtime/EngineeringRuntime.ts";
import {
  MissionPresenceController,
  type PresenceOptions,
  type PresenceSink,
  presenceOptionsFromEnv,
} from "../../src/status/MissionPresenceController.ts";
import { StatusSurfaceBus } from "../../src/status/surfaceBus.ts";

const T0 = Date.parse("2026-10-27T10:10:00.000Z");
let clock = T0;
const now = () => clock;

function mission(overrides: Partial<RuntimeMissionActivityEvent> = {}): RuntimeMissionActivityEvent {
  return {
    missionId: "MSN-1",
    title: "presence strip",
    phase: "EXECUTING",
    state: "EXECUTING",
    health: "active",
    approximatePercent: 40,
    acceptanceCoverage: { completed: 2, total: 5, approximatePercent: 40 },
    workflowProgress: { completed: 2, total: 5, approximatePercent: 40 },
    summary: "editing src/status/presence.ts",
    activeWorkers: 1,
    waitingWorkers: 0,
    failedWorkers: 0,
    lastMeaningfulProgressAt: "2026-10-27T10:09:40.000Z",
    lastHeartbeatAt: "2026-10-27T10:09:50.000Z",
    action: "CONTINUE",
    reason: "active",
    recovery: { attempt: 0, maxAttempts: 0 },
    nextAction: "monitor",
    nextActionAt: null,
    owner: "owner",
    repository: "/repo",
    task: "t1",
    preservedWork: [],
    ...overrides,
  };
}

/** Tests drive the clock by hand; a 1-hour timer can never fire mid-test. */
function opts(extra: PresenceOptions = {}): PresenceOptions {
  return { now, intervalMs: 3_600_000, ...extra };
}

const running = mission();
const needsYou = mission({ state: "NEEDS_ATTENTION", health: "blocked", reason: "approval required" });

interface RecordedSink extends PresenceSink {
  working: (string | undefined)[];
  widget: (string[] | undefined)[];
  widgetKeys: string[];
  titles: (string | undefined)[];
  notices: { text: string; level: string }[];
}

function recordingSink(): RecordedSink {
  return {
    working: [],
    widget: [],
    widgetKeys: [],
    titles: [],
    notices: [],
    setWorkingMessage(text) {
      this.working.push(text);
    },
    setWidget(key, lines) {
      this.widgetKeys.push(key);
      this.widget.push(lines);
    },
    setTitle(title) {
      this.titles.push(title);
    },
    notify(text, level) {
      this.notices.push({ text, level });
    },
  };
}

test("survives a UI without setWidget or setWorkingMessage", () => {
  const controller = new MissionPresenceController({ notify: () => {} }, opts());
  controller.update(needsYou);
  controller.tick();
  controller.dispose();
});

test("survives a sink whose surface throws", () => {
  const controller = new MissionPresenceController(
    {
      setWorkingMessage() {
        throw new Error("terminal torn down");
      },
      setWidget() {
        throw new Error("terminal torn down");
      },
    },
    opts(),
  );
  controller.update(running);
  controller.tick();
  controller.dispose();
});

/**
 * The working line is arbitrated, not cleared. Presence keeps its claim at
 * priority 50; the foreground agent claims 100. While a turn runs the operator
 * sees the agent's line, and the strip's line returns the moment the turn ends —
 * neither controller knows the other exists, which is what the old `agentActive`
 * flag got wrong whenever a third producer wanted the line.
 */
test("holds its working-line claim while the agent runs on a shared bus", () => {
  const sink = recordingSink();
  const bus = new StatusSurfaceBus(sink);
  const controller = new MissionPresenceController(sink, opts({ bus }));
  const agent = bus.producer("working", "working-agent");

  controller.update(running);
  controller.tick();
  assert.match(sink.working.at(-1) ?? "", /^Mission · MSN-1 · presence strip/);

  controller.onAgentStart();
  agent.publish({ text: "Working · reading src/a.ts", priority: 100 });
  assert.equal(sink.working.at(-1), "Working · reading src/a.ts", "the agent owns the line during its turn");

  agent.release();
  controller.tick();
  assert.match(sink.working.at(-1) ?? "", /^Mission · MSN-1/, "the strip's line comes back on its own");
  controller.dispose();
});

test("keeps claiming the working line during a turn instead of going blank", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  controller.onAgentStart();
  controller.update(running);
  controller.tick();

  assert.match(sink.working.at(-1) ?? "", /^Mission · MSN-1/, "a lone strip has nothing to yield to");
  assert.equal(controller.isAgentActive(), true, "the controller still tracks the turn it is sharing with");
  controller.dispose();
});

test("restores the working line when the agent settles", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  controller.update(running);
  controller.onAgentStart();
  controller.onAgentEnd();
  controller.tick();
  assert.match(sink.working.at(-1) ?? "", /^Mission · MSN-1/);
  controller.dispose();
});

test("publishes the widget at most once per tick and not when nothing changed", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  controller.update(running);
  controller.tick();
  controller.tick();
  assert.equal(sink.widget.length, 1);
  clock = T0 + 60_000;
  controller.tick();
  assert.equal(sink.widget.length, 2, "an elapsed age is a change worth republishing");
  controller.dispose();
  clock = T0;
});

test("uses only the engineering-missions widget key", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  controller.update(running);
  controller.tick();
  controller.update(needsYou);
  controller.tick();
  assert.deepEqual([...new Set(sink.widgetKeys)], ["engineering-missions"]);
  controller.dispose();
});

test("notifies once per attention change and not again while unchanged", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  controller.update(needsYou);
  controller.tick();
  controller.update(needsYou);
  controller.tick();
  assert.equal(sink.notices.length, 1);
  assert.match(sink.notices[0]!.text, /MSN-1/);
  assert.match(sink.notices[0]!.text, /needs you/);
  assert.equal(sink.notices[0]!.level, "warning");

  controller.update(running);
  controller.tick();
  controller.update(needsYou);
  controller.tick();
  assert.equal(sink.notices.length, 2);
  controller.dispose();
});

test("does not notify for ordinary running or waiting missions", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  controller.update(running);
  controller.tick();
  controller.update(mission({ state: "WAITING_FOR_LLM", health: "waiting" }));
  controller.tick();
  assert.deepEqual(sink.notices, []);
  controller.dispose();
});

test("calls the quiet hook for every tracked mission on tick", () => {
  const quietIds: string[] = [];
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts({ quiet: (missionId) => quietIds.push(missionId) }));
  controller.update(running);
  controller.tick();
  assert.deepEqual(quietIds, ["MSN-1"]);
  controller.dispose();
});

test("noteSentence replaces the working-line text for that mission", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  controller.update(running);
  controller.noteSentence("MSN-1", "Tests: 34 passed, 1 failing");
  controller.tick();
  assert.match(sink.working.at(-1) ?? "", /Tests: 34 passed, 1 failing/);
  controller.dispose();
});

test("noteSentence redacts secrets before they reach the title bar", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  controller.update(running);
  controller.noteSentence("MSN-1", "using sk-abc123def456abc123def456");
  controller.tick();
  assert.doesNotMatch(sink.working.at(-1) ?? "", /sk-abc123/);
  controller.dispose();
});

test("dispose clears the widget, the working line and the title", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts({ title: true }));
  controller.update(running);
  controller.tick();
  controller.dispose();
  assert.equal(sink.widget.at(-1), undefined);
  assert.equal(sink.working.at(-1), undefined);
  assert.equal(sink.titles.at(-1), undefined);
});

test("title stays off unless enabled", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  controller.update(running);
  controller.tick();
  assert.deepEqual(sink.titles, []);
});

test("an enabled title carries the attention counts", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts({ title: true }));
  controller.update(running);
  controller.update({ ...needsYou, missionId: "MSN-2" });
  controller.tick();
  assert.match(sink.titles.at(-1) ?? "", /1 running · 1 needs you/);
  controller.dispose();
});

test("visible counts the missions the controller is tracking", () => {
  const controller = new MissionPresenceController({}, opts({ rows: 1 }));
  controller.update(running);
  controller.update({ ...needsYou, missionId: "MSN-2" });
  assert.equal(controller.visible(), 2);
  controller.dispose();
});

test("presence is on by default and off only when told", () => {
  assert.equal(presenceOptionsFromEnv({}).enabled, true);
  assert.equal(presenceOptionsFromEnv({ PI_MISSION_PRESENCE: "0" }).enabled, false);
});

test("the row budget is bounded so a wide strip cannot eat the terminal", () => {
  assert.equal(presenceOptionsFromEnv({}).rows, 4);
  assert.equal(presenceOptionsFromEnv({ PI_MISSION_PRESENCE_ROWS: "7" }).rows, 7);
  assert.equal(presenceOptionsFromEnv({ PI_MISSION_PRESENCE_ROWS: "400" }).rows, 10);
  assert.equal(presenceOptionsFromEnv({ PI_MISSION_PRESENCE_ROWS: "nonsense" }).rows, 4);
});

test("the title bar is opt-in and the poll has a floor", () => {
  assert.equal(presenceOptionsFromEnv({}).title, false);
  assert.equal(presenceOptionsFromEnv({ PI_MISSION_TITLE: "1" }).title, true);
  assert.equal(presenceOptionsFromEnv({}).pollMs, 5_000);
  assert.equal(
    presenceOptionsFromEnv({ PI_MISSION_PRESENCE_POLL_MS: "10" }).pollMs,
    1_000,
    "a 10ms poll would hammer the runtime",
  );
});

test("the quiet heartbeat has its own slower cadence than the strip", () => {
  let quietCalls = 0;
  const controller = new MissionPresenceController({}, opts({ quiet: () => quietCalls++, quietMs: 60_000 }));
  controller.update(running);
  controller.tick();
  controller.tick();
  assert.equal(quietCalls, 1, "a one-second strip refresh must not ask for a summary every second");
  clock = T0 + 61_000;
  controller.tick();
  assert.equal(quietCalls, 2);
  clock = T0;
  controller.dispose();
});

test("a replay of stored stopped and complete missions sets a baseline and never notifies", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  const stopped = mission({ missionId: "MSN-old", state: "STOPPED", health: "stalled" });
  const complete = mission({ missionId: "MSN-done", state: "COMPLETE", health: "complete" });
  controller.update(stopped, undefined, "replay");
  controller.update(complete, undefined, "replay");
  controller.update(needsYou, undefined, "store");
  controller.tick();
  controller.update(stopped, undefined, "activity");
  controller.tick();
  assert.deepEqual(sink.notices, []);
  assert.equal(controller.visible(), 3);
  controller.dispose();
});

test("a live change after a replayed baseline still notifies", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  controller.update(running, undefined, "replay");
  controller.tick();
  controller.update(needsYou, undefined, "activity");
  controller.tick();
  assert.equal(sink.notices.length, 1);
  assert.match(sink.notices[0]!.text, /needs you/);
  controller.dispose();
});

test("a live event that raises attention rank after a replay still notifies", () => {
  const sink = recordingSink();
  const controller = new MissionPresenceController(sink, opts());
  controller.update(running, undefined, "replay");
  controller.update(needsYou, undefined, "activity");
  controller.tick();
  assert.equal(sink.notices.length, 1);
  controller.dispose();
});
