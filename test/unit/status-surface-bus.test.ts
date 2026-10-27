import assert from "node:assert/strict";
import { test } from "node:test";
import { StatusSurfaceBus } from "../../src/status/surfaceBus.ts";

/**
 * Two producers, one working line. Before the bus each guarded the other out
 * with a private flag, so a third producer had to know both flags and the last
 * writer still won. These tests pin the arbitration instead: highest priority
 * owns the surface, and when it releases, the next claimant takes it without
 * knowing the first ever existed.
 */

function harness() {
  let clock = 1_000;
  const calls: string[] = [];
  const sink = {
    setWorkingMessage: (text?: string) => calls.push(`working:${text ?? "∅"}`),
    setWidget: (key: string, lines?: string[] | undefined) => calls.push(`widget:${key}:${lines?.join("|") ?? "∅"}`),
    setTitle: (title?: string) => calls.push(`title:${title ?? "∅"}`),
    notify: (text: string, level: string) => calls.push(`notify:${level}:${text}`),
  };
  const bus = new StatusSurfaceBus(sink, () => clock);
  return { bus, calls, advance: (ms: number) => (clock += ms) };
}

test("the higher-priority claim owns the working line", () => {
  const { bus, calls } = harness();
  const missions = bus.producer("working", "missions");
  const agent = bus.producer("working", "agent");

  missions.publish({ text: "Mission · M-1 · building", priority: 50 });
  agent.publish({ text: "Working · reading src/a.ts", priority: 100 });

  assert.deepEqual(bus.resolved(), [{ surface: "working", producer: "agent", text: "Working · reading src/a.ts" }]);
  assert.deepEqual(
    calls,
    ["working:Mission · M-1 · building", "working:Working · reading src/a.ts"],
    "each write reaches the sink once",
  );
});

test("releasing hands the surface to the next claimant", () => {
  const { bus, calls } = harness();
  const missions = bus.producer("working", "missions");
  const agent = bus.producer("working", "agent");

  missions.publish({ text: "Mission · M-1 · building", priority: 50 });
  agent.publish({ text: "Working · reading", priority: 100 });
  agent.release();

  assert.deepEqual(calls.at(-1), "working:Mission · M-1 · building", "the strip's line returns on its own");
  assert.deepEqual(bus.resolved(), [{ surface: "working", producer: "missions", text: "Mission · M-1 · building" }]);
});

test("an equal priority is settled by the most recent write", () => {
  const { bus } = harness();
  const a = bus.producer("working", "a");
  const b = bus.producer("working", "b");

  a.publish({ text: "a" });
  b.publish({ text: "b" });
  assert.equal(bus.resolved()[0]?.text, "b");

  a.publish({ text: "a again" });
  assert.equal(bus.resolved()[0]?.text, "a again");
});

test("an expired claim stops holding the surface", () => {
  const { bus, calls, advance } = harness();
  const missions = bus.producer("working", "missions");
  const notice = bus.producer("working", "notice");

  missions.publish({ text: "Mission · M-1", priority: 50 });
  notice.publish({ text: "Mission M-1 needs you", priority: 90, expiresAt: 5_000 });
  assert.equal(bus.resolved()[0]?.producer, "notice");

  advance(5_000);
  bus.prune();

  assert.equal(bus.resolved()[0]?.producer, "missions", "the notice expired; the strip took the line back");
  assert.equal(calls.at(-1), "working:Mission · M-1");
});

/** The bug this prevents: a producer rewriting identical content every tick. */
test("unchanged content is not rewritten", () => {
  const { bus, calls } = harness();
  const missions = bus.producer("working", "missions");

  for (let i = 0; i < 5; i++) missions.publish({ text: "Mission · M-1 · building", priority: 50 });
  assert.deepEqual(calls, ["working:Mission · M-1 · building"]);
});

test("widgets are keyed, so producers do not collide by accident", () => {
  const { bus, calls } = harness();
  const working = bus.producer("widget", "working-widget", { key: "engineering-working" });
  const strip = bus.producer("widget", "mission-strip", { key: "engineering-missions" });

  working.publish({ lines: ["gateway wait"] });
  strip.publish({ lines: ["Missions · 1 running"] });

  assert.deepEqual(calls, [
    "widget:engineering-working:gateway wait",
    "widget:engineering-missions:Missions · 1 running",
  ]);
  assert.equal(bus.resolved().length, 2);
});

test("a title claim clears the title when it releases", () => {
  const { bus, calls } = harness();
  const title = bus.producer("title", "presence");

  title.publish({ text: "1 running · 1 needs you" });
  title.release();

  assert.deepEqual(calls, ["title:1 running · 1 needs you", "title:∅"]);
});

/** A surface is observational: a torn-down UI must never fail the work behind it. */
test("a sink that throws is treated as gone", () => {
  const bus = new StatusSurfaceBus({
    setWorkingMessage: () => {
      throw new Error("terminal torn down");
    },
  });
  const agent = bus.producer("working", "agent");

  assert.doesNotThrow(() => agent.publish({ text: "Working · reading" }));
});

test("one notification per change, not per tick", () => {
  const { bus, calls } = harness();

  for (let i = 0; i < 4; i++) bus.notify("M-1", "EXECUTING|active", "Mission M-1 is running", "info");
  bus.notify("M-1", "NEEDS_ATTENTION|blocked", "Mission M-1 needs you", "warning");
  bus.notify("M-1", "NEEDS_ATTENTION|blocked", "Mission M-1 needs you", "warning");

  assert.deepEqual(calls, ["notify:info:Mission M-1 is running", "notify:warning:Mission M-1 needs you"]);
});

test("dispose clears what the bus wrote", () => {
  const { bus, calls } = harness();
  const missions = bus.producer("working", "missions");
  const strip = bus.producer("widget", "mission-strip", { key: "engineering-missions" });

  missions.publish({ text: "Mission · M-1", priority: 50 });
  strip.publish({ lines: ["Missions · 1 running"] });
  calls.length = 0;
  bus.dispose();

  assert.deepEqual(calls, ["working:∅", "widget:engineering-missions:∅"]);
});
