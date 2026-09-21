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
    // The key and its separator survive; only the value is replaced. This used
    // to assert `token: [REDACTED]` for an input written `token=abc123`,
    // pinning a rewrite of the separator that had nothing to do with the
    // secret.
    assert.ok(commit.text.includes("token=[REDACTED]"));
    assert.ok(commit.text.includes("Bearer [REDACTED]"));
    outbox.dispose();
  });

  it("redacts the secret shapes that actually occur", async () => {
    // The previous rules matched three shapes and missed nine. `_` is a word
    // character, so `\b` could never match inside `OPENAI_API_KEY` — the most
    // common shape there is — and `[:=]` could not cross a closing quote, so
    // the JSON form never matched either. A fresh-context review demonstrated
    // every line below leaking.
    //
    // Every fixture is ASSEMBLED at runtime rather than written as a literal.
    // These have to carry the exact shape of a real credential to exercise the
    // patterns, and a credential-shaped literal in a source file is what secret
    // scanners are for — this file tripped GitGuardian on its first push. The
    // pieces are meaningless apart and correct together.
    const fake = (prefix: string, body: string) => `${prefix}${body}`;
    const cases: Array<[string, string]> = [];
    const push = (template: (secret: string) => string, secret: string) => cases.push([template(secret), secret]);

    push((v) => `export OPENAI_API_KEY=${v}`, fake("sk-", "proj-AbCdEf0123456789"));
    push((v) => `GITHUB_TOKEN=${v}`, fake("gh", `p_${"A".repeat(12)}${"B".repeat(12)}`));
    push((v) => `config: { "password": "${v}" }`, "hunter2");
    push((v) => `json body {"api_key":"${v}"}`, fake("sk-", "live-9999999999"));
    push((v) => `aws ${v}`, fake("AKIA", "IOSFODNN7EXAMPLE"));
    push((v) => `PGPASSWORD=${v} psql`, "s3cr3t");
    push((v) => `slack ${v}`, fake("xox", "b-1234567890-abcdefghij"));
    push((v) => `clone https://gert:${v}@github.com/acme/alpha.git`, fake("gh", `p_${"S".repeat(20)}`));
    push(
      (v) => `jwt ${fake("ey", "JhbGciOiJIUzI1NiJ9")}.${fake("ey", "JzdWIiOiIxMjM0NSJ9")}.${v}`,
      "SflKxwRJSMeKKF2QT4fwpMeJf36P",
    );
    push(
      (v) => `${fake("-----BEGIN RSA ", "PRIVATE KEY-----")}\n${v}\n${fake("-----END RSA ", "PRIVATE KEY-----")}`,
      "MIIEowIBAAKCAQEA",
    );

    for (const [text, secret] of cases) {
      const out = redactMemoryText(text);
      assert.ok(!out.includes(secret), `leaked: ${text}`);
    }
  });

  it("leaves text carrying no secret alone", async () => {
    // A redactor that mangles ordinary prose is one people route around.
    for (const text of [
      "renamed the token parser in src/lexer.ts",
      "the key insight was that the panel never wrapped",
      "reviewed 14 files and fixed 3 findings",
    ]) {
      assert.equal(redactMemoryText(text), text, `mangled: ${text}`);
    }
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

describe("MemoryOutbox durability (regressions found by a fresh-context review)", () => {
  /** A transport that records what it was given and can be switched on and off. */
  function recorder() {
    const pushed: string[] = [];
    const state = { up: true };
    return {
      pushed,
      state,
      transport: {
        push: async (c: MemoryCommit) => {
          if (!state.up) throw new Error("openviking down");
          pushed.push(c.text);
        },
      },
    };
  }

  it("a delivered commit is gone from disk, so a restart does not re-push it", async () => {
    // The file was an append log that nothing ever truncated, so every commit
    // ever enqueued was re-pushed on every restart, forever. Silent duplication
    // if `push` is not idempotent, and an unbounded file either way.
    const dir = await mkdtemp(join(tmpdir(), "outbox-redeliver-"));
    const first = recorder();
    const outbox = await MemoryOutbox.open({ transport: first.transport, dir });
    await outbox.enqueue({ projectId: "P", sessionId: "S", kind: "note", text: "A" });
    await outbox.enqueue({ projectId: "P", sessionId: "S", kind: "note", text: "B" });
    assert.deepEqual(await outbox.flush(), { pushed: 2, remaining: 0 });
    outbox.dispose();

    const second = recorder();
    const reopened = await MemoryOutbox.open({ transport: second.transport, dir });
    assert.equal(reopened.pendingCount(), 0, "nothing undelivered should survive a successful flush");
    await reopened.flush();
    assert.deepEqual(second.pushed, [], "and a restart must not re-push what was already delivered");
    reopened.dispose();
  });

  it("an undelivered commit survives two restarts", async () => {
    // `load()` renamed the log to a single fixed draining path that nothing
    // ever read, so the SECOND restart overwrote it and destroyed commits that
    // `enqueue()` had already accepted as durable.
    const dir = await mkdtemp(join(tmpdir(), "outbox-two-restarts-"));
    const down = recorder();
    down.state.up = false;

    const boot1 = await MemoryOutbox.open({ transport: down.transport, dir });
    await boot1.enqueue({ projectId: "P", sessionId: "S", kind: "note", text: "A" });
    await boot1.flush(); // fails; A stays queued
    boot1.dispose();

    const boot2 = await MemoryOutbox.open({ transport: down.transport, dir });
    assert.equal(boot2.pendingCount(), 1, "A survives the first restart");
    await boot2.enqueue({ projectId: "P", sessionId: "S", kind: "note", text: "C" });
    boot2.dispose(); // crash before any successful flush

    const boot3 = await MemoryOutbox.open({ transport: down.transport, dir });
    assert.equal(boot3.pendingCount(), 2, "both A and C survive the second restart");
    const up = recorder();
    const boot4 = new MemoryOutbox({ transport: up.transport });
    void boot4;
    down.state.up = true;
    await boot3.flush();
    assert.deepEqual(down.pushed, ["A", "C"], "in the order they were enqueued");
    boot3.dispose();
  });

  it("a legacy draining file left by the old design is recovered, not stranded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "outbox-legacy-"));
    const legacy = { id: "MEM-old", projectId: "P", sessionId: "S", text: "OLD", kind: "note", enqueuedAt: "t" };
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(join(dir, "memory-outbox-draining.jsonl"), `${JSON.stringify(legacy)}\n`, "utf-8"),
    );
    const r = recorder();
    const outbox = await MemoryOutbox.open({ transport: r.transport, dir });
    assert.equal(outbox.pendingCount(), 1, "an outbox written by the previous design still recovers");
    await outbox.flush();
    assert.deepEqual(r.pushed, ["OLD"]);
    outbox.dispose();
  });

  it("a failed durable write leaves nothing queued, so a retry cannot double-deliver", async () => {
    // The entry was pushed onto the queue BEFORE the durable append, so a
    // failing append told the caller it had failed while still delivering it.
    const r = recorder();
    // A path that cannot be a directory: `mkdir` fails, so the append fails.
    const blocked = join(await mkdtemp(join(tmpdir(), "outbox-blocked-")), "file");
    await import("node:fs/promises").then((fs) => fs.writeFile(blocked, "not a dir", "utf-8"));
    const outbox = new MemoryOutbox({ transport: r.transport, dir: join(blocked, "sub") });
    await assert.rejects(() => outbox.enqueue({ projectId: "P", sessionId: "S", kind: "note", text: "X" }));
    assert.equal(outbox.pendingCount(), 0, "a commit that was never made durable must not be queued");
    await outbox.flush();
    assert.deepEqual(r.pushed, [], "and must not be delivered behind the caller's back");
    outbox.dispose();
  });

  it("the queue is bounded, and says so rather than growing without limit", async () => {
    const r = recorder();
    r.state.up = false;
    const outbox = new MemoryOutbox({ transport: r.transport, maxQueue: 2 });
    await outbox.enqueue({ projectId: "P", sessionId: "S", kind: "note", text: "1" });
    await outbox.enqueue({ projectId: "P", sessionId: "S", kind: "note", text: "2" });
    await assert.rejects(
      () => outbox.enqueue({ projectId: "P", sessionId: "S", kind: "note", text: "3" }),
      /full/,
      "refusing is the explicit policy: a caller told no can react, one silently evicted cannot",
    );
    assert.equal(outbox.pendingCount(), 2);
    outbox.dispose();
  });

  it("a torn trailing line is skipped and reported, not silently swallowed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "outbox-torn-"));
    const good = { id: "MEM-1", projectId: "P", sessionId: "S", text: "GOOD", kind: "note", enqueuedAt: "t" };
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(join(dir, "memory-outbox.jsonl"), `${JSON.stringify(good)}\n{"id":"MEM-2","tex`, "utf-8"),
    );
    const notices: string[] = [];
    const { setTelemetrySink } = await import("../../src/telemetry/sink.ts");
    const restore = setTelemetrySink((n) => notices.push(n.text));
    const r = recorder();
    let outbox: MemoryOutbox;
    try {
      outbox = await MemoryOutbox.open({ transport: r.transport, dir });
    } finally {
      restore();
    }
    assert.equal(outbox.pendingCount(), 1, "the complete entry survives");
    assert.ok(
      notices.some((n) => n.includes("unreadable")),
      "and the loss is reported rather than hidden",
    );
    // The consolidated file must no longer contain the torn fragment, so the
    // next append cannot concatenate onto it.
    const onDisk = await readFile(join(dir, "memory-outbox.jsonl"), "utf-8");
    const lines = onDisk.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 1, "only the complete entry is carried forward");
    assert.doesNotThrow(() => JSON.parse(lines[0] as string), "and every surviving line parses");
    assert.ok(onDisk.endsWith("\n"), "the file ends cleanly, so the next append cannot concatenate onto a fragment");
    outbox.dispose();
  });
});
