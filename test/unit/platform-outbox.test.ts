import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type MemoryCommit, MemoryOutbox, redactMemoryText } from "../../src/platform/memoryOutbox.ts";

function failingTransport(): { push: (c: MemoryCommit) => Promise<void>; pushed: MemoryCommit[] } {
  const pushed: MemoryCommit[] = [];
  return {
    pushed,
    push: async (c) => {
      if (c.kind === "decision") throw new Error("openviking down");
      pushed.push(c);
    },
  };
}

describe("MemoryOutbox (OpenViking offline mode)", () => {
  it("redacts secrets before enqueue", async () => {
    const outbox = new MemoryOutbox({ transport: { push: async () => {} } });
    const commit = await outbox.enqueue({
      projectId: "PRJ-1",
      sessionId: "S1",
      kind: "promotion",
      text: "token=abc123 and Bearer xyz",
    });
    assert.ok(!commit.text.includes("abc123"));
    assert.ok(!commit.text.includes("xyz"));
    assert.ok(commit.text.includes("token: [REDACTED]"));
    outbox.dispose();
  });

  it("flushes successfully and drops nothing on success", async () => {
    const t = failingTransport();
    const outbox = new MemoryOutbox({ transport: t });
    await outbox.enqueue({ projectId: "PRJ-1", sessionId: "S1", kind: "promotion", text: "a" });
    await outbox.enqueue({ projectId: "PRJ-1", sessionId: "S1", kind: "note", text: "b" });
    const result = await outbox.flush();
    assert.equal(result.pushed, 2);
    assert.equal(result.remaining, 0);
    assert.equal(t.pushed.length, 2);
    outbox.dispose();
  });

  it("keeps failed commits queued for retry (never silently memoryless)", async () => {
    const t = failingTransport();
    const outbox = new MemoryOutbox({ transport: t });
    await outbox.enqueue({ projectId: "PRJ-1", sessionId: "S1", kind: "note", text: "ok" });
    await outbox.enqueue({ projectId: "PRJ-1", sessionId: "S1", kind: "decision", text: "d" });
    const result = await outbox.flush();
    assert.equal(result.pushed, 1); // the note flushes; the failing decision stays
    assert.equal(result.remaining, 1);
    outbox.dispose();
  });

  it("is durable: survives restart via the JSONL file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-outbox-"));
    const t1 = failingTransport();
    const outbox1 = new MemoryOutbox({ transport: t1, dir });
    await outbox1.enqueue({ projectId: "PRJ-1", sessionId: "S1", kind: "decision", text: "pending" });
    outbox1.dispose();

    const raw = await readFile(join(dir, "memory-outbox.jsonl"), "utf-8");
    assert.ok(raw.includes("pending"));

    const t2 = failingTransport();
    const outbox2 = await MemoryOutbox.open({ transport: t2, dir });
    assert.equal(outbox2.pendingCount(), 1);
    outbox2.dispose();
  });
});

describe("redactMemoryText", () => {
  it("redacts api keys, passwords, tokens and bearer auth", () => {
    assert.ok(!redactMemoryText("api_key=supersecret").includes("supersecret"));
    assert.ok(!redactMemoryText("password=hunter2").includes("hunter2"));
    assert.ok(!redactMemoryText("Authorization: Bearer abc123").includes("abc123"));
    assert.ok(redactMemoryText("plain text stays").includes("plain text"));
  });
});
