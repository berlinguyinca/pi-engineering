import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { EngineeringRuntime, GitRepo } from "../../src/index.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { VerificationProvider } from "../../src/verify/Verifier.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

function modelChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mission-checkpoint",
    object: "chat.completion.chunk",
    created: 0,
    model: "local",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function modelTool(res: ServerResponse, name: string, args: Record<string, unknown>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    modelChunk({
      role: "assistant",
      tool_calls: [
        { index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    }),
  );
  res.write(modelChunk({}, "tool_calls"));
  res.end("data: [DONE]\n\n");
}

async function checkpointModelProbe(): Promise<{
  baseUrl: string;
  requests: () => number;
  close: () => Promise<void>;
}> {
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requests++;
      const body = Buffer.concat(chunks).toString("utf8");
      if (requests === 1) {
        modelTool(res, "bash", {
          command:
            "mkdir -p src && printf 'export const one = 1;\\n' > src/one.js && printf 'export const two = 2;\\n' > src/two.js && git add -A && git commit -q -m 'checkpoint two of three' && git rev-parse HEAD",
        });
        return;
      }
      if (requests === 2) {
        const candidateSha = body.match(/[0-9a-f]{40}/g)?.at(-1);
        assert.ok(candidateSha, `bash tool result did not expose a candidate SHA: ${body.slice(-1000)}`);
        modelTool(res, "checkpoint_progress", {
          claims: [
            { deliverable: "one", candidate_sha: candidateSha, evidence_paths: ["src/one.js"] },
            { deliverable: "two", candidate_sha: candidateSha, evidence_paths: ["src/two.js"] },
          ],
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(modelChunk({ role: "assistant", content: "waiting past the broker deadline" }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

function reviewAcceptance(task: string) {
  return [...task.matchAll(/Acceptance criterion ([^:]+):/g)].map((match) => ({
    acceptanceId: match[1]!,
    status: "passed" as const,
    detail: "fresh same-model session checked the current candidate",
  }));
}

function workerFor(implement: (cwd: string) => Promise<void>, reviewWarnings: string[] = []): WorkerExecutor {
  return {
    async run(request) {
      if (request.role === "implementer") await implement(request.cwd!);
      if (request.role === "reviewer") {
        reviewWarnings.push("same-model review used a fresh session with reduced independence");
      }
      return {
        result: {
          status: "completed",
          summary: `${request.role} completed`,
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 1,
          turns: 1,
          model: "local/local",
        },
        toolCalls: 0,
        structured:
          request.resultTool === "review_result"
            ? {
                verdict: "approve",
                findings: [],
                missingTests: [],
                specGaps: [],
                acceptanceResults: reviewAcceptance(request.task),
                summary: "approved in a fresh same-model session",
              }
            : undefined,
      };
    },
  };
}

async function greenFixture() {
  const fixture = await makeFixtureRepo();
  await writeFile(join(fixture.root, "src", "add.js"), "export function add(a, b) { return a + b; }\n");
  await exec("git", ["-C", fixture.root, "add", "-A"]);
  await exec("git", ["-C", fixture.root, "commit", "-q", "-m", "green baseline"]);
  return fixture;
}

async function repositoryState(root: string) {
  const [head, indexTree, status, tracked, untracked] = await Promise.all([
    exec("git", ["-C", root, "rev-parse", "HEAD"]),
    exec("git", ["-C", root, "write-tree"]),
    exec("git", ["-C", root, "status", "--porcelain=v2", "-z"]),
    exec("git", ["-C", root, "ls-files", "-z"]),
    exec("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const files = [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean))].sort();
  const worktree = Object.fromEntries(
    await Promise.all(
      files.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(root, path)))
          .digest("hex"),
      ]),
    ),
  );
  return { head: head.stdout.trim(), indexTree: indexTree.stdout.trim(), status: status.stdout, worktree };
}

async function fakeInstalledPi(status = "COMPLETE") {
  const directory = await mkdtemp(join(resolve(process.cwd(), ".."), "pi-eng-fake-installed-"));
  const installed = join(directory, "installed");
  const executable = join(directory, "pi.mjs");
  const log = join(directory, "args.jsonl");
  await mkdir(installed);
  await writeFile(join(installed, "package.json"), '{"name":"pi-engineering-runtime"}\n');
  await exec("git", ["init", "-q", installed]);
  await exec("git", ["-C", installed, "config", "user.email", "fake@example.invalid"]);
  await exec("git", ["-C", installed, "config", "user.name", "Fake Pi"]);
  await exec("git", ["-C", installed, "add", "package.json"]);
  await exec("git", ["-C", installed, "commit", "-q", "-m", "installed"]);
  const sha = (await exec("git", ["-C", installed, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
await appendFile(process.env.FAKE_ARGS_LOG, JSON.stringify(args) + "\\n");
if (args.join(" ") === "--no-extensions --list-models" || args[0] === "--list-models") { process.stdout.write("local local ready\\n"); process.exit(0); }
if (args.join(" ") === "--no-extensions list") { process.stdout.write(process.env.FAKE_INSTALLED_PATH + "\\n"); process.exit(0); }
await mkdir(join(process.cwd(), ".pi-eng"), { recursive: true });
if (process.env.FAKE_SNAPSHOT_MODE === "missing") process.exit(0);
if (process.env.FAKE_SNAPSHOT_MODE === "malformed") {
  await writeFile(join(process.cwd(), ".pi-eng", "orchestration-snapshot.json"), JSON.stringify({ contractVersion: 3, generatedAt: 42, missions: [{ id: "MSN-bad", revision: -1, status: "COMPLETE", observability: { acceptanceCoverage: { completed: "1", total: 1 } } }] }));
  process.exit(0);
}
const snapshot = {
  contractVersion: 3,
  generatedAt: new Date().toISOString(),
  missions: [{
    id: "MSN-fake-dogfood", revision: 7, title: "fake", goal: "fake", workflowClass: "engineering_review",
    status: ${JSON.stringify(status)}, riskProfile: "high", constraints: [], requiredGates: [],
    acceptanceCriteria: [{ id: "AC-fake", criterion: "dogfood completes", status: "passed" }], tasks: [], findings: [],
    observability: {
      progress: { approximatePercent: 100, verifiedComplete: true, basis: "weighted_dag" },
      acceptanceCoverage: { completed: 1, total: 1, approximatePercent: 100 },
      workflowProgress: { completed: 1, total: 1, approximatePercent: 100, basis: "weighted_dag" },
      health: "complete", workers: { active: 0, waiting: 0, failed: 0 }, lastMeaningfulProgressAt: new Date().toISOString(),
      completionStatus: "verified_complete", progressHistory: [], tests: { running: false, completed: 1, total: 1, passed: 1, failed: 0, skipped: 0, failures: [] },
      review: { status: "completed", blockingOpen: 0, findings: [] }, workerDetails: [], activity: [], errors: [], recovery: [], changes: { changedFiles: [], commits: [], integrationState: "complete" }, artifacts: [],
      action: "done", reason: "verified", recoveryAttempt: { attempt: 0, maxAttempts: 2 }, nextAction: "none", nextActionAt: null, owner: null, repository: process.cwd(), task: null, preservedWork: [process.cwd()]
    }
  }]
};
if (process.env.FAKE_SNAPSHOT_MODE === "acceptance-not-passed") snapshot.missions[0].acceptanceCriteria[0].status = "pending";
if (process.env.FAKE_SNAPSHOT_MODE === "acceptance-coverage") snapshot.missions[0].observability.acceptanceCoverage.total = 2;
if (process.env.FAKE_SNAPSHOT_MODE === "test-accounting") snapshot.missions[0].observability.tests.passed = 0;
if (process.env.FAKE_SNAPSHOT_MODE === "test-failed") { snapshot.missions[0].observability.tests.passed = 0; snapshot.missions[0].observability.tests.failed = 1; }
if (process.env.FAKE_SNAPSHOT_MODE === "review-findings") snapshot.missions[0].observability.review.findings = [{ id: "F-open", severity: "blocking", status: "open", summary: "open", repaired: false }];
if (process.env.FAKE_SNAPSHOT_MODE === "review-incomplete") snapshot.missions[0].observability.review.status = "running";
if (process.env.FAKE_SNAPSHOT_MODE === "review-invalid-severity") snapshot.missions[0].observability.review.findings = [{ id: "F-invalid", severity: "critical", status: "resolved", summary: "invalid", repaired: true }];
if (process.env.FAKE_SNAPSHOT_MODE === "review-invalid-status") snapshot.missions[0].observability.review.findings = [{ id: "F-invalid", severity: "major", status: "closed", summary: "invalid", repaired: false }];
if (process.env.FAKE_SNAPSHOT_MODE === "review-accepted-blocker") snapshot.missions[0].observability.review.findings = [{ id: "F-accepted", severity: "blocking", status: "accepted", summary: "still blocks", repaired: false }];
if (process.env.FAKE_SNAPSHOT_MODE === "review-resolved-not-repaired") snapshot.missions[0].observability.review.findings = [{ id: "F-resolved", severity: "major", status: "resolved", summary: "resolved", repaired: false }];
if (process.env.FAKE_SNAPSHOT_MODE === "review-open-repaired") snapshot.missions[0].observability.review.findings = [{ id: "F-open", severity: "major", status: "open", summary: "open", repaired: true }];
if (process.env.FAKE_SNAPSHOT_MODE === "top-finding-invalid-severity") snapshot.missions[0].findings = [{ id: "F-invalid", severity: "critical", status: "resolved", summary: "invalid", taskId: null, repaired: true }];
if (process.env.FAKE_SNAPSHOT_MODE === "top-finding-invalid-status") snapshot.missions[0].findings = [{ id: "F-invalid", severity: "major", status: "closed", summary: "invalid", taskId: null, repaired: false }];
if (process.env.FAKE_SNAPSHOT_MODE === "top-finding-resolved-not-repaired") snapshot.missions[0].findings = [{ id: "F-resolved", severity: "major", status: "resolved", summary: "invalid", taskId: null, repaired: false }];
if (process.env.FAKE_SNAPSHOT_MODE === "top-finding-accepted-blocker") {
  const finding = { id: "F-accepted", severity: "blocking", status: "accepted", summary: "still blocks", taskId: null, repaired: false };
  snapshot.missions[0].findings = [finding];
  snapshot.missions[0].observability.review.findings = [{ id: finding.id, severity: finding.severity, status: finding.status, summary: finding.summary, repaired: finding.repaired }];
  snapshot.missions[0].observability.review.blockingOpen = 1;
}
if (process.env.FAKE_SNAPSHOT_MODE === "top-finding-projection-mismatch") {
  snapshot.missions[0].findings = [{ id: "F-authoritative", severity: "major", status: "open", summary: "authoritative", taskId: null, repaired: false }];
  snapshot.missions[0].observability.review.findings = [{ id: "F-projected", severity: "major", status: "open", summary: "projected", repaired: false }];
}
await writeFile(join(process.cwd(), ".pi-eng", "orchestration-snapshot.json"), JSON.stringify(snapshot));
`,
  );
  await chmod(executable, 0o755);
  return { directory, installed, executable, log, sha, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function createMission(store: MissionStore, missionId: string, repository = "/tmp/repo") {
  return store.createMission({
    mission_id: missionId,
    title: "mission reliability proof",
    goal: "finish bounded work",
    user_request: "finish bounded work",
    repository,
    base_ref: "base-sha",
    risk_profile: "high",
    workflow_class: "engineering_review",
  });
}

function transitionToExecuting(store: MissionStore, missionId: string): void {
  for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
    store.transitionMission(missionId, status);
  }
}

async function blockedCheckpointHarness(
  roots: [string, string],
  checkpointArtifacts?: { store: ArtifactStore; refs: string[]; hashes: string[] },
) {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const git = (await GitRepo.open(roots[0]))!;
  const baseSha = await git.headCommit();
  const mission = createMission(store, "MSN-qSLaeM", roots[0]);
  store.bindWorkspaceManifest({
    manifestId: "WM-qSLaeM",
    missionId: mission.mission_id,
    generation: 1,
    authorizedRoots: roots.map((canonicalPath) => ({
      canonicalPath,
      source: "explicit_user_path" as const,
      access: "write" as const,
    })),
    // Slice 1 authorizes multiple roots but executes one repository per task.
    // Cross-repository dependency/promotion coordination remains Slice 2.
    repositories: [
      {
        repoId: "repo-1",
        canonicalRoot: roots[0],
        baseRef: "main",
        baseSha,
        writableDomains: ["src/**"],
      },
    ],
    dependencyEdges: [],
    hash: "manifest-qSLaeM",
    createdAt: "2026-09-27T00:00:00.000Z",
  });
  transitionToExecuting(store, mission.mission_id);
  const task = store.createTask({
    task_id: "TSK-qSLaeM-original",
    mission_id: mission.mission_id,
    repo_id: "repo-1",
    kind: "agent",
    role: "implementer",
    objective: "finish one, two, and three",
    deliverables: ["one", "two", "three"],
    mutates_repo: false,
    max_attempts: 1,
  });
  store.transitionTask(task.task_id, "READY");
  const execution = store.createExecution({
    task_id: task.task_id,
    mission_id: mission.mission_id,
    backend: "agent",
    repo_id: "repo-1",
    base_sha: baseSha,
    checkpoint_id: "CHK-qSLaeM",
    mission_generation: 0,
    candidate_generation: 0,
    fencing_token: 0,
  });
  store.transitionTask(task.task_id, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
  store.setExecutionStatus(execution.execution_id, "RUNNING");
  store.transitionTask(task.task_id, "FAILED", "system", { failure_reason: "task execution budget exhausted" });
  store.checkpointTask({
    checkpointId: "CHK-qSLaeM",
    executionId: execution.execution_id,
    missionId: mission.mission_id,
    taskId: task.task_id,
    repoId: "repo-1",
    baseSha,
    candidateSha: "checkpoint-sha",
    branch: "pi-eng-orch-TSK-qSLaeM-original",
    worktree: "/tmp/preserved-qSLaeM",
    committedChanges: ["one"],
    preservedUncommittedChanges: [],
    completedDeliverables: ["one"],
    remainingDeliverables: ["two", "three"],
    acceptanceIds: [],
    validationEvidenceRefs: [],
    artifactRefs: checkpointArtifacts?.refs ?? [],
    artifactHashes: checkpointArtifacts?.hashes ?? [],
    workerId: "worker-old",
    sessionId: "session-old",
    model: "local/local",
    sequence: 1,
    missionGeneration: 0,
    candidateGeneration: 0,
    fencingToken: 0,
    createdAt: "2026-09-27T00:00:00.000Z",
  });
  store.classifyFailure({
    classificationId: "FC-qSLaeM-budget",
    missionId: mission.mission_id,
    taskId: task.task_id,
    executionId: execution.execution_id,
    category: "TASK_BUDGET_EXHAUSTED",
    evidenceRefs: ["CHK-qSLaeM"],
    fingerprint: "sha256:qSLaeM-budget",
    summary: "task execution budget exhausted after checkpoint",
    classifiedAt: "2026-09-27T00:00:01.000Z",
  });
  store.transitionMission(mission.mission_id, "BLOCKED");
  const reviewSessions: string[] = [];
  let replacementDispatches = 0;
  const orchestrator = new Orchestrator({
    store,
    backends: {
      agent: {
        runAgent: async () => {
          replacementDispatches++;
          return {
            executionId: "replacement",
            exitStatus: "succeeded",
            summary: "remaining deliverable completed",
            artifactRefs: [],
            usage: {},
          };
        },
      },
      validation: {
        runValidation: async () => ({
          executionId: "validation",
          exitStatus: "succeeded",
          summary: "current candidate validated",
          artifactRefs: [],
          usage: {},
        }),
      },
      review: {
        runReview: async () => {
          reviewSessions.push("fresh-session:same-model-reduced:local/local");
          return {
            executionId: "review",
            exitStatus: "succeeded",
            summary: "approved with reduced-independence warning",
            artifactRefs: [],
            usage: {},
          };
        },
      },
    },
    planner: async () => [],
    git,
    artifacts: checkpointArtifacts?.store,
    recovery: { missionCeiling: 4, strategyMaxAttempts: 2, decisionTtlMs: 60_000 },
    now: () => Date.parse("2026-09-27T00:00:10.000Z"),
  });
  return {
    backend,
    store,
    mission,
    task,
    execution,
    orchestrator,
    reviewSessions,
    replacementDispatches: () => replacementDispatches,
  };
}

describe("mission reliability foundation — synthetic MSN-qSLaeM", () => {
  it(
    "runs MSN-qSLaeM through the public runtime, times out after 2/3, and repairs only the remainder",
    { timeout: 30_000 },
    async () => {
      const metaRoot = await mkdtemp(join(tmpdir(), "pi-eng-meta-root-"));
      const first = await greenFixture();
      const second = await greenFixture();
      let runtime: EngineeringRuntime | undefined;
      let releaseLate!: () => void;
      const late = new Promise<void>((resolveLate) => {
        releaseLate = resolveLate;
      });
      const sessions: Array<{ role: string; session: string | undefined; recovery: boolean }> = [];
      let initial = true;
      let initialPiRun: WorkerRun | undefined;
      let modelProbe: Awaited<ReturnType<typeof checkpointModelProbe>> | undefined;
      try {
        const repoId = `repo-${createHash("sha256").update(first.root).digest("hex").slice(0, 16)}`;
        modelProbe = await checkpointModelProbe();
        const agentDir = join(metaRoot, "agent");
        await mkdir(agentDir, { recursive: true });
        await writeFile(
          join(agentDir, "settings.json"),
          JSON.stringify({ extensions: ["-extensions/qwen-turing.ts"] }),
        );
        await writeFile(
          join(agentDir, "models.json"),
          JSON.stringify({
            providers: {
              local: {
                baseUrl: modelProbe.baseUrl,
                api: "openai-completions",
                apiKey: "local-test",
                models: [{ id: "local", contextWindow: 256_000, maxTokens: 32_768 }],
              },
            },
          }),
        );
        const verifier: VerificationProvider = {
          async detect() {
            return { name: "synthetic-current-candidate", stages: [] };
          },
          async run() {
            return { passed: true, noTargets: false, stages: [], failedStage: null, evidence: [] };
          },
        };
        class ScenarioWorker extends PiWorkerExecutor {
          override async run(request: WorkerRequest): Promise<WorkerRun> {
            sessions.push({ role: request.role, session: request.sessionId, recovery: Boolean(request.recovery) });
            if (request.role === "reviewer") {
              return {
                result: {
                  status: "completed",
                  summary: "fresh same-model review",
                  claims: [],
                  evidence_refs: [],
                  new_hypotheses: [],
                  proposed_tasks: [],
                  details: {},
                },
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  contextTokens: 1,
                  turns: 1,
                  model: "local/local",
                },
                toolCalls: 0,
                structured: {
                  verdict: "approve",
                  findings: [],
                  missingTests: [],
                  specGaps: [],
                  acceptanceResults: reviewAcceptance(request.task),
                  summary: "current candidate approved",
                },
              };
            }
            if (initial) {
              initial = false;
              initialPiRun = await super.run({ ...request, modelOverride: { provider: "local", id: "local" } });
              await late;
              return {
                result: {
                  status: "completed",
                  summary: "late obsolete completion",
                  claims: [],
                  evidence_refs: [],
                  new_hypotheses: [],
                  proposed_tasks: [],
                  details: {},
                },
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  contextTokens: 1,
                  turns: 1,
                  model: "local/local",
                },
                toolCalls: 0,
              };
            }
            assert.ok(request.recovery, "replacement worker receives store-verified checkpoint recovery context");
            assert.match(request.task, /remaining deliverable three/i);
            await writeFile(join(request.cwd, "src", "three.js"), "export const three = 3;\n");
            return {
              result: {
                status: "completed",
                summary: "remainder completed",
                claims: [],
                evidence_refs: [],
                new_hypotheses: [],
                proposed_tasks: [],
                details: {},
              },
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 1,
                turns: 1,
                model: "local/local",
              },
              toolCalls: 0,
            };
          }
        }
        const worker: WorkerExecutor = new ScenarioWorker({
          agentDir,
          model: {
            provider: "local",
            id: "local",
            name: "local",
            api: "openai-completions",
            baseUrl: modelProbe.baseUrl,
            apiKey: "local-test",
            contextWindow: 256_000,
            maxTokens: 32_768,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          } as never,
          aps: false,
          gatewayConfig: resolveGatewayConfig({ enabled: false }),
          transientSleep: async () => {},
          transientRand: () => 0,
        });
        runtime = await EngineeringRuntime.open({
          cwd: metaRoot,
          workDir: join(metaRoot, "state"),
          model: {
            provider: "local",
            id: "local",
            api: "openai-completions",
            contextWindow: 256_000,
            maxTokens: 32_768,
          } as never,
          worker,
          verifier,
          orchestrationPlanner: async (mission) => [
            {
              kind: "agent",
              role: "implementer",
              objective: "finish one, two, and three",
              repo_id: repoId,
              mutates_repo: true,
              write_domains: ["src/**"],
              isolation: "worktree",
              depends_on: [],
              priority: 0,
              execution_requirements: {},
              acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
                criterion.acceptance_id ? [criterion.acceptance_id] : [],
              ),
              deliverables: ["one", "two", "three"],
              execution_budget_ms: 1_000,
              checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 200 },
              max_attempts: 1,
              failure_policy: "block",
            },
          ],
        });
        const base = (await GitRepo.open(first.root))!;
        const started = await runtime.orchestrator!.orchestrate(
          `Ensure all three modules are current and verified. Work in ${first.root} and authorize ${second.root}.`,
          { repository: first.root, baseRef: await base.headCommit(), mutationRequested: true },
        );
        assert.equal(started.mission.status, "BLOCKED");
        assert.deepEqual(
          runtime
            .missionStore!.getWorkspaceManifest(started.mission.mission_id)!
            .authorizedRoots.map((root) => root.canonicalPath),
          [first.root, second.root],
        );
        const missionTasks = runtime.missionStore!.listTasks(started.mission.mission_id);
        const original = missionTasks.find((task) => task.objective === "finish one, two, and three");
        assert.ok(
          original,
          JSON.stringify({ status: started.mission.status, failure: started.failureReason, missionTasks }),
        );
        const checkpoint = runtime
          .missionStore!.listTaskCheckpoints(started.mission.mission_id, original.task_id)
          .at(-1)!;
        assert.deepEqual(
          checkpoint.completedDeliverables,
          ["one", "two"],
          JSON.stringify({
            requests: modelProbe.requests(),
            sessions,
            initialPiRun,
            executions: runtime.missionStore!.listExecutions(started.mission.mission_id),
            findings: runtime.missionStore!.listFindings(started.mission.mission_id),
            checkpoint,
          }),
        );
        assert.deepEqual(checkpoint.remainingDeliverables, ["three"]);
        assert.ok(modelProbe.requests() >= 3, "the real Pi executor reached checkpoint_progress before timing out");
        releaseLate();
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        assert.ok(runtime.missionStore!.getExecution(checkpoint.executionId)?.status !== "SUCCEEDED");
        assert.throws(
          () => runtime!.missionStore!.assertExecutionAuthoritative(checkpoint.executionId),
          /no longer authoritative|stale execution identity/i,
        );
        const durableEvents = await readFile(join(metaRoot, "state", "orchestration.jsonl"), "utf8");
        assert.match(durableEvents, /"type":"execution\.late_result_rejected"/);
        const repaired = await runtime.orchestrator!.repairBlockedMission(started.mission.mission_id);
        const replacements = runtime
          .missionStore!.listTasks(started.mission.mission_id)
          .filter((task) => task.objective.startsWith("Recover "));
        assert.deepEqual(
          replacements.map((task) => task.deliverables),
          [["three"]],
          JSON.stringify({
            repaired,
            tasks: runtime.missionStore!.listTasks(started.mission.mission_id),
            classifications: runtime.missionStore!.listFailureClassifications(started.mission.mission_id),
            recoveries: runtime.missionStore!.listRecoveryDecisions(started.mission.mission_id),
          }),
        );
        assert.ok(["COMPLETE", "BLOCKED"].includes(repaired.status));
        if (repaired.status === "BLOCKED") {
          const stop = runtime.missionStore!.listMissionStops(started.mission.mission_id).at(-1);
          assert.ok(stop?.reason);
          assert.ok(stop?.resumeCondition);
          assert.ok(stop?.preservedWork.length);
          assert.ok(stop?.attemptedRecoveries.length);
        }
        const candidate = runtime.missionStore!.getCandidate(started.mission.mission_id)!;
        const validation = runtime.missionStore!.listValidationEvidence(started.mission.mission_id).at(-1)!;
        const review = runtime.missionStore!.listReviewEvidence(started.mission.mission_id).at(-1)!;
        assert.equal(validation.identityHash, candidate.identityHash);
        assert.equal(validation.exitCode, 0);
        assert.equal(validation.noTargets, false);
        assert.equal(review.identityHash, candidate.identityHash);
        assert.equal(review.verdict, "approve");
        assert.equal(review.outputValid, true);
        assert.equal(review.accessible, true);
        assert.equal(review.independenceMode, "same_model_reduced", JSON.stringify(review));
        const implementerSession = sessions.find((entry) => entry.role === "implementer")?.session;
        const reviewerSession = sessions.find((entry) => entry.role === "reviewer")?.session;
        assert.ok(implementerSession && reviewerSession && implementerSession !== reviewerSession);
      } finally {
        releaseLate();
        await runtime?.close();
        await modelProbe?.close();
        await Promise.all([rm(metaRoot, { recursive: true, force: true }), first.cleanup(), second.cleanup()]);
      }
    },
  );

  it("keeps the incumbent unchanged when integration conflicts", async () => {
    const fixture = await greenFixture();
    const state = await mkdtemp(join(tmpdir(), "pi-eng-conflict-state-"));
    let runtime: EngineeringRuntime | undefined;
    try {
      const git = (await GitRepo.open(fixture.root))!;
      const base = await git.headCommit();
      await writeFile(
        join(fixture.root, "src", "add.js"),
        "export function add(a, b) { return a + b; // incumbent\n}\n",
      );
      await exec("git", ["-C", fixture.root, "add", "-A"]);
      await exec("git", ["-C", fixture.root, "commit", "-q", "-m", "incumbent divergence"]);
      const incumbent = await git.headCommit();
      const incumbentState = await repositoryState(fixture.root);
      runtime = await EngineeringRuntime.open({
        cwd: fixture.root,
        workDir: state,
        worker: workerFor(async (cwd) => {
          await writeFile(join(cwd, "src", "add.js"), "export function add(a, b) { return a + b; // worker\n}\n");
        }),
      });

      const result = await runtime.orchestrator!.orchestrate("Annotate add", {
        repository: fixture.root,
        baseRef: base,
        mutationRequested: true,
      });

      assert.equal(result.completed, false);
      assert.equal(await git.headCommit(), incumbent);
      assert.match(await readFile(join(fixture.root, "src", "add.js"), "utf8"), /incumbent/);
      assert.deepEqual(await repositoryState(fixture.root), incumbentState);
    } finally {
      await runtime?.close();
      await rm(state, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  it("records a fresh same-model review with the reduced-independence warning", async () => {
    const fixture = await greenFixture();
    let runtime: EngineeringRuntime | undefined;
    try {
      runtime = await EngineeringRuntime.open({
        cwd: fixture.root,
        model: {
          provider: "local",
          id: "local",
          api: "openai-completions",
          contextWindow: 256_000,
          maxTokens: 32_768,
        } as never,
        worker: workerFor(async (cwd) => {
          await writeFile(join(cwd, "src", "reviewed.js"), "export const reviewed = true;\n");
        }),
      });
      const baseRef = await runtime.git!.headCommit();

      const result = await runtime.orchestrator!.orchestrate("Add reviewed module", {
        repository: fixture.root,
        baseRef,
        mutationRequested: true,
      });
      const evidence = runtime.missionStore!.listReviewEvidence(result.mission.mission_id).at(-1);

      assert.equal(result.completed, true, result.failureReason ?? "");
      assert.equal(evidence?.independenceMode, "same_model_reduced");
      assert.equal(evidence?.model, "local");
      assert.equal(evidence?.provider, "local");
      assert.ok(evidence?.reviewerSessionId);
    } finally {
      await runtime?.close();
      await fixture.cleanup();
    }
  });

  it("keeps the incumbent unchanged when current-candidate validation is red", async () => {
    const fixture = await greenFixture();
    const state = await mkdtemp(join(tmpdir(), "pi-eng-red-state-"));
    let runtime: EngineeringRuntime | undefined;
    try {
      const git = (await GitRepo.open(fixture.root))!;
      const incumbent = await git.headCommit();
      const incumbentState = await repositoryState(fixture.root);
      const redVerifier: VerificationProvider = {
        async detect() {
          return { name: "red", stages: [] };
        },
        async run() {
          return {
            passed: false,
            noTargets: false,
            stages: [],
            failedStage: "test",
            evidence: [],
          };
        },
      };
      runtime = await EngineeringRuntime.open({
        cwd: fixture.root,
        workDir: state,
        verifier: redVerifier,
        worker: workerFor(async (cwd) => {
          await writeFile(join(cwd, "src", "candidate-only.js"), "export const candidateOnly = true;\n");
        }),
      });

      const result = await runtime.orchestrator!.orchestrate("Add candidate-only module", {
        repository: fixture.root,
        baseRef: incumbent,
        mutationRequested: true,
      });

      assert.equal(result.completed, false);
      assert.equal(await git.headCommit(), incumbent);
      await assert.rejects(() => readFile(join(fixture.root, "src", "candidate-only.js"), "utf8"), /ENOENT/);
      assert.deepEqual(await repositoryState(fixture.root), incumbentState);
    } finally {
      await runtime?.close();
      await rm(state, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  it("replays checkpoint, failure fingerprint, and recovery budget after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-eng-mission-restart-"));
    const eventFile = join(directory, "orchestration.jsonl");
    try {
      const first = await JsonlEventStore.open(eventFile);
      const initial = MissionStore.open(first);
      const mission = createMission(initial, "MSN-restart");
      transitionToExecuting(initial, mission.mission_id);
      const task = initial.createTask({
        task_id: "TSK-restart",
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "resume after restart",
        repo_id: "repo-restart",
        deliverables: ["kept", "remaining"],
      });
      initial.transitionTask(task.task_id, "READY");
      const execution = initial.createExecution({
        task_id: task.task_id,
        mission_id: mission.mission_id,
        backend: "agent",
        repo_id: "repo-restart",
        base_sha: "base-sha",
      });
      initial.transitionTask(task.task_id, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
      initial.setExecutionStatus(execution.execution_id, "RUNNING");
      initial.checkpointTask({
        checkpointId: "CHK-restart",
        executionId: execution.execution_id,
        missionId: mission.mission_id,
        taskId: task.task_id,
        repoId: "repo-restart",
        baseSha: "base-sha",
        candidateSha: "checkpoint-sha",
        branch: "pi-eng-orch-TSK-restart",
        worktree: "/tmp/preserved-restart",
        committedChanges: ["kept"],
        preservedUncommittedChanges: [],
        completedDeliverables: ["kept"],
        remainingDeliverables: ["remaining"],
        acceptanceIds: [],
        validationEvidenceRefs: [],
        artifactRefs: [],
        artifactHashes: [],
        workerId: "worker",
        sessionId: "session",
        model: "local/local",
        sequence: 1,
        missionGeneration: 0,
        candidateGeneration: 0,
        fencingToken: 0,
        createdAt: "2026-09-27T00:00:00.000Z",
      });
      initial.classifyFailure({
        classificationId: "FC-restart",
        missionId: mission.mission_id,
        taskId: null,
        executionId: null,
        category: "PROVIDER_TRANSIENT",
        evidenceRefs: [],
        fingerprint: "sha256:restart-fingerprint",
        summary: "provider unavailable",
        classifiedAt: "2026-09-27T00:00:00.000Z",
      });
      initial.planRecovery({
        recoveryId: "RCV-restart-1",
        missionId: mission.mission_id,
        classificationId: "FC-restart",
        action: "PROBE_AND_BACKOFF",
        expectedMaterialChange: "healthy local provider probe",
        attempt: 1,
        maxAttempts: 2,
        deadline: "2026-09-27T00:01:00.000Z",
        nextActionAt: "2026-09-27T00:00:10.000Z",
        status: "planned",
        decidedAt: "2026-09-27T00:00:00.000Z",
        failureFingerprint: "sha256:restart-fingerprint",
      });
      await initial.flush();
      first.close();

      const second = await JsonlEventStore.open(eventFile);
      const replayed = MissionStore.open(second);
      assert.equal(
        replayed.listFailureClassifications(mission.mission_id).at(-1)?.fingerprint,
        "sha256:restart-fingerprint",
      );
      assert.equal(replayed.listRecoveryDecisions(mission.mission_id).at(-1)?.attempt, 1);
      assert.deepEqual(replayed.listTaskCheckpoints(mission.mission_id).at(-1)?.remainingDeliverables, ["remaining"]);
      second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const tamper of ["overwrite", "delete"] as const) {
    it(`rejects recovery before replacement dispatch when checkpoint artifact content is ${tamper === "overwrite" ? "overwritten" : "deleted"}`, async () => {
      const first = await greenFixture();
      const second = await greenFixture();
      const artifactRoot = await mkdtemp(join(tmpdir(), "pi-eng-checkpoint-recovery-artifacts-"));
      try {
        const artifacts = await ArtifactStore.create(artifactRoot);
        const body = "immutable checkpoint evidence";
        const immutable = await artifacts.putImmutable("checkpoint", "CHK-qSLaeM", body, "proof");
        const h = await blockedCheckpointHarness([first.root, second.root], {
          store: artifacts,
          refs: [immutable.uri],
          hashes: [`sha256:${createHash("sha256").update(body).digest("hex")}`],
        });
        if (tamper === "delete") {
          await rm(join(artifactRoot, "checkpoint", `${immutable.id}.txt`));
        } else {
          await writeFile(join(artifactRoot, "checkpoint", `${immutable.id}.txt`), "tampered bytes", "utf8");
        }

        await h.orchestrator.repairBlockedMission(h.mission.mission_id).catch(() => undefined);

        assert.equal(h.replacementDispatches(), 0, "artifact verification must precede recovery dispatch");
        assert.equal(h.store.getMission(h.mission.mission_id)?.status, "BLOCKED");
      } finally {
        await rm(artifactRoot, { recursive: true, force: true });
        await first.cleanup();
        await second.cleanup();
      }
    });
  }

  it("re-verifies checkpoint artifacts after execute returns and immediately before replacement dispatch", async () => {
    const first = await greenFixture();
    const second = await greenFixture();
    const artifactRoot = await mkdtemp(join(tmpdir(), "pi-eng-checkpoint-late-tamper-"));
    try {
      const artifacts = await ArtifactStore.create(artifactRoot);
      const body = "immutable checkpoint evidence";
      const immutable = await artifacts.putImmutable("checkpoint", "CHK-qSLaeM", body, "proof");
      const h = await blockedCheckpointHarness([first.root, second.root], {
        store: artifacts,
        refs: [immutable.uri],
        hashes: [`sha256:${createHash("sha256").update(body).digest("hex")}`],
      });
      const execute = h.orchestrator.broker.execute.bind(h.orchestrator.broker);
      h.orchestrator.broker.execute = async (input) => {
        const handle = await execute(input);
        if (input.kind === "agent" && input.taskId !== h.task.task_id) {
          await writeFile(join(artifactRoot, "checkpoint", `${immutable.id}.txt`), "late tamper", "utf8");
        }
        return handle;
      };

      await h.orchestrator.repairBlockedMission(h.mission.mission_id).catch(() => undefined);

      assert.equal(h.replacementDispatches(), 0, "the final artifact check must precede runAgent without an await gap");
      assert.equal(h.store.getMission(h.mission.mission_id)?.status, "BLOCKED");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("reads current canonical bytes in the true-final synchronous verify-and-dispatch call", async () => {
    const first = await greenFixture();
    const second = await greenFixture();
    const artifactRoot = await mkdtemp(join(tmpdir(), "pi-eng-checkpoint-microtask-tamper-"));
    try {
      const artifacts = await ArtifactStore.create(artifactRoot);
      const body = "immutable checkpoint evidence";
      const immutable = await artifacts.putImmutable("checkpoint", "CHK-qSLaeM", body, "proof");
      const h = await blockedCheckpointHarness([first.root, second.root], {
        store: artifacts,
        refs: [immutable.uri],
        hashes: [`sha256:${createHash("sha256").update(body).digest("hex")}`],
      });
      const originalRead = artifacts.readContentByUri.bind(artifacts);
      let preliminaryReads = 0;
      artifacts.readContentByUri = ((uri: string) => {
        preliminaryReads++;
        return originalRead(uri);
      }) as typeof artifacts.readContentByUri;
      const integrityStore = artifacts as ArtifactStore & {
        verifyAndDispatch<T>(refs: readonly string[], hashes: readonly string[], dispatch: () => T): T;
      };
      const originalFinalRead = integrityStore.verifyAndDispatch.bind(integrityStore);
      let finalReads = 0;
      integrityStore.verifyAndDispatch = ((refs, hashes, dispatch) => {
        finalReads += refs.length;
        writeFileSync(join(artifactRoot, "checkpoint", `${immutable.id}.txt`), "microtask tamper", "utf8");
        return originalFinalRead(refs, hashes, dispatch);
      }) as typeof integrityStore.verifyAndDispatch;
      await h.orchestrator.repairBlockedMission(h.mission.mission_id).catch(() => undefined);

      assert.equal(finalReads, 2, "both concurrently prepared replacements perform a true-final synchronous read");
      assert.equal(preliminaryReads, 2, "each replacement still performs its fail-fast preliminary read");
      assert.equal(h.replacementDispatches(), 0, "tampered recovery bytes must never enter runAgent");
      assert.equal(h.store.getMission(h.mission.mission_id)?.status, "BLOCKED");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("replays checkpoint-owned artifact bytes and verifies them before recovery dispatch", async () => {
    const first = await greenFixture();
    const second = await greenFixture();
    const artifactRoot = await mkdtemp(join(tmpdir(), "pi-eng-checkpoint-replay-artifacts-"));
    try {
      const writer = await ArtifactStore.create(artifactRoot);
      const body = "replay-stable checkpoint evidence";
      const immutable = await writer.putImmutable("checkpoint", "CHK-qSLaeM", body, "proof");
      const replayed = await ArtifactStore.create(artifactRoot);
      const h = await blockedCheckpointHarness([first.root, second.root], {
        store: replayed,
        refs: [immutable.uri],
        hashes: [`sha256:${createHash("sha256").update(body).digest("hex")}`],
      });

      await h.orchestrator.repairBlockedMission(h.mission.mission_id);

      assert.ok(h.replacementDispatches() > 0, "verified replayed evidence permits recovery dispatch");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("stops with preserved work and an exact resume condition when a fingerprint is exhausted", async () => {
    const first = await greenFixture();
    const second = await greenFixture();
    try {
      const h = await blockedCheckpointHarness([first.root, second.root]);
      for (const attempt of [1, 2]) {
        h.store.planRecovery({
          recoveryId: `RCV-qSLaeM-${attempt}`,
          missionId: h.mission.mission_id,
          classificationId: "FC-qSLaeM-budget",
          action: "CHECKPOINT_SPLIT_AND_REPLACE",
          expectedMaterialChange: "split remaining checkpoint work",
          attempt,
          maxAttempts: 2,
          deadline: "2026-09-27T00:01:00.000Z",
          nextActionAt: "2026-09-27T00:00:10.000Z",
          status: "planned",
          decidedAt: "2026-09-27T00:00:00.000Z",
          failureFingerprint: "sha256:qSLaeM-budget",
        });
        h.store.transitionRecovery(`RCV-qSLaeM-${attempt}`, "failed");
      }

      const stopped = await h.orchestrator.repairBlockedMission(h.mission.mission_id);
      const stop = h.store.listMissionStops(h.mission.mission_id).at(-1)!;
      assert.equal(stopped.status, "BLOCKED");
      assert.match(stop.reason, /identical failure fingerprint exhausted/i);
      assert.ok(stop.preservedWork.includes("/tmp/preserved-qSLaeM"));
      assert.deepEqual(stop.attemptedRecoveries, ["RCV-qSLaeM-1", "RCV-qSLaeM-2"]);
      assert.match(stop.resumeCondition, /new material evidence|increase the approved recovery budget/i);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("classifies a nonterminal zero-worker mission as ORPHANED with a scheduled recovery", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const mission = createMission(store, "MSN-zero-worker");
    transitionToExecuting(store, mission.mission_id);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "runnable work",
      repo_id: "repo-orphan",
    });
    store.transitionTask(task.task_id, "READY");
    const observability = new MissionObservability({ backend, store });
    observability.missionCreated(mission.mission_id, mission.title);
    const supervisor = new MissionSupervisor({ store, observability });

    const [status] = await supervisor.tick();

    assert.equal(status?.health, "ORPHANED");
    assert.equal(status?.decision?.action, "FENCE_RECONCILE_AND_RESUME");
    assert.equal(status?.task, task.task_id);
  });

  it("isolates repository authority between two missions without mutating either incumbent", async () => {
    const fixture = await greenFixture();
    try {
      const git = (await GitRepo.open(fixture.root))!;
      const incumbent = await git.headCommit();
      const incumbentState = await repositoryState(fixture.root);
      const store = MissionStore.open(JsonlEventStore.inMemory());
      createMission(store, "MSN-lease-first", fixture.root);
      createMission(store, "MSN-lease-second", fixture.root);
      const ownership = new MissionOwnership(store, { ownerId: "local-controller", leaseMs: 60_000 });
      const firstMission = await ownership.acquire("MSN-lease-first");
      const secondMission = await ownership.acquire("MSN-lease-second");
      await ownership.acquireRepository(firstMission, "repo-shared");

      await assert.rejects(
        () => ownership.acquireRepository(secondMission, "repo-shared"),
        /repo-shared.*MSN-lease-first/i,
      );
      assert.equal(await git.headCommit(), incumbent);
      assert.deepEqual(await repositoryState(fixture.root), incumbentState);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a non-local dogfood model before launching Pi or creating a repository", async () => {
    await assert.rejects(
      () =>
        exec(process.execPath, ["scripts/dogfood-mission-recovery.ts", "--model", "metabolomics/remote"], {
          cwd: process.cwd(),
          env: { ...process.env },
        }),
      (error: unknown) => {
        const failure = error as { stderr?: string };
        assert.match(failure.stderr ?? "", /requires exactly local\/local/i);
        return true;
      },
    );
  });

  it("dogfoods the uniquely installed package and validates the versioned snapshot contract", async () => {
    const fake = await fakeInstalledPi();
    try {
      const result = await exec(
        process.execPath,
        [
          "scripts/dogfood-mission-recovery.ts",
          "--pi",
          fake.executable,
          "--model",
          "local/local",
          "--expected-sha",
          fake.sha,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, FAKE_INSTALLED_PATH: fake.installed, FAKE_ARGS_LOG: fake.log },
        },
      );
      const evidence = JSON.parse(result.stdout) as {
        verificationMode: string;
        installedPackage: string;
        temporaryRepository: string;
        durableEvidence: { missionId: string; contractVersion: number; acceptanceCoverage: { completed: number } };
      };
      const invocations = (await readFile(fake.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const args = invocations.at(-1)!;
      assert.deepEqual(invocations[0], ["--no-extensions", "list"]);
      assert.ok(invocations.findIndex((entry) => entry.includes("--list-models")) > 0);
      assert.equal(evidence.verificationMode, "installed-package");
      assert.equal(evidence.installedPackage, fake.installed);
      assert.equal(evidence.durableEvidence.missionId, "MSN-fake-dogfood");
      assert.equal(evidence.durableEvidence.contractVersion, 3);
      assert.equal(evidence.durableEvidence.acceptanceCoverage.completed, 1);
      assert.equal(
        args.includes("--extension"),
        false,
        "installed verification must not duplicate extension discovery",
      );
      assert.equal(args.includes("--no-extensions"), false);
      await rm(evidence.temporaryRepository, { recursive: true, force: true });
    } finally {
      await fake.cleanup();
    }
  });

  it("labels source-only dogfood and disables extension discovery before loading the source extension", async () => {
    const fake = await fakeInstalledPi();
    try {
      const result = await exec(
        process.execPath,
        ["scripts/dogfood-mission-recovery.ts", "--pi", fake.executable, "--source-only", "--model", "local/local"],
        { cwd: process.cwd(), env: { ...process.env, FAKE_INSTALLED_PATH: fake.installed, FAKE_ARGS_LOG: fake.log } },
      );
      const evidence = JSON.parse(result.stdout) as { verificationMode: string; temporaryRepository: string };
      const invocations = (await readFile(fake.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const args = invocations.at(-1)!;
      assert.deepEqual(invocations[0], ["--no-extensions", "--list-models"]);
      assert.match(evidence.verificationMode, /^source-only/);
      assert.ok(args.indexOf("--no-extensions") >= 0);
      assert.ok(args.indexOf("--extension") > args.indexOf("--no-extensions"));
      await rm(evidence.temporaryRepository, { recursive: true, force: true });
    } finally {
      await fake.cleanup();
    }
  });

  it("refuses a dirty installed package before any extension-loading Pi invocation", async () => {
    const fake = await fakeInstalledPi();
    try {
      await writeFile(join(fake.installed, "untracked.txt"), "dirty\n");
      await assert.rejects(
        () =>
          exec(
            process.execPath,
            ["scripts/dogfood-mission-recovery.ts", "--pi", fake.executable, "--expected-sha", fake.sha],
            {
              cwd: process.cwd(),
              env: { ...process.env, FAKE_INSTALLED_PATH: fake.installed, FAKE_ARGS_LOG: fake.log },
            },
          ),
        /installed package is not clean/i,
      );
      const invocations = (await readFile(fake.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(invocations, [["--no-extensions", "list"]]);
    } finally {
      await fake.cleanup();
    }
  });

  for (const mode of [
    "missing",
    "malformed",
    "acceptance-not-passed",
    "acceptance-coverage",
    "test-accounting",
    "test-failed",
    "review-findings",
    "review-incomplete",
    "review-invalid-severity",
    "review-invalid-status",
    "review-accepted-blocker",
    "review-resolved-not-repaired",
    "review-open-repaired",
    "top-finding-invalid-severity",
    "top-finding-invalid-status",
    "top-finding-resolved-not-repaired",
    "top-finding-accepted-blocker",
    "top-finding-projection-mismatch",
  ] as const) {
    it(`returns nonzero for a ${mode} runtime v3 snapshot`, async () => {
      const fake = await fakeInstalledPi();
      try {
        await assert.rejects(() =>
          exec(
            process.execPath,
            ["scripts/dogfood-mission-recovery.ts", "--pi", fake.executable, "--expected-sha", fake.sha],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                FAKE_INSTALLED_PATH: fake.installed,
                FAKE_ARGS_LOG: fake.log,
                FAKE_SNAPSHOT_MODE: mode,
              },
            },
          ),
        );
      } finally {
        await fake.cleanup();
      }
    });
  }

  it("refuses a temporary parent inside any Git worktree before creating a repository", async () => {
    const fake = await fakeInstalledPi();
    const before = (await readdir(process.cwd())).filter((entry) => entry.startsWith("pi-mission-recovery-dogfood-"));
    try {
      await assert.rejects(
        () =>
          exec(
            process.execPath,
            [
              "scripts/dogfood-mission-recovery.ts",
              "--pi",
              fake.executable,
              "--expected-sha",
              fake.sha,
              "--temp-parent",
              process.cwd(),
            ],
            {
              cwd: process.cwd(),
              env: { ...process.env, FAKE_INSTALLED_PATH: fake.installed, FAKE_ARGS_LOG: fake.log },
            },
          ),
        /refusing temporary parent inside Git worktree/i,
      );
      const after = (await readdir(process.cwd())).filter((entry) => entry.startsWith("pi-mission-recovery-dogfood-"));
      assert.deepEqual(after, before);
    } finally {
      await fake.cleanup();
    }
  });

  it("returns nonzero and retains the temporary path for FAILED or CANCELED dogfood missions", async () => {
    const fake = await fakeInstalledPi("FAILED");
    let retained: string | undefined;
    try {
      await assert.rejects(
        () =>
          exec(
            process.execPath,
            ["scripts/dogfood-mission-recovery.ts", "--pi", fake.executable, "--expected-sha", fake.sha],
            {
              cwd: process.cwd(),
              env: { ...process.env, FAKE_INSTALLED_PATH: fake.installed, FAKE_ARGS_LOG: fake.log },
            },
          ),
        (error: unknown) => {
          const stderr = (error as { stderr?: string }).stderr ?? "";
          assert.match(stderr, /ended FAILED/i);
          assert.match(stderr, /pi-mission-recovery-dogfood-/);
          retained = stderr.match(/(\/[^\s]*pi-mission-recovery-dogfood-[^\s]*)/)?.[1];
          return true;
        },
      );
      assert.ok(retained);
      await rm(retained, { recursive: true, force: true });
    } finally {
      await fake.cleanup();
    }
  });
});
