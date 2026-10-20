import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { NO_CHANGES_VS_BASE, createWorkerResultTool } from "../../src/workers/workerResultTool.ts";

const run = promisify(execFile);

/**
 * The guarded `worker_result` decides whether a worker's final report ends the
 * session or is thrown back at it. That single branch caused a 34-hour production
 * loop: a worker that discovered the objective was ALREADY satisfied had no legal
 * way to say so, restated the same conclusion, and was killed by the loop guard
 * (`agent.loop_prevented after 0 identical no-progress turns`), after which
 * recovery dispatched another repair task to rediscover the same fact.
 *
 * So both sides are pinned here: an empty `completed` must still be rejected (the
 * guard is what stops a worker finishing with nothing to show), and a reasoned,
 * evidenced "already satisfied" must be ACCEPTED (the guard must not become a
 * machine that can never conclude no-op).
 */
async function repo(): Promise<{ cwd: string; base: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-eng-worker-result-guard-"));
  await run("git", ["init", "-q", cwd]);
  await run("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", cwd, "config", "user.name", "Test"]);
  await writeFile(join(cwd, "README.md"), "# fixture\n");
  await run("git", ["-C", cwd, "add", "-A"]);
  await run("git", ["-C", cwd, "commit", "-q", "-m", "init"]);
  const base = (await run("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim();
  return { cwd, base, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

const params = (over: Record<string, unknown> = {}) =>
  ({
    status: "completed",
    summary: "done",
    claims: [],
    evidence_refs: [],
    new_hypotheses: [],
    proposed_tasks: [],
    ...over,
  }) as never;

async function report(tool: ReturnType<typeof createWorkerResultTool>, over?: Record<string, unknown>) {
  return tool.execute("call-1", params(over), new AbortController().signal, undefined, undefined as never);
}

describe("guarded worker_result: no-changes vs an already-satisfied no-op", () => {
  it("still rejects a completed report with no changes vs base", async () => {
    const { cwd, base, cleanup } = await repo();
    try {
      await assert.rejects(report(createWorkerResultTool({ cwd, baseRef: base })), (error: Error) =>
        error.message.includes(NO_CHANGES_VS_BASE),
      );
    } finally {
      await cleanup();
    }
  });

  it("accepts an evidenced already_satisfied report and terminates the session", async () => {
    const { cwd, base, cleanup } = await repo();
    try {
      const result = await report(createWorkerResultTool({ cwd, baseRef: base }), {
        summary: "the health endpoint already exists on base",
        already_satisfied: {
          reason: "PR #599 already merged the capacity analytics; nothing remains to change",
          proof: "commit a192077 on main",
        },
      });
      assert.equal(result.terminate, true, "a no-op must END the session, not loop it");
      const details = result.details as { status: string; details: { already_satisfied?: unknown } };
      assert.equal(details.status, "completed");
      assert.deepEqual(details.details.already_satisfied, {
        reason: "PR #599 already merged the capacity analytics; nothing remains to change",
        proof: "commit a192077 on main",
      });
      assert.match(String((result.content[0] as { text?: string } | undefined)?.text ?? ""), /already satisfied/i);
    } finally {
      await cleanup();
    }
  });

  it("does not let a blank assertion substitute for work", async () => {
    const { cwd, base, cleanup } = await repo();
    try {
      for (const assertion of [
        { reason: "", proof: "commit a192077" },
        { reason: "already merged", proof: "" },
        { reason: "   ", proof: "   " },
      ]) {
        await assert.rejects(
          report(createWorkerResultTool({ cwd, baseRef: base }), { already_satisfied: assertion }),
          (error: Error) => error.message.includes(NO_CHANGES_VS_BASE),
          `an assertion without a ${assertion.reason ? "proof" : "reason"} must not close a mutating task`,
        );
      }
    } finally {
      await cleanup();
    }
  });

  it("does not consult the assertion at all when the worktree actually changed", async () => {
    const { cwd, base, cleanup } = await repo();
    try {
      await writeFile(join(cwd, "src.ts"), "export const x = 1;\n");
      await run("git", ["-C", cwd, "add", "-A"]);
      await run("git", ["-C", cwd, "commit", "-q", "-m", "work"]);
      const result = await report(createWorkerResultTool({ cwd, baseRef: base }));
      assert.equal(result.terminate, true);
      assert.equal(
        (result.details as { details: { already_satisfied?: unknown } }).details.already_satisfied,
        undefined,
      );
    } finally {
      await cleanup();
    }
  });

  it("records an assertion on the unguarded tool, which has no view of the worktree", async () => {
    // Without a guard the tool cannot check the worktree at all, so the assertion
    // is simply recorded. Pinned so the difference stays deliberate rather than
    // looking like a second, weaker code path.
    const result = await report(createWorkerResultTool(), {
      already_satisfied: { reason: "already merged", proof: "commit a192077" },
    });
    assert.equal(result.terminate, true);
    assert.deepEqual((result.details as { details: { already_satisfied?: unknown } }).details.already_satisfied, {
      reason: "already merged",
      proof: "commit a192077",
    });
  });

  it("trims an assertion so whitespace cannot masquerade as evidence", async () => {
    const { cwd, base, cleanup } = await repo();
    try {
      const result = await report(createWorkerResultTool({ cwd, baseRef: base }), {
        already_satisfied: { reason: "  already merged  ", proof: "  commit a192077  " },
      });
      assert.deepEqual(
        (result.details as { details: { already_satisfied?: { reason: string; proof: string } } }).details
          .already_satisfied,
        { reason: "already merged", proof: "commit a192077" },
      );
    } finally {
      await cleanup();
    }
  });
});
