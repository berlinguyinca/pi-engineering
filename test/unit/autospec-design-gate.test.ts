import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  type DesignGateInput,
  designGateChecklist,
  designGateItem,
  evaluateDesignGate,
} from "../../src/integrations/autospec/designGate.ts";
import { DEFAULT_RULE_CLASSES } from "../../src/integrations/autospec/designRuleClasses.ts";
import { evaluateGate } from "../../src/lifecycle/gate.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import type { GateItem } from "../../src/lifecycle/types.ts";

const dir = new URL("../fixtures/autospec-design-gates/", import.meta.url);
const load = (n: string) => JSON.parse(readFileSync(new URL(n, dir), "utf8")) as Record<string, unknown>;
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const bound = (n: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...load(n),
  commit_sha: HEAD,
  ...over,
});
const input = (report: unknown, over: Partial<DesignGateInput> = {}): DesignGateInput => ({
  report,
  headCommit: HEAD,
  uiTouched: true,
  uiUncommitted: false,
  ...over,
});
const rulesFile = new URL("rules.yaml", dir).pathname;

describe("design-gate report -> evidence (real autospec-design-gates.sh output)", () => {
  it("PASS bound to HEAD is passed; the item passes and is required when configured", () => {
    const ev = evaluateDesignGate(input(bound("pass-full.json")));
    assert.equal(ev.state, "passed");
    const item = designGateItem(ev, true);
    assert.equal(item.status, "passed");
    assert.equal(item.required, true);
  });

  it("FAIL bound to HEAD is failed and blocks when required", () => {
    const ev = evaluateDesignGate(input(bound("fail-partial.json")));
    assert.equal(ev.state, "failed");
    assert.deepEqual(ev.failedGates, ["design.tokens.no-raw-color"]);
    assert.equal(designGateItem(ev, true).status, "failed");
    assert.match(designGateItem(ev, true).blockers[0] ?? "", /no-raw-color/);
  });

  it("SKIPPED is `not run`, never a pass, even when bound", () => {
    const ev = evaluateDesignGate(input(bound("skipped.json")));
    assert.equal(ev.state, "not_run");
    assert.equal(designGateItem(ev, true).status, "skipped");
    // skipped_not_ui reported while Pi sees UI files: not run, not n/a.
    const notUi = evaluateDesignGate(input(bound("skipped.json", { reason: "skipped_not_ui" })));
    assert.equal(notUi.state, "not_run");
    assert.equal(designGateItem(notUi, true).status, "skipped");
  });

  it("a missing report is not run; n/a comes only from Pi's own ui_paths", () => {
    const missing = evaluateDesignGate(input(undefined));
    assert.equal(missing.state, "not_run");
    assert.equal(designGateItem(missing, true).status, "skipped");
    const notUi = evaluateDesignGate(input(undefined, { uiTouched: false }));
    assert.equal(notUi.state, "not_applicable");
    assert.equal(designGateItem(notUi, true).status, "not_applicable");
    // A skipped report cannot make a UI change not-applicable.
    assert.notEqual(evaluateDesignGate(input(bound("skipped.json"))).state, "not_applicable");
  });

  it("a report with no commit is unbound; a stale commit is stale; neither can pass or fail the tree", () => {
    const real = load("pass-full.json");
    assert.equal("commit_sha" in real, false, "the real script writes no commit");
    const unbound = evaluateDesignGate(input(real));
    assert.equal(unbound.state, "unbound");
    assert.equal(designGateItem(unbound, true).status, "unavailable");
    const stale = evaluateDesignGate(input(bound("pass-full.json", { commit_sha: OTHER })));
    assert.equal(stale.state, "stale");
    assert.equal(designGateItem(stale, true).status, "unavailable");
    // A stale FAIL is also just stale.
    assert.equal(evaluateDesignGate(input(bound("fail-partial.json", { commit_sha: OTHER }))).state, "stale");
  });

  it("a sidecar commit can bind the report; disagreement with the report is invalid", () => {
    assert.equal(evaluateDesignGate(input(load("pass-full.json"), { sidecarCommit: HEAD })).state, "passed");
    assert.equal(evaluateDesignGate(input(load("pass-full.json"), { sidecarCommit: OTHER })).state, "stale");
    assert.equal(evaluateDesignGate(input(bound("pass-full.json"), { sidecarCommit: OTHER })).state, "invalid");
  });

  it("UI edits made after the report's commit (uncommitted) make it stale", () => {
    const ev = evaluateDesignGate(input(bound("pass-full.json"), { uiUncommitted: true }));
    assert.equal(ev.state, "stale");
    assert.match(ev.reason, /uncommitted/);
  });

  it("malformed or self-contradictory reports are invalid (fail closed)", () => {
    const mutate = (f: (r: Record<string, unknown>) => void, base = "pass-full.json") => {
      const r = bound(base);
      f(r);
      return evaluateDesignGate(input(r)).state;
    };
    assert.equal(evaluateDesignGate(input(null)).state, "invalid");
    assert.equal(evaluateDesignGate(input("PASS")).state, "invalid");
    assert.equal(evaluateDesignGate(input([])).state, "invalid");
    assert.equal(
      mutate((r) => {
        delete r.gates;
      }),
      "invalid",
    );
    assert.equal(
      mutate((r) => {
        r.version = 2;
      }),
      "invalid",
    );
    assert.equal(
      mutate((r) => {
        r.status = "maybe";
      }),
      "invalid",
    );
    assert.equal(
      mutate((r) => {
        r.status_line = "FAIL";
      }),
      "invalid",
      "status_line disagrees with status",
    );
    assert.equal(
      mutate((r) => {
        r.counts = { run: 99, failed: 0, unmapped: 0 };
      }),
      "invalid",
      "counts disagree",
    );
    assert.equal(
      mutate((r) => {
        r.commit_sha = "not-a-sha";
      }),
      "invalid",
    );
    // Top-level status says pass but a blocking gate failed.
    assert.equal(
      mutate((r) => {
        r.status = "pass";
      }, "fail-partial.json"),
      "invalid",
    );
    assert.equal(
      mutate((r) => {
        (r.gates as Array<Record<string, unknown>>)[0]!.status = "weird";
      }),
      "invalid",
    );
    // Cannot claim fail without any failing gate (except the documented strict-unmapped-blocker).
    assert.equal(
      mutate((r) => {
        r.status = "fail";
        r.status_line = "FAIL";
      }),
      "invalid",
    );
  });

  it("the verdict is recomputed from gates[]: a lying `status: pass` cannot hide a failure", () => {
    const r = bound("fail-partial.json");
    r.status = "pass";
    r.status_line = "PASS";
    assert.equal(evaluateDesignGate(input(r)).state, "invalid");
  });

  it("unmapped blocker rules mean the gate did not fully run: incomplete, never passed", () => {
    const ev = evaluateDesignGate(input(bound("pass-partial.json")));
    assert.equal(ev.state, "incomplete");
    assert.ok(ev.unmappedBlockers.includes("motion.no-flash"));
    assert.equal(designGateItem(ev, true).status, "unavailable");
  });

  it("vlm/review rules are an advisory checklist and are never reported as passed", () => {
    const ev = evaluateDesignGate(input(bound("pass-full.json")));
    const ids = ev.advisory.map((a) => a.id);
    assert.ok(ids.includes("motion.coherent"), "vlm rule present as advisory");
    assert.ok(ev.advisory.every((a) => a.check === "vlm" || a.check === "review"));
    const text = designGateChecklist(ev).join("\n");
    assert.match(text, /\[advisory, not verified\] motion\.coherent/);
    assert.doesNotMatch(text, /motion\.coherent.*(passed|PASS)/);
  });

  it("a crafted report that lists a vlm rule as an executed pass gets no credit for it", () => {
    // Only a vlm rule "passed": nothing executable ran.
    const r = bound("skipped.json");
    r.status = "pass";
    r.status_line = "PASS";
    r.reason = "";
    r.gates = [{ id: "motion.coherent", severity: "minor", blocking: false, pass_criteria: "", status: "pass" }];
    r.critic_checklist = [{ id: "motion.coherent", check: "vlm", severity: "minor", pass_criteria: "" }];
    r.counts = { run: 1, failed: 0, unmapped: 0 };
    const ev = evaluateDesignGate(input(r));
    assert.equal(ev.state, "incomplete");
    assert.equal(designGateItem(ev, true).status, "unavailable");
    assert.equal(ev.advisory.find((a) => a.id === "motion.coherent")?.reportedAsExecuted, true);
    assert.match(designGateChecklist(ev).join("\n"), /report claimed it ran; not credited/);
  });

  it("Pi's vendored rule table decides: a vlm rule listed as an executed pass is not credited even with no configured rules file", () => {
    const r = bound("skipped.json");
    r.status = "pass";
    r.status_line = "PASS";
    r.reason = "";
    // Not in critic_checklist, no `check` on the entry: the report does not admit it is vlm.
    r.gates = [{ id: "motion.coherent", severity: "minor", blocking: false, pass_criteria: "", status: "pass" }];
    r.counts = { run: 1, failed: 0, unmapped: 0 };
    const ev = evaluateDesignGate(input(r));
    assert.equal(ev.state, "incomplete");
    assert.equal(ev.advisory.find((a) => a.id === "motion.coherent")?.check, "vlm");
  });

  it("an id Pi does not know is never credited; the operator's rules file can teach Pi a new auto rule", () => {
    const r = bound("pass-full.json");
    (r.gates as Array<Record<string, unknown>>).push({
      id: "vendor.new-rule",
      severity: "major",
      blocking: true,
      pass_criteria: "",
      status: "fail",
    });
    r.status = "fail";
    r.status_line = "FAIL";
    r.counts = { run: 15, failed: 1, unmapped: 0 };
    // Unknown id that FAILED: still a failure (fail closed), never forgiven.
    assert.equal(evaluateDesignGate(input(r)).state, "failed");
    const only = bound("pass-full.json");
    (only.gates as Array<Record<string, unknown>>).push({
      id: "vendor.new-rule",
      severity: "major",
      blocking: true,
      pass_criteria: "",
      status: "pass",
    });
    only.counts = { run: 15, failed: 0, unmapped: 0 };
    // Passing: credited only once the operator's rules file says it is auto; that also makes it REQUIRED.
    const taught = new Map([["vendor.new-rule", "auto" as const]]);
    assert.equal(evaluateDesignGate(input(only, { ruleClasses: taught })).state, "passed");
    const absent = bound("pass-full.json");
    assert.equal(
      evaluateDesignGate(input(absent, { ruleClasses: taught })).state,
      "incomplete",
      "taught rule is required",
    );
  });

  it("a failed gate with severity blocker blocks even when the report says blocking:false", () => {
    const r = bound("pass-full.json");
    const g = (r.gates as Array<Record<string, unknown>>).find((x) => x.severity === "blocker")!;
    g.status = "fail";
    g.blocking = false;
    r.counts = { run: 14, failed: 1, unmapped: 0 };
    // Honest-looking report: status pass. Not accepted either way.
    const lying = evaluateDesignGate(input(r));
    assert.notEqual(lying.state, "passed");
    r.status = "fail";
    r.status_line = "FAIL";
    const honest = evaluateDesignGate(input(r));
    assert.equal(honest.state, "failed");
    assert.deepEqual(honest.failedGates, [g.id]);
  });

  it("a report that omits auto rules entirely is incomplete, never passed", () => {
    const r = bound("pass-full.json");
    const gates = r.gates as Array<Record<string, unknown>>;
    r.gates = gates.slice(0, 1);
    r.counts = { run: 1, failed: 0, unmapped: 0 };
    const ev = evaluateDesignGate(input(r));
    assert.equal(ev.state, "incomplete");
    assert.equal(ev.missingRules.length, 13);
    assert.equal(designGateItem(ev, true).status, "unavailable");
    // An entirely empty gates list claiming PASS is the extreme case.
    const empty = bound("pass-full.json", { gates: [], counts: { run: 0, failed: 0, unmapped: 0 } });
    assert.notEqual(evaluateDesignGate(input(empty)).state, "passed");
  });

  it("the vendored table matches the fixture rules.yaml it was taken from", async () => {
    const { parse } = await import("yaml");
    const rules = parse(readFileSync(new URL("rules.yaml", dir), "utf8")).rules as Array<{
      id: string;
      check?: string;
    }>;
    assert.equal(DEFAULT_RULE_CLASSES.size, rules.length);
    for (const r of rules) assert.equal(DEFAULT_RULE_CLASSES.get(r.id), r.check ?? "review", r.id);
  });
});

