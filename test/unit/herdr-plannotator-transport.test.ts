import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PlanTaskInput } from "../../src/orchestration/orchestrator.ts";
import { MemoryPlanLedger, canonicalPlanText, planDigestOf } from "../../src/orchestration/planRecords.ts";
import { gatePlanBeforeWorkers } from "../../src/orchestration/planReview.ts";
import { createHerdrPlannotatorTransport } from "../../src/platform/HerdrPlannotatorTransport.ts";
import { PlannotatorAdapter } from "../../src/platform/Plannotator.ts";

/** A fake `herdr-plannotator` executable; BEHAVIOR is JS run with (planFile, planBytes, digest). */
function fakeCli(behavior: string): { dir: string; log: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-plannotator-"));
  const log = join(dir, "log.json");
  const bin = join(dir, "herdr-plannotator");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs"), crypto = require("crypto");
const argv = process.argv.slice(2);
const planFile = argv[argv.indexOf("--plan-file") + 1];
const bytes = fs.readFileSync(planFile);
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, text: bytes.toString("utf8"), digest, mode: fs.statSync(planFile).mode & 0o777, gitEnv: Object.keys(process.env).filter(k => k.startsWith("GIT_") || k === "SECRET_TOKEN") }));
${behavior}
`,
  );
  chmodSync(bin, 0o755);
  return { dir, log, bin };
}
const task: PlanTaskInput = {
  kind: "agent",
  role: "implementer",
  objective: "change login token handling; $(touch /tmp/pwned) `x`",
  mutates_repo: true,
  write_domains: ["src/auth/**"],
  isolation: "worktree",
  depends_on: [],
  priority: 0,
  execution_requirements: {},
  acceptance_ids: [],
  deliverables: ["implementation"],
  checkpoint_policy: { activity_milestone: 5, before_deadline_ms: 30_000 },
  max_attempts: 3,
  failure_policy: "retry",
};
const text = canonicalPlanText("goal", [task]);
const digest = planDigestOf(text);
const proposal = {
  runId: "M1",
  planRef: "p",
  goal: "goal",
  riskClass: "high" as const,
  planDigest: digest,
  planText: text,
  revision: 2,
};
const out = (o: object) => `process.stdout.write(JSON.stringify(${JSON.stringify(o)}) + "\\n");`;

describe("HerdrPlannotatorTransport", () => {
  it("approved: passes exact plan bytes by argv (no shell), echoes digest, scrubs secrets", async () => {
    process.env.SECRET_TOKEN = "x";
    const cli = fakeCli(out({ decision: "approved", feedback: "", review_id: "rev_1" }));
    const t = createHerdrPlannotatorTransport({
      command: "herdr-plannotator",
      searchPath: cli.dir,
      args: ["--control-plane", "http://cp.invalid"],
    });
    const r = await t.submitPlan(proposal);
    delete process.env.SECRET_TOKEN;
    assert.equal(r.decision, "approved");
    assert.equal(r.externalDecisionId, "rev_1");
    const seen = JSON.parse(readFileSync(cli.log, "utf8"));
    assert.equal(seen.text, text);
    assert.equal(seen.digest, digest, "the bridge would hash the same bytes Pi digested");
    assert.equal(seen.mode, 0o600);
    assert.deepEqual(seen.argv.slice(0, 1), ["plan"]);
    assert.ok(seen.argv.includes("http://cp.invalid"));
    assert.ok(!seen.argv.some((a: string) => a.includes("pwned")), "plan text is never in argv");
    assert.deepEqual(seen.gitEnv, []);
  });

  it("annotated and denied map to changes requested with the feedback", async () => {
    for (const decision of ["annotated", "denied"]) {
      const cli = fakeCli(out({ decision, feedback: "split it" }));
      const r = await createHerdrPlannotatorTransport({ command: cli.bin }).submitPlan(proposal);
      assert.equal(r.decision, "annotated");
      assert.deepEqual(r.annotations, ["split it"]);
    }
  });

  it("dismissed, crash, malformed, oversized output and timeout are unavailable (throw)", async () => {
    const cases: Array<[string, string, RegExp, number?]> = [
      ["dismissed", out({ decision: "dismissed" }), /dismissed/],
      ["crash", "process.exit(3);", /status 3/],
      ["malformed", 'process.stdout.write("not json at all");', /no JSON object/],
      ["unsupported", out({ decision: "maybe" }), /unsupported/],
      ["flood", 'process.stdout.write("a".repeat(5000));', /exceeded the limit/],
      ["timeout", "setTimeout(() => {}, 60000);", /timed out after 300ms/],
    ];
    for (const [name, behavior, re] of cases) {
      const cli = fakeCli(behavior);
      const t = createHerdrPlannotatorTransport({ command: cli.bin, timeoutMs: 300, maxOutputBytes: 1000 });
      await assert.rejects(t.submitPlan(proposal), re, name);
    }
  });

  it("a missing CLI and a plan whose text does not match its digest never launch", async () => {
    await assert.rejects(
      createHerdrPlannotatorTransport({ command: "no-such-plannotator", searchPath: "/nonexistent" }).submitPlan(
        proposal,
      ),
      /not installed or is not on PATH/,
    );
    const cli = fakeCli(out({ decision: "approved" }));
    await assert.rejects(
      createHerdrPlannotatorTransport({ command: cli.bin }).submitPlan({ ...proposal, planText: `${text}tampered` }),
      /does not match its digest/,
    );
    assert.throws(() => readFileSync(cli.log), "the CLI was not run");
  });

  it("through the gate: digest echo mismatch blocks require; matching echo approves; unavailable blocks", async () => {
    const run = async (behavior: string, timeoutMs = 5000) => {
      const cli = fakeCli(behavior);
      const adapter = new PlannotatorAdapter({
        transport: createHerdrPlannotatorTransport({ command: cli.bin, timeoutMs }),
      });
      return gatePlanBeforeWorkers({
        missionId: "MG",
        goal: "goal",
        plan: async () => [task],
        ledger: new MemoryPlanLedger(),
        adapter,
      });
    };
    const mismatch = await run(out({ decision: "approved", plan_digest: "f".repeat(64) }));
    assert.equal(mismatch.status === "blocked" && mismatch.code, "digest_mismatch");
    const ok = await run(
      'process.stdout.write(JSON.stringify({decision:"approved", plan_digest: digest, review_id:"r"}));',
    );
    assert.equal(ok.status, "proceed");
    assert.equal(ok.status === "proceed" && ok.outcome, "approved");
    const crash = await run("process.exit(1);");
    assert.equal(crash.status === "blocked" && crash.code, "plannotator_unavailable");
  });
});
