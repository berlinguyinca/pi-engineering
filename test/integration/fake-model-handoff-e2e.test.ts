/**
 * Full smoke of the same-model context handoff with REAL runtime code: EngineeringRuntime, the orchestrator, real worker
 * processes and git worktrees, against a local fake OpenAI-compatible model (test/support/fakeModelServer.ts). Each scenario
 * runs in a child process (test/support/fakeModelHandoffRun.ts) because it needs its own HOME, state dir and server.
 *
 * normal: the first worker commits, then reports a context reading past the emergency level -> a context_pressure handoff
 *   pins the task to the same provider/id, fences the writer, and a NEW session on that model starts from the checkpoint.
 * ghost: the reported model is not in the registry -> it is not pinned (and the report says so), but the successor STILL
 *   starts from the verified checkpoint.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const runner = fileURLToPath(new URL("../support/fakeModelHandoffRun.ts", import.meta.url));

interface Result {
  doneWhy: string;
  err: string;
  executions: Array<{ model: string | null; session: string | null; status: string; exit: string | null }>;
  handoffs: Array<Record<string, unknown>>;
  tasks: Array<{ role: string; kind: string; reqModel?: string; repair_base?: string }>;
  reports: string[];
  fakeRequests: Array<{ session: number; turn: number; lastToolResult?: string }>;
}

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fake-handoff-e2e-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function scenario(mode: "normal" | "ghost"): Promise<Result> {
  const out = join(dir, `${mode}.json`);
  await exec("node", ["--experimental-strip-types", runner, out, mode, "180000"], { timeout: 200_000 });
  return JSON.parse(readFileSync(out, "utf8")) as Result;
}

const successorSaw = (r: Result) => r.fakeRequests.find((q) => q.session === 2 && q.turn === 2)?.lastToolResult ?? "";

describe("same-model context handoff, real runtime + fake model", () => {
  it("normal: pinned to the same provider/id, predecessor fenced, new session on that model from the checkpoint, acknowledged", async () => {
    const r = await scenario("normal");
    assert.equal(r.err, "");
    const [h, ...more] = r.handoffs;
    assert.equal(more.length, 0, "one handoff");
    assert.equal(h?.kind, "context");
    assert.equal(h?.cause, "context_pressure");
    assert.equal(h?.state, "acknowledged");
    assert.equal(h?.toModel, "fakeprov/smoke-model", "the routable provider/id, not the bare id the worker reported");
    assert.ok(h?.verifiedAt && h?.sourceFencedAt);
    const task = r.tasks.find((t) => t.kind === "agent");
    assert.equal(task?.reqModel, "fakeprov/smoke-model");
    assert.equal(task?.repair_base, h?.checkpointSha);
    const [pred, succ] = r.executions;
    assert.equal(pred?.status, "CANCELED");
    assert.match(pred?.exit ?? "", /late_result_rejected:handoff source fenced/);
    assert.equal(succ?.status, "SUCCEEDED");
    assert.equal(succ?.model, "smoke-model");
    assert.notEqual(pred?.session, succ?.session, "a new session");
    assert.equal((h?.successor as { sessionId: string }).sessionId, succ?.session);
    assert.match(
      successorSaw(r),
      /worker1: add multiply \(checkpoint\)/,
      "the successor sees the first worker's commit",
    );
    assert.match(successorSaw(r), /function multiply/);
    assert.ok(r.reports.some((l) => /source fenced \(successor pinned to fakeprov\/smoke-model\)/.test(l)));
  });

  it("ghost: an unpinnable model is said so and routes normally, but the successor still starts from the checkpoint", async () => {
    const r = await scenario("ghost");
    assert.equal(r.err, "");
    const [h] = r.handoffs;
    assert.equal(h?.cause, "context_pressure");
    assert.equal(h?.state, "acknowledged");
    assert.equal(h?.toModel, undefined, "never pinned to a model that cannot serve");
    assert.ok(
      r.reports.some((l) =>
        /successor not pinned to fakeprov\/ghost \(not in the model registry\); it routes normally/.test(l),
      ),
    );
    const task = r.tasks.find((t) => t.kind === "agent");
    assert.equal(task?.repair_base, h?.checkpointSha, "the resume base is set without choosing a model");
    assert.match(successorSaw(r), /worker1: add multiply \(checkpoint\)/);
    assert.doesNotMatch(successorSaw(r), /NO-MULTIPLY-VISIBLE/);
  });
});
