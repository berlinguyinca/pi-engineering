/**
 * The reviewer reads the change it judges, a slip in its acceptance IDs does not
 * void the review, unreadable output re-runs the review (never implementer
 * repair), and a green validation run passes the test-like criteria. Real HTTP
 * servers stand in for the model route; a real verifier runs the suite.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import type { ModelRef } from "../../src/lifecycle/types.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import { FailureClassifier, classifyGateFailure } from "../../src/orchestration/recovery.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

const model: ModelRef = { provider: "hive", id: "glm-5.3-flash" };
const CRITERIA = [
  { acceptanceId: "AC-1", criterion: "greeting is printed" },
  { acceptanceId: "AC-2", criterion: "tests cover the greeting" },
];
const CONTEXT = "## Diff (git diff aaa..bbb)\n+console.log('hello-marker-7731')";

async function review(reply: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-ctx-int-"));
  const bodies: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      bodies.push(body);
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
  const { outcome, bodies } = await review({ ...base, acceptance_results: [] });
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
