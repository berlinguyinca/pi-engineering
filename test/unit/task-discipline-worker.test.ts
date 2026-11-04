/**
 * Worker scope narrowing (src/taskDiscipline/worker.ts): a mission worker of a
 * gated parent runs under its OWN contract — derived from the parent's by
 * narrowing, never the parent's own — and the gate is loaded into its session.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileContractProvider } from "../../src/taskDiscipline/config.ts";
import { CONTRACT_FIELDS, type TaskContract, parseContract } from "../../src/taskDiscipline/contract.ts";
import {
  WorkerScopeError,
  childContractForWorker,
  materializeWorkerContract,
  workerContractFile,
  workerGateExtensions,
  workerSessionGate,
  workerTaskId,
} from "../../src/taskDiscipline/worker.ts";

function fixture(parentOver: Record<string, unknown> = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tdw-")));
  const repo = join(base, "repo");
  const worktree = join(repo, "wt-1"); // the worker's allocated worktree
  const outside = join(base, "elsewhere");
  const state = join(base, "state");
  const agentDir = join(base, "agent");
  for (const dir of [repo, worktree, outside, state, agentDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, "peaks.py"), "x = 1\n");
  const parentFile = join(state, "contract.json");
  const log = join(state, "decisions.jsonl");
  const parent: TaskContract = parseContract({
    taskId: "peak-picking",
    missionId: "MSN-1",
    objective: "Diagnose peak picking",
    mode: "implementation",
    policyRevision: 3,
    workspace: repo,
    readRoots: [repo],
    writeRoots: [repo],
    scratchRoots: [state],
    allowedHosts: ["api.example.com"],
    externalEffects: ["git_push", "remote_read"],
    acceptanceCriteria: ["root cause named"],
    ...parentOver,
  });
  writeFileSync(parentFile, JSON.stringify(parent));
  return { base, repo, worktree, outside, state, agentDir, parentFile, log, parent };
}

const worker = (cwd: string, over: Record<string, unknown> = {}) => ({
  taskId: "worker:implementer:abc",
  role: "implementer",
  cwd,
  mutating: true,
  ...over,
});

test("a mutating worker gets the worktree, not the parent's write scope", () => {
  const f = fixture();
  const child = childContractForWorker(f.parent, worker(f.worktree));
  assert.equal(child.parentTaskId, f.parent.taskId);
  assert.equal(child.taskId, "worker:implementer:abc");
  assert.equal(child.mode, "implementation");
  assert.deepEqual(child.writeRoots, [realpathSync(f.worktree)]);
  assert.notDeepEqual(child.writeRoots, f.parent.writeRoots, "must not inherit the parent's broader roots");
  assert.equal(child.missionId, "MSN-1");
  assert.equal(child.policyRevision, f.parent.policyRevision);
});

test("external effects never reach a worker; hosts only when the parent can read remotely", () => {
  const f = fixture();
  assert.deepEqual(childContractForWorker(f.parent, worker(f.worktree)).externalEffects, []);
  assert.deepEqual(childContractForWorker(f.parent, worker(f.worktree)).allowedHosts, ["api.example.com"]);
  const localOnly = parseContract({ ...f.parent, externalEffects: ["git_push"] });
  assert.deepEqual(childContractForWorker(localOnly, worker(f.worktree)).allowedHosts, []);
});

test("a non-mutating role caps at review and loses write roots", () => {
  const f = fixture();
  const child = childContractForWorker(f.parent, worker(f.worktree, { mutating: false, role: "reviewer" }));
  assert.equal(child.mode, "review");
  assert.deepEqual(child.writeRoots, []);
  assert.deepEqual(child.scratchRoots, f.parent.scratchRoots, "diagnostics still land in scratch");
  const reviewParent = parseContract({ ...f.parent, mode: "review", writeRoots: [], externalEffects: [] });
  assert.equal(
    childContractForWorker(reviewParent, worker(reviewParent.workspace!, { mutating: false, role: "reviewer" })).mode,
    "review",
  );
});

test("a worker whose worktree the parent cannot write is refused, not widened", () => {
  const f = fixture();
  assert.throws(
    () => childContractForWorker(f.parent, worker(f.outside)),
    (err: unknown) =>
      err instanceof WorkerScopeError && /not inside the parent contract's write roots/.test(err.message),
  );
  // A mutating role under a parent that granted no writes is refused outright —
  // demoting it silently would give it write tools its contract then denies.
  const noWrites = parseContract({ ...f.parent, mode: "review", writeRoots: [], externalEffects: [] });
  assert.throws(
    () => childContractForWorker(noWrites, worker(f.worktree)),
    (err: unknown) =>
      err instanceof WorkerScopeError && /intends to write but the parent contract is review/.test(err.message),
  );
});

test("a parent with no tool allowlist is not widened implicitly (narrowContract invariants hold)", () => {
  const f = fixture();
  const child = childContractForWorker(f.parent, worker(f.worktree));
  assert.equal(child.allowedTools, undefined); // parent never granted one → child has none either
  assert.throws(() => childContractForWorker(f.parent, worker(f.worktree, { taskId: "" })), /taskId/);
});

test("the derived contract is published host-side and protects the parent's files", () => {
  const f = fixture();
  const child = childContractForWorker(f.parent, worker(f.worktree));
  const file = workerContractFile(f.state, f.worktree, "worker:implementer:abc");
  materializeWorkerContract(child, file);
  const published = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(published).filter((k) => !CONTRACT_FIELDS.includes(k as (typeof CONTRACT_FIELDS)[number])),
    [],
  );
  assert.equal(published.mode, "implementation");
  // Reading it back through the same provider the worker session uses, the
  // parent contract and the decision log are never writable by the worker.
  const back = new FileContractProvider(file, [f.parentFile, f.log]).current();
  assert.ok(back.protectedPaths?.includes(f.parentFile), "parent contract protected");
  assert.ok(back.protectedPaths?.includes(f.log), "decision log protected");
  assert.ok(back.protectedPaths?.includes(file), "own contract protected");
});

test("the worker session loads only the gate, and it enforces the narrowed scope", async () => {
  const f = fixture();
  const child = childContractForWorker(f.parent, worker(f.worktree));
  const file = materializeWorkerContract(child, workerContractFile(f.state, f.worktree, "worker:implementer:abc"));
  const result = await workerGateExtensions(file, { mode: "enforce_all" }, [f.parentFile], f.worktree, f.agentDir);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const handlers = result.extensions[0]!.handlers.get("tool_call");
  assert.ok(handlers && handlers.length === 1, "the gate registered a tool_call handler");
  const call = (toolName: string, input: unknown) =>
    handlers[0]!({ toolName, toolCallId: "tc", input } as never, { cwd: f.worktree } as never) as
      | { block?: boolean; reason?: string }
      | undefined;
  const escape = call("read", { path: join(f.outside, "secret.txt") });
  assert.equal(escape?.block, true);
  assert.match(escape?.reason ?? "", /outside the permitted read roots/);
  assert.equal(call("read", { path: join(f.repo, "peaks.py") }), undefined);
});

test("workerSessionGate: off in an ungated parent, narrowed contract when gated", async () => {
  const f = fixture();
  const env = {
    PI_TASK_DISCIPLINE: "enforce_all",
    PI_TASK_CONTRACT_FILE: f.parentFile,
    PI_TASK_DISCIPLINE_LOG: f.log,
    PI_ENGINEERING_STATE_DIR: f.state,
  } as NodeJS.ProcessEnv;
  const gated = await workerSessionGate(
    worker(f.worktree, { taskId: workerTaskId({ role: "implementer", task: "fix" }) }),
    f.agentDir,
    env,
  );
  assert.ok(gated);
  assert.equal(gated.child.parentTaskId, f.parent.taskId);
  assert.deepEqual(gated.child.externalEffects, []);
  assert.equal(readFileSync(gated.file, "utf8").includes('"mode": "implementation"'), true);
  assert.equal(gated.extensions.extensions.length, 1);
  // The refusal is surfaced instead of an ungated worker.
  await assert.rejects(
    () => workerSessionGate(worker(f.outside), f.agentDir, env),
    (err: unknown) => err instanceof WorkerScopeError,
  );
  assert.equal(await workerSessionGate(worker(f.worktree), f.agentDir, {} as NodeJS.ProcessEnv), undefined);
});
