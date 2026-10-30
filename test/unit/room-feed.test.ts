/**
 * Room feed logic: cursor + de-duplication, SSE parsing, terminal-safe rendering at three verbosities.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type RoomEvent, RoomFeed, SseParser, renderEvent, safeText } from "../../src/runtime/herdr/roomFeed.ts";

const msg = (sequence: number, text = `m${sequence}`, extra: Partial<RoomEvent> = {}): RoomEvent => ({
  sequence,
  event_id: `e${sequence}`,
  event_type: "message",
  created_at: "2026-10-29T10:15:00Z",
  sender: { type: "user", id: "ann" },
  text,
  ...extra,
});

describe("room feed", () => {
  it("accepts an event once by sequence and by id, and treats gaps in sequence as normal", () => {
    const f = new RoomFeed(10);
    assert.equal(f.accept(msg(14)), "new"); // sequences are server-global: 11..13 belong to other rooms
    assert.equal(f.accept(msg(14)), "duplicate");
    assert.equal(f.accept(msg(12)), "duplicate"); // behind the cursor
    assert.equal(f.accept({ ...msg(20), event_id: "e14" }), "duplicate"); // same id, new sequence
    assert.equal(f.accept({ sequence: "x" }), "invalid");
    assert.equal(f.cursor, 14);
    assert.equal(f.adoptServerCursor(3), true);
    assert.equal(f.adoptServerCursor(99), false);
    assert.equal(f.cursor, 3);
  });

  it("parses SSE across chunk boundaries and drops comments and garbage", () => {
    const p = new SseParser();
    assert.deepEqual(p.push(': keep-alive\n\ndata: {"a"'), []);
    assert.deepEqual(p.push(':1}\n\ndata: not json\n\ndata: {"b":2}\n\n'), [{ a: 1 }, { b: 2 }]);
    assert.throws(() => p.push("x".repeat(SseParser.MAX_BUFFER + 1)), RangeError);
  });

  it("strips terminal escapes and direction overrides from untrusted text", () => {
    const evil = "hi\u001b[31m red\u001b]0;title\u0007 ‮evil\u0000!";
    assert.equal(safeText(evil), "hi red evil!");
    assert.ok(!renderEvent(msg(1, evil), "simple")?.includes("\u001b"));
  });

  it("renders simple < activity < expert", () => {
    const task: RoomEvent = { ...msg(2), event_type: "task_updated", task: { status: "running", text: "build" } };
    const done: RoomEvent = { ...task, task: { status: "completed", text: "build" } };
    const grant: RoomEvent = { ...msg(3), event_type: "agent_granted" };
    assert.match(renderEvent(msg(1), "simple") ?? "", /^10:15 ann: m1$/);
    assert.equal(renderEvent(task, "simple"), null);
    assert.match(renderEvent(done, "simple") ?? "", /task completed: build/);
    assert.equal(renderEvent(grant, "simple"), null);
    assert.match(renderEvent(task, "activity") ?? "", /task running/);
    assert.match(renderEvent(grant, "activity") ?? "", /agent granted/);
    assert.match(renderEvent(msg(1), "expert") ?? "", /#1 e1$/);
  });
});
