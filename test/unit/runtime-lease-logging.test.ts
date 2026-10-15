import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emitRuntimeEvent, setRuntimeEventLog } from "../../src/runtime/isolation/runtimeEvents.ts";

const read = (f: string) =>
  readFileSync(f, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("lease.contended is logged once per (resource, holder) with a periodic summary", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-runtime-log-")), "runtime.jsonl");
  const saved = process.env.PI_RUNTIME_CONTENTION_SUMMARY_MS;
  process.env.PI_RUNTIME_CONTENTION_SUMMARY_MS = "0";
  setRuntimeEventLog(file);
  try {
    process.env.PI_RUNTIME_CONTENTION_SUMMARY_MS = "3600000";
    for (let i = 0; i < 50; i++) emitRuntimeEvent("lease.contended", { resource: "r1", holder_session: "h1" });
    emitRuntimeEvent("lease.contended", { resource: "r1", holder_session: "h2" });
    let recs = read(file);
    assert.equal(recs.filter((r) => r.event === "lease.contended").length, 2, "one line per (resource, holder)");
    assert.equal(recs.filter((r) => r.event === "lease.contended_summary").length, 0);
    process.env.PI_RUNTIME_CONTENTION_SUMMARY_MS = "0";
    emitRuntimeEvent("lease.contended", { resource: "r1", holder_session: "h1" });
    recs = read(file);
    const summary = recs.find((r) => r.event === "lease.contended_summary");
    assert.ok(summary, "summary line once the interval elapsed");
    const h1 = summary.contentions.find((c: any) => c.resource === "r1" && c.holder_session === "h1");
    assert.equal(h1.count, 51);
  } finally {
    setRuntimeEventLog(null);
    if (saved === undefined) delete process.env.PI_RUNTIME_CONTENTION_SUMMARY_MS;
    else process.env.PI_RUNTIME_CONTENTION_SUMMARY_MS = saved;
  }
});

test("runtime.jsonl rotates at the size cap", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-runtime-log-")), "runtime.jsonl");
  const saved = process.env.PI_RUNTIME_LOG_MAX_BYTES;
  process.env.PI_RUNTIME_LOG_MAX_BYTES = "2000";
  setRuntimeEventLog(file);
  try {
    for (let i = 0; i < 100; i++) emitRuntimeEvent("runtime.started", { n: i, pad: "x".repeat(50) });
    assert.ok(statSync(file).size <= 2000 + 300);
    assert.ok(existsSync(`${file}.1`));
  } finally {
    setRuntimeEventLog(null);
    if (saved === undefined) delete process.env.PI_RUNTIME_LOG_MAX_BYTES;
    else process.env.PI_RUNTIME_LOG_MAX_BYTES = saved;
  }
});