describe("design-gate item inside the completion gate", () => {
  const gateInput = (extraItems?: GateItem[]) => ({
    run: {} as never,
    policy: DEFAULT_POLICY,
    changeObserved: true,
    reviews: [],
    requiredSpecialists: [],
    unresolvedFingerprints: [],
    testFilesChanged: 1,
    ...(extraItems ? { extraItems } : {}),
  });
  const notRun = (required: boolean) => designGateItem(evaluateDesignGate(input(undefined)), required);

  it("gate output is unchanged without extra items", () => {
    const plain = evaluateGate(gateInput());
    const empty = evaluateGate(gateInput([]));
    assert.deepEqual(empty.items, plain.items);
    assert.deepEqual(empty.blockers, plain.blockers);
  });

  it("a required not-run design gate blocks completion; an optional one is only shown", () => {
    const required = evaluateGate(gateInput([notRun(true)]));
    assert.ok(required.blockers.some((b) => b.startsWith("design_gate")));
    const optional = evaluateGate(gateInput([notRun(false)]));
    assert.equal(
      optional.blockers.some((b) => b.startsWith("design_gate")),
      false,
    );
    assert.equal(optional.items.find((i) => i.key === "design_gate")?.status, "skipped");
  });

  it("a required passing design gate adds no blocker", () => {
    const pass = designGateItem(evaluateDesignGate(input(bound("pass-full.json"))), true);
    assert.equal(
      evaluateGate(gateInput([pass])).blockers.some((b) => b.startsWith("design_gate")),
      false,
    );
  });
});
