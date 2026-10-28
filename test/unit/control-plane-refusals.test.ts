import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";
import { EnvelopeStore } from "../../src/runtime/herdr/envelopeStore.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Reply = { status: number; body?: string };
function rig(replies: Reply[]) {
  const dir = mkdtempSync(join(tmpdir(), "pi-refusal-"));
  dirs.push(dir);
  const sent: string[] = [];
  let i = 0;
  const ingest = new ControlPlaneIngest({
    url: "http://x",
    envelopeStore: new EnvelopeStore({ dir, source: "pi-hosta-00000001" }),
    backoff: { baseMs: 0 },
    fetch: (async (_u: string, init?: RequestInit) => {
      sent.push((JSON.parse(String(init?.body)) as { event_id: string }).event_id);
      const r = replies[Math.min(i++, replies.length - 1)]!;
      return new Response(r.body ?? "{}", { status: r.status });
    }) as typeof fetch,
  });
  return { ingest, sent, dir };
}

const FORBIDDEN = JSON.stringify({ error: "not permitted to modify this lineage object", reason: "lineage_forbidden" });

test("403 lineage_forbidden is terminal: dead-lettered, counted rejected, never delivered, queue continues", async () => {
  const { ingest, sent } = rig([{ status: 403, body: FORBIDDEN }, { status: 200 }]);
  assert.equal(
    await ingest.emit("lineage", "agent:a", "node.upsert", { node_id: "agent:a" }),
    false,
    "never reported delivered",
  );
  assert.equal(
    await ingest.emit("lineage", "agent:b", "node.upsert", { node_id: "agent:b" }),
    true,
    "the next event still flows",
  );
  const d = ingest.diagnostics()!;
  assert.equal(d.credentialProblem, false);
  assert.equal(d.pending, 0);
  assert.equal(ingest.rejected, 1);
  assert.equal(d.deadLettered, 0);
  assert.equal(sent.length, 2);
});

test("plain 401/403 (no reason, non-JSON, other reason, oversized) stays a credentials problem: kept queued", async () => {
  const bodies = [
    { status: 403, body: "{}" },
    { status: 403, body: "<html>forbidden</html>" },
    { status: 403, body: JSON.stringify({ reason: "something_else" }) },
    { status: 403, body: JSON.stringify({ reason: "lineage_forbidden", pad: "x".repeat(10_000) }) },
    { status: 401, body: FORBIDDEN },
  ];
  for (const reply of bodies) {
    const { ingest } = rig([reply]);
    assert.equal(await ingest.emit("lineage", "agent:a", "node.upsert", {}), false);
    const d = ingest.diagnostics()!;
    assert.equal(d.credentialProblem, true, JSON.stringify(reply).slice(0, 80));
    assert.equal(d.pending, 1, "kept queued");
    assert.equal(ingest.rejected, 0);
  }
});

test("409 conflict is terminal; an acknowledged noop (200) counts as delivered", async () => {
  const conflict = rig([{ status: 409, body: JSON.stringify({ reason: "conflict" }) }]);
  assert.equal(await conflict.ingest.emit("lineage", "agent:a", "node.upsert", {}), false);
  assert.equal(conflict.ingest.rejected, 1);
  assert.equal(conflict.ingest.diagnostics()!.pending, 0);

  const noop = rig([{ status: 200, body: JSON.stringify({ ok: true, result: "noop", duplicate: false }) }]);
  assert.equal(await noop.ingest.emit("lineage", "agent:a", "node.upsert", {}), true);
  assert.equal(noop.ingest.diagnostics()!.pending, 0);
  assert.equal(noop.ingest.rejected, 0);
});
