import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyWork, riskRank, specialistRoles } from "../../src/lifecycle/classification.ts";
import {
  classifyCommand,
  commandFromToolInput,
  gateOperation,
  isMutatingTool,
} from "../../src/lifecycle/destructive.ts";
import { DEFAULT_POLICY, deepMerge, loadPolicy, validatePolicy } from "../../src/lifecycle/policy.ts";

async function temp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("default policy is internally valid", () => {
  const issues = validatePolicy(structuredClone(DEFAULT_POLICY)).filter((i) => i.severity === "error");
  assert.deepEqual(issues, []);
});

test("policy layers merge with repository config weakening non-mandatory keys", async () => {
  const cwd = await temp("pi-eng-pol-");
  const agentDir = await temp("pi-eng-pol-agent-");
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "engineering.yaml"),
      [
        "version: 1",
        "lifecycle:",
        "  max_remediation_rounds: 5",
        "routing:",
        "  provider_priority:",
        "    - ollama",
        "  roles:",
        "    reviewer:",
        "      model: ollama/llama3",
        "policies:",
        "  review:",
        "    max_blocking_findings_to_pass: 0",
      ].join("\n"),
    );
    const loaded = await loadPolicy({ cwd, agentDir, env: { HOME: agentDir } as NodeJS.ProcessEnv });
    assert.equal(loaded.policy.lifecycle.max_remediation_rounds, 5);
    assert.deepEqual(loaded.policy.routing.provider_priority, ["ollama"]);
    assert.equal(loaded.policy.routing.roles.reviewer?.model, "ollama/llama3");
    assert.equal(loaded.policy.policies.review.max_blocking_findings_to_pass, 0);
    // Untouched keys keep defaults.
    assert.equal(loaded.policy.lifecycle.automatic, DEFAULT_POLICY.lifecycle.automatic);
    assert.ok(loaded.sources.some((s) => s.endsWith(join(".pi", "engineering.yaml"))));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("mandatory global keys cannot be weakened by repository config", async () => {
  const cwd = await temp("pi-eng-pol-m-");
  const agentDir = await temp("pi-eng-pol-m-agent-");
  try {
    await mkdir(join(agentDir, ""), { recursive: true });
    await writeFile(
      join(agentDir, "engineering.yaml"),
      [
        "mandatory:",
        "  - policies.completion_gate.require.independent_review_pass",
        "  - policies.risk.pre_execution_approval_at",
        "policies:",
        "  completion_gate:",
        "    require:",
        "      independent_review_pass: true",
        "  risk:",
        "    pre_execution_approval_at: HIGH",
      ].join("\n"),
    );
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "engineering.yaml"),
      [
        "policies:",
        "  completion_gate:",
        "    require:",
        "      independent_review_pass: false",
        "  risk:",
        "    pre_execution_approval_at: CRITICAL",
      ].join("\n"),
    );
    const loaded = await loadPolicy({ cwd, agentDir, env: { HOME: agentDir } as NodeJS.ProcessEnv });
    assert.equal(loaded.policy.policies.completion_gate.require.independent_review_pass, true);
    assert.equal(loaded.policy.policies.risk.pre_execution_approval_at, "HIGH");
    assert.ok(loaded.issues.some((i) => /kept mandatory/i.test(i.message)));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("session override outranks repository config and an invalid layer is reported", async () => {
  const cwd = await temp("pi-eng-pol-s-");
  const agentDir = await temp("pi-eng-pol-s-agent-");
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "engineering.yaml"), "lifecycle:\n  max_remediation_rounds: 2\n");
    const loaded = await loadPolicy({
      cwd,
      agentDir,
      env: { HOME: agentDir } as NodeJS.ProcessEnv,
      sessionOverride: {
        lifecycle: { max_remediation_rounds: 9 },
        policies: { risk: { pre_execution_approval_at: "NOPE" } },
      },
    });
    assert.equal(loaded.policy.lifecycle.max_remediation_rounds, 9);
    assert.ok(loaded.issues.some((i) => /pre_execution_approval_at/.test(i.path) && i.severity === "error"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("deepMerge replaces arrays rather than concatenating them", () => {
  const merged = deepMerge({ a: [1, 2, 3], b: { c: 1 } }, { a: [9], b: { d: 2 } });
  assert.deepEqual(merged, { a: [9], b: { c: 1, d: 2 } });
});

test("classification maps paths, intent and diff content to work categories and risk", () => {
  const feature = classifyWork({
    request: "Implement a new user profile endpoint",
    files: [
      { path: "src/api/users.ts", added: true, deleted: false },
      { path: "src/api/users.test.ts", added: true, deleted: false },
    ],
    diffExcerpt: "+ router.post('/users', create)",
  });
  assert.ok(feature.categories.includes("api"));
  assert.ok(feature.categories.includes("test"));
  assert.ok(feature.risk === "NORMAL" || feature.risk === "HIGH");
  assert.ok(feature.specialists.includes("api_reviewer"));
  assert.ok(feature.specialists.includes("test_reviewer"));

  const docs = classifyWork({
    request: "Clarify the README install section",
    files: [{ path: "README.md", added: false, deleted: false }],
  });
  assert.ok(docs.categories.includes("docs"));
  assert.equal(docs.risk, "LOW");
  assert.deepEqual(docs.planTriggers, []);

  const database = classifyWork({
    request: "Add a migration for the orders table",
    files: [{ path: "db/migrations/0001_orders.sql", added: true, deleted: false }],
  });
  assert.ok(database.categories.includes("database"));
  assert.ok(database.categories.includes("migration"));
  assert.ok(database.specialists.includes("database_reviewer"));
  assert.ok(database.planTriggers.includes("data_model"), "schema changes are plan-triggering work");
});

test("classification raises risk for security, infrastructure and destructive signals", () => {
  const security = classifyWork({
    request: "Fix the authentication token validation",
    files: [{ path: "src/auth/token.ts", added: false, deleted: false }],
  });
  assert.ok(security.categories.includes("security") || security.categories.includes("auth"));
  assert.ok(riskRank(security.risk) >= riskRank(classifyWork({ request: "typo", files: [] }).risk));

  const infra = classifyWork({
    request: "Deploy the service",
    files: [{ path: "infra/main.tf", added: true, deleted: false }],
    commands: ["terraform apply -auto-approve"],
  });
  assert.ok(infra.categories.includes("infra"));
  assert.ok(infra.specialists.includes("infrastructure_reviewer"));
  assert.ok(infra.planTriggers.includes("infra"));

  const large = classifyWork({
    request: "Refactor the parser",
    files: Array.from({ length: 25 }, (_unused, i) => ({ path: `src/parser/f${i}.ts`, added: false, deleted: false })),
    changedLines: 1400,
  });
  assert.ok(large.planTriggers.includes("large_change"), "a large refactor needs a recorded plan");
});

test("specialist roles follow categories and escalate with risk", () => {
  const low = specialistRoles(["docs"], "LOW");
  assert.ok(!low.includes("security_reviewer"));
  const high = specialistRoles(["security", "database"], "HIGH");
  assert.ok(high.includes("security_reviewer"));
  assert.ok(high.includes("database_reviewer"));
});

test("destructive commands are gated, never blanket-disabled", () => {
  const policy = structuredClone(DEFAULT_POLICY).policies.risk;

  const ssh = classifyCommand("ssh deploy@host 'systemctl restart myapp'", policy);
  assert.equal(ssh.remote, true);
  assert.ok(ssh.risk === "HIGH" || ssh.risk === "CRITICAL");
  assert.ok(ssh.capability && policy.preserve_capabilities.includes(ssh.capability));
  const sshGate = gateOperation("ssh deploy@host 'systemctl restart myapp'", policy);
  assert.notEqual(sshGate.decision, "deny");

  const ansible = gateOperation("ansible-playbook -i inventory site.yml", policy);
  assert.equal(ansible.classification.capability, "ansible");
  assert.ok(ansible.classification.categories.includes("remote_administration"));
  assert.notEqual(ansible.decision, "deny");

  const install = gateOperation("dnf install -y nginx", policy);
  assert.equal(install.classification.capability, "package manager");
  assert.ok(
    install.decision === "allow" || install.decision === "review_after" || install.decision === "require_approval",
  );

  // A read-only command is never gated.
  const read = gateOperation("git status --porcelain", policy);
  assert.equal(read.decision, "allow");
  assert.equal(read.classification.risk, "LOW");

  // Irreversible destruction requires approval.
  const wipe = gateOperation("rm -rf /", policy);
  assert.equal(wipe.classification.risk, "CRITICAL");
  assert.equal(wipe.decision, "require_approval");

  const dropTable = gateOperation("psql -c 'DROP TABLE customers'", policy);
  assert.equal(dropTable.classification.risk, "CRITICAL");
  assert.equal(dropTable.decision, "require_approval");

  const forcePush = gateOperation("git push --force origin main", policy);
  assert.equal(forcePush.classification.risk, "CRITICAL");
});

test("operator command_risk overrides raise or lower risk", () => {
  const policy = structuredClone(DEFAULT_POLICY).policies.risk;
  policy.command_risk = [{ pattern: "^make deploy-staging$", risk: "CRITICAL" }];
  assert.equal(classifyCommand("make deploy-staging", policy).risk, "CRITICAL");
  assert.equal(gateOperation("make deploy-staging", policy).decision, "require_approval");
});

test("mutating tools are recognised and shell commands are extracted from tool input", () => {
  assert.equal(isMutatingTool("bash"), true);
  assert.equal(isMutatingTool("write"), true);
  assert.equal(isMutatingTool("read"), false);
  assert.equal(
    commandFromToolInput({ command: "kubectl rollout restart deploy/api" }),
    "kubectl rollout restart deploy/api",
  );
  assert.equal(commandFromToolInput({ command: "kubectl version" }), "kubectl version");
  assert.equal(commandFromToolInput({ path: "src/x.ts" }), undefined);
  assert.equal(commandFromToolInput("kubectl version"), undefined, "a plain string is not a tool input record");
});
