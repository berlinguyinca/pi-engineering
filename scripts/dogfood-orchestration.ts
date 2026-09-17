#!/usr/bin/env node
/**
 * Deterministic orchestration dogfood (spec 00/02/03/05/06/07/08).
 *
 * Drives the REAL EngineeringRuntime orchestration path over an isolated git
 * fixture with a deterministic worker + the real CommandVerifier, and asserts
 * the observable guarantees that matter:
 *
 *   1. normal-language engineering intent auto-routes to engineering_review
 *      and the policy engine attaches validation + independent review gates;
 *   2. the mission runs to COMPLETE with validation + review tasks recorded;
 *   3. a mutating, worktree-isolated task executes in a DEDICATED git worktree,
 *      not the main checkout (spec 05 safe isolation);
 *   4. a blocking reviewer finding BLOCKS completion and yields repair work
 *      (enforcement, not a prompt);
 *   5. pure investigation intent does not mutate the repository;
 *   6. the versioned PI WEB mission snapshot is published (spec 08);
 *   7. mission/task state SURVIVES an orchestrator restart over the same repo.
 *
 * Exit 0 = every guarantee proved. Runs without a live model, so it is
 * CI-safe and used as roadmap dogfood evidence.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EngineeringRuntime } from "../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../src/verify/Verifier.ts";

const exec = promisify(execFile);

const failures: string[] = [];
let checks = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A deterministic worker that reports completion and can emit review findings. */
function makeWorker(findings: unknown[] = [], onRun?: (cwd: string, role: string) => void) {
  return {
    async run(req: { role: string; task: string; cwd?: string }) {
      onRun?.(req.cwd ?? "", req.role);
      return {
        result: {
          status: "completed" as const,
          summary: `worker ${req.role} did ${req.task}`,
          claims: [{ claim: "implemented", evidence: "artifact://dogfood" }],
          evidence_refs: ["artifact://dogfood"],
          new_hypotheses: [],
          proposed_tasks: [],
          details: findings.length ? { findings } : {},
        },
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 100,
          turns: 1,
          model: "deterministic",
        },
        toolCalls: 1,
      };
    },
  };
}

async function makeRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-dogfood-"));
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "dogfood@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Dogfood"]);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      { name: "dogfood", version: "1.0.0", private: true, type: "module", scripts: { test: "node --test" } },
      null,
      2,
    ),
  );
  await writeFile(join(root, "README.md"), "# dogfood fixture\n");
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-qm", "init"]);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function open(root: string, findings: unknown[] = [], onRun?: (cwd: string, role: string) => void) {
  return EngineeringRuntime.open({
    cwd: root,
    worker: makeWorker(findings, onRun) as never,
    verifier: new CommandVerifier(),
  });
}

