/**
 * The reviewer reads the change it judges, a slip in its acceptance IDs does not
 * void the review, unreadable output re-runs the review (never implementer
 * repair), and a green validation run passes the test-like criteria. Real HTTP
 * servers stand in for the model route; a real verifier runs the suite.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import type { ModelRef } from "../../src/lifecycle/types.ts";
import { realBackends, testCriteriaPassed } from "../../src/orchestration/realBackends.ts";
import { FailureClassifier, classifyGateFailure } from "../../src/orchestration/recovery.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

const model: ModelRef = { provider: "hive", id: "glm-5.3-flash" };
const CRITERIA = [
  { acceptanceId: "AC-1", criterion: "greeting is printed" },
  { acceptanceId: "AC-2", criterion: "tests cover the greeting" },
];
const CONTEXT = "## Diff (git diff aaa..bbb)\n+console.log('hello-marker-7731')";

async function review(
  reply: Record<string, unknown>,
  extra: { worktree?: string; bashFirst?: boolean; command?: string; candidateSha?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-ctx-int-"));
  const bodies: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      bodies.push(body);
      if (extra.bashFirst && !body.includes('"role":"tool"')) {
        const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          frame({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_bash",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: extra.command ?? "echo changed > mutated.txt" }),
                },
              },
            ],
          }),
        );
        res.write(frame({}, "tool_calls"));
        res.end("data: [DONE]\n\n");
        return;
      }
      const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        frame({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_0",
              type: "function",
              function: { name: "review_result", arguments: JSON.stringify(reply) },
            },
          ],
        }),
      );
      res.write(frame({}, "tool_calls"));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        hive: {
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: model.id, contextWindow: 100_000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const worker = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: true, maxRetries: 1, jitterMs: 0 }),
    admission: new AdmissionController({ maxConcurrency: 2, jitterMs: 0 }),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  const backends = realBackends({
    worker,
    verifier: {} as never,
    artifacts: { readContentByUri: async () => undefined } as never,
    git: null,
    cwd: dir,
    routeModel: async () => model,
  });
  try {
    const outcome = await backends.review.runReview({
      objective: "review",
      contextRef: CONTEXT,
      worktree: extra.worktree,
      candidateSha: extra.candidateSha,
      acceptanceCriteria: CRITERIA,
      missionId: "MSN-1",
      signal: new AbortController().signal,
    });
    return { outcome, bodies };
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const base = { verdict: "approve", summary: "fine", findings: [], missing_tests: [], spec_gaps: [] };

test("the reviewer's prompt carries the change context and it can read files and run bash", async () => {
  const { outcome, bodies } = await review({
    ...base,
    acceptance_results: [
      { acceptance_id: "AC-1", status: "passed", detail: "ok" },
      { acceptance_id: "AC-2", status: "passed", detail: "ok" },
    ],
  });
  assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
  const request = bodies[0] ?? "";
  assert.match(request, /hello-marker-7731/);
  const tools = (JSON.parse(request) as { tools: Array<{ function: { name: string } }> }).tools.map(
    (tool) => tool.function.name,
  );
  for (const name of ["read", "bash", "review_result"]) assert.ok(tools.includes(name), name);
});

test("mangled, duplicate and invented acceptance IDs do not invalidate the review", async () => {
  const { outcome } = await review({
    ...base,
    acceptance_results: [
      { acceptance_id: "ac 1", status: "passed", detail: "printed" },
      { acceptance_id: "AC-1", status: "failed", detail: "dup" },
      { acceptance_id: "AC-77", status: "passed", detail: "invented" },
    ],
  });
  const evidence = outcome.reviewEvidence;
  assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
  assert.equal(evidence?.outputValid, true);
  assert.deepEqual(evidence?.acceptanceResults, [
    { acceptanceId: "AC-1", status: "passed", detail: "printed" },
    { acceptanceId: "AC-2", status: "failed", detail: "not reported by reviewer" },
  ]);
  assert.ok(evidence?.findings.some((f) => f.severity === "minor" && /AC-77/.test(f.summary)));
});

test("unreadable review output fails the attempt and classifies as a gate re-run, not repair", async () => {
  const { outcome } = await review({
    ...base,
    findings: [{ severity: "high", title: "", detail: "a finding with no title is unreadable" }],
    acceptance_results: [],
  });
  assert.equal(outcome.exitStatus, "failed");
  assert.equal(outcome.reviewEvidence?.outputValid, false);
  assert.deepEqual(outcome.findings, []);
  const classification = classifyGateFailure(
    new FailureClassifier(),
    "review",
    { missionId: "MSN-1", taskId: "TSK-1", summary: `failed: ${outcome.summary}` },
    outcome,
  );
  assert.equal(classification.category, "PROVIDER_TRANSIENT");
});

test("a green validation passes test-like criteria and leaves the rest to the reviewer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-validation-accept-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const backends = realBackends({
      worker: {} as never,
      verifier: new CommandVerifier(),
      artifacts: await ArtifactStore.create(join(dir, ".artifacts")),
      git: null,
      cwd: dir,
    });
    const outcome = await backends.validation.runValidation({
      objective: "validate",
      acceptanceCriteria: CRITERIA,
      signal: new AbortController().signal,
    });
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.deepEqual(
      outcome.validationEvidence?.acceptanceResults?.map((r) => [r.acceptanceId, r.status]),
      [["AC-2", "passed"]],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty acceptance_results list is invalid output, not every criterion failed", async () => {
  const { outcome } = await review({ ...base, acceptance_results: [] });
  assert.equal(outcome.exitStatus, "failed");
  assert.equal(outcome.reviewEvidence?.outputValid, false);
  assert.match(outcome.error ?? "", /^INVALID_WORKER_OUTPUT: .*acceptance_results/);
});

test("acceptance warnings are minor open findings that never block", async () => {
  const { outcome } = await review({
    ...base,
    acceptance_results: [
      { acceptance_id: "AC-1", status: "passed", detail: "ok" },
      { acceptance_id: "AC-9", status: "passed", detail: "invented" },
    ],
  });
  const warning = outcome.reviewEvidence?.findings.filter((f) => /AC-9/.test(f.summary)) ?? [];
  assert.equal(warning.length, 1);
  assert.equal(warning[0]?.severity, "minor");
  assert.equal(outcome.reviewEvidence?.findings.filter((f) => f.severity === "blocking").length, 0);
  assert.deepEqual(outcome.findings, [], "warnings never reach the mission's findings, so they spawn no repair");
});

test("validation stage names decide whether a green run proves test criteria", () => {
  const criteria = [
    { acceptanceId: "AC-LATEST-1", criterion: "page loads" },
    { acceptanceId: "AC-CONTEST", criterion: "page loads" },
    { acceptanceId: "AC-TEST-2", criterion: "page loads" },
    { acceptanceId: "AC-3", criterion: "Tests must cover the greeting" },
    { acceptanceId: "AC-4", criterion: "greeting is printed" },
  ];
  const run = (name: string, passed = true) => ({ stage: { name }, passed });
  assert.deepEqual(
    testCriteriaPassed(criteria, [run("typecheck"), run("test")], []).map((r) => r.acceptanceId),
    ["AC-TEST-2", "AC-3"],
  );
  assert.deepEqual(testCriteriaPassed(criteria, [run("typecheck"), run("lint")], []), [], "no test stage ran");
  assert.deepEqual(testCriteriaPassed(criteria, [run("test", false)], []), [], "the test stage failed");
  assert.deepEqual(testCriteriaPassed(criteria, [run("test")], ["suite was red at base"]), [], "inherited failures");
  assert.equal(testCriteriaPassed(criteria, [run("test:unit")], [])[0]?.detail.includes("exit 0"), false);
});

test("a lint-only profile does not pass test criteria even when green", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-validation-lint-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "t", version: "1.0.0", scripts: { lint: 'node -e "process.exit(0)"' } }),
    );
    const backends = realBackends({
      worker: {} as never,
      verifier: new CommandVerifier(),
      artifacts: await ArtifactStore.create(join(dir, ".artifacts")),
      git: null,
      cwd: dir,
    });
    const outcome = await backends.validation.runValidation({
      objective: "validate",
      acceptanceCriteria: CRITERIA,
      signal: new AbortController().signal,
    });
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.deepEqual(outcome.validationEvidence?.acceptanceResults, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reviewer that commits or writes through bash is rejected and the candidate is unchanged", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-review-mutate-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const head = git("rev-parse", "HEAD");
  const results = [
    { acceptance_id: "AC-1", status: "passed", detail: "ok" },
    { acceptance_id: "AC-2", status: "passed", detail: "ok" },
  ];
  const { outcome } = await review(
    { ...base, acceptance_results: results },
    { worktree: repo, bashFirst: true, candidateSha: head },
  );
  try {
    assert.equal(outcome.exitStatus, "failed");
    assert.equal(outcome.reviewEvidence?.outputValid, false);
    assert.match(outcome.error ?? "", /^INVALID_WORKER_OUTPUT: reviewer mutated the candidate/);
    assert.equal(
      classifyGateFailure(
        new FailureClassifier(),
        "review",
        { missionId: "M", taskId: "T", summary: outcome.error ?? "" },
        outcome,
      ).category,
      "PROVIDER_TRANSIENT",
    );
    assert.equal(git("status", "--porcelain"), "", "the worktree is restored to the candidate");
    assert.equal(git("rev-parse", "HEAD"), head);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a reviewer that commits through bash is rejected too", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-review-commit-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const head = git("rev-parse", "HEAD");
  try {
    const { outcome } = await review(
      {
        ...base,
        acceptance_results: [
          { acceptance_id: "AC-1", status: "passed", detail: "ok" },
          { acceptance_id: "AC-2", status: "passed", detail: "ok" },
        ],
      },
      {
        worktree: repo,
        bashFirst: true,
        candidateSha: head,
        command: "git -c user.name=x -c user.email=x@x commit -q --allow-empty -m sneaky",
      },
    );
    assert.match(git("reflog"), /sneaky/, "the reviewer really moved HEAD");
    assert.equal(git("rev-parse", "HEAD"), head, "and the worktree was put back on the candidate");
    assert.equal(outcome.exitStatus, "failed");
    assert.match(outcome.error ?? "", /reviewer mutated the candidate/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

for (const [name, command] of [
  ["a written file", "echo changed > mutated.txt"],
  ["a commit", "git -c user.name=x -c user.email=x@x commit -q --allow-empty -m sneaky"],
] as const) {
  test(`a retry after a reviewer mutation (${name}) starts from the recorded candidate`, async () => {
    const repo = mkdtempSync(join(tmpdir(), "pi-review-retry-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const candidate = git("rev-parse", "HEAD");
    const results = [
      { acceptance_id: "AC-1", status: "passed", detail: "ok" },
      { acceptance_id: "AC-2", status: "passed", detail: "ok" },
    ];
    try {
      const first = await review(
        { ...base, acceptance_results: results },
        { worktree: repo, bashFirst: true, command, candidateSha: candidate },
      );
      assert.equal(first.outcome.exitStatus, "failed");
      assert.match(first.outcome.error ?? "", /reviewer mutated the candidate/);
      const second = await review(
        { ...base, acceptance_results: results },
        { worktree: repo, candidateSha: candidate },
      );
      assert.equal(second.outcome.exitStatus, "succeeded", second.outcome.summary);
      assert.equal(git("rev-parse", "HEAD"), candidate);
      assert.equal(git("status", "--porcelain", "--ignored"), "");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test("changed refs and planted hooks are detected, ignored-file writes are removed", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-review-wide-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const candidate = git("rev-parse", "HEAD");
  const results = [
    { acceptance_id: "AC-1", status: "passed", detail: "ok" },
    { acceptance_id: "AC-2", status: "passed", detail: "ok" },
  ];
  try {
    for (const [command, reason, probe] of [
      ["git branch evil", /git refs changed/, () => git("branch", "--list", "evil")],
      ["echo x > .git/hooks/pre-commit", /hooks or config/, () => "x"],
      ["echo x > ignored.log", /ignored files/, () => (existsSync(join(repo, "ignored.log")) ? "present" : "")],
    ] as const) {
      const { outcome } = await review(
        { ...base, acceptance_results: results },
        { worktree: repo, bashFirst: true, command, candidateSha: candidate },
      );
      assert.equal(outcome.exitStatus, "failed", command);
      assert.match(outcome.error ?? "", reason, command);
      if (command.includes("ignored.log")) assert.equal(probe(), "", "the new ignored file was removed");
      else assert.notEqual(probe(), "", "refs and hooks are detected, not restored");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