const cleanupFns: Array<() => Promise<void>> = [];
try {
  // ---- 1 + 2 + 6: engineering intent auto-routes, completes with gates, publishes snapshot
  console.log("\n[1] auto-routed engineering mission");
  const fx = await makeRepo();
  cleanupFns.push(fx.cleanup);
  const rt = await open(fx.root);
  const baseRef = await rt.git!.headCommit();
  const res = await rt.orchestrator!.orchestrate("Add a health endpoint to the server", {
    repository: rt.cwd,
    baseRef,
    mutationRequested: true,
  });
  check("intent classified as implement", res.intent.intent.includes("implement"), res.intent.intent.join(","));
  check(
    "workflow auto-routed to engineering_review",
    res.mission.workflow_class === "engineering_review",
    res.mission.workflow_class,
  );
  check(
    "policy attached validation gate",
    res.mission.required_gates.includes("validation"),
    res.mission.required_gates.join(","),
  );
  check(
    "policy attached independent_review gate",
    res.mission.required_gates.includes("independent_review"),
    res.mission.required_gates.join(","),
  );
  check("mission reached COMPLETE", res.completed && res.mission.status === "COMPLETE", res.mission.status);
  const tasks = rt.missionStore!.listTasks(res.mission.mission_id);
  check("tasks were recorded", tasks.length > 0, String(tasks.length));

  // ---- 6: versioned PI WEB snapshot published
  const snap = await rt.publishMissionSnapshot();
  check("snapshot published with contractVersion 1", snap?.contractVersion === 1, String(snap?.contractVersion));
  check("snapshot contains the mission", (snap?.missions.length ?? 0) >= 1);
  const onDisk = JSON.parse(await readFile(join(rt.workDir, "orchestration-snapshot.json"), "utf8")) as {
    missions: Array<{ status: string }>;
  };
  check(
    "snapshot readable on disk where the PI WEB plugin reads it",
    onDisk.missions[0]?.status === "COMPLETE",
    String(onDisk.missions[0]?.status),
  );

  // ---- 7: state survives restart over the same repo
  console.log("\n[2] restart recovery over the same repo");
  await rt.missionStore!.flush();
  const rt2 = await open(fx.root);
  const restored = rt2.missionStore!.getMission(res.mission.mission_id);
  check("mission restored after restart", !!restored);
  check("restored status is COMPLETE", restored?.status === "COMPLETE", restored?.status);
  check(
    "restored task count matches",
    rt2.missionStore!.listTasks(res.mission.mission_id).length === tasks.length,
    `${rt2.missionStore!.listTasks(res.mission.mission_id).length} vs ${tasks.length}`,
  );

  // ---- 3: mutating isolated task ran in a dedicated git worktree
  console.log("\n[3] mutating task isolation (spec 05)");
  const wtFx = await makeRepo();
  cleanupFns.push(wtFx.cleanup);
  const observedCwd: string[] = [];
  const wtRt = await open(wtFx.root, [], (cwd) => observedCwd.push(cwd));
  const executionBroker = wtRt.orchestrator!.broker;
  const handle = await executionBroker.execute({
    taskId: "dogfood-task",
    missionId: "dogfood-mission",
    kind: "agent",
    role: "implementer",
    objective: "mutate",
    mutatesRepo: true,
    isolation: "worktree",
  });
  await handle.result();
  check("the worker actually ran somewhere", observedCwd.length === 1, JSON.stringify(observedCwd));
  check(
    "worker ran in an isolated worktree, not the main checkout",
    observedCwd[0] !== wtFx.root && observedCwd[0]!.length > 0,
    `${observedCwd[0]} vs ${wtFx.root}`,
  );
  check(
    "worktree released after settlement",
    executionBroker.allocatedWorktrees.size === 0,
    String(executionBroker.allocatedWorktrees.size),
  );

  // ---- 4: blocking review finding blocks completion + creates repair work
  console.log("\n[4] blocking reviewer finding (spec 07 enforcement)");
  const rFx = await makeRepo();
  cleanupFns.push(rFx.cleanup);
  const rRt = await open(rFx.root, [
    {
      severity: "blocking",
      summary: "auth bypass: token not verified",
      category: "security",
      file: "src/a.ts",
      line: 1,
    },
  ]);
  const rBase = await rRt.git!.headCommit();
  const rRes = await rRt.orchestrator!.orchestrate("Fix the login bug", {
    repository: rRt.cwd,
    baseRef: rBase,
    mutationRequested: true,
  });
  check("mission did NOT complete with a blocking finding", !rRes.completed, rRes.mission.status);
  const findings = rRt.missionStore!.listFindings(rRes.mission.mission_id);
  check(
    "blocking finding recorded",
    findings.some((f) => f.severity === "blocking"),
    JSON.stringify(findings.map((f) => f.severity)),
  );
  const afterTasks = rRt.missionStore!.listTasks(rRes.mission.mission_id);
  check(
    "repair work created by the finding",
    afterTasks.length > tasks.length || afterTasks.some((t) => t.role.includes("repair")),
    `${afterTasks.length} tasks`,
  );

  // ---- 5: pure investigation does not mutate
  console.log("\n[5] investigation intent stays read-only");
  const iFx = await makeRepo();
  cleanupFns.push(iFx.cleanup);
  const iRt = await open(iFx.root);
  const iBase = await iRt.git!.headCommit();
  const iRes = await iRt.orchestrator!.orchestrate("Why is login failing?", {
    repository: iRt.cwd,
    baseRef: iBase,
    mutationRequested: false,
  });
  const iTasks = iRt.missionStore!.listTasks(iRes.mission.mission_id);
  check(
    "investigation intent routed away from engineering",
    iRes.mission.workflow_class === "investigation",
    iRes.mission.workflow_class,
  );
  check(
    "investigation created no mutating tasks",
    !iTasks.some((t) => t.mutates_repo),
    JSON.stringify(iTasks.map((t) => [t.kind, t.mutates_repo])),
  );
} catch (err) {
  failures.push(`threw: ${err instanceof Error ? err.message : String(err)}`);
  console.error("dogfood threw:", err);
} finally {
  for (const fn of cleanupFns) await fn().catch(() => {});
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.error("FAILED:", failures.join(" | "));
  process.exit(1);
}
console.log("ORCHESTRATION DOGFOOD OK");
