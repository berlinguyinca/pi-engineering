import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { AutoSpecConfigResult } from "../../src/integrations/autospec/config.ts";
import { collectAutoSpecGateEvidence, missionDesignGateReasons } from "../../src/integrations/autospec/provider.ts";
import { CompletionGate } from "../../src/orchestration/completionGate.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const fixtures = new URL("../fixtures/autospec-design-gates/", import.meta.url);
const pass = JSON.parse(readFileSync(new URL("pass-full.json", fixtures), "utf8")) as Record<string, unknown>;
const rulesFile = new URL("rules.yaml", fixtures).pathname;
const REPORT = ".autospec/reports/design-gates.json";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@e.c", "-c", "user.name=T", ...a], { cwd, encoding: "utf8" }).trim();
const put = (cwd: string, rel: string, text: string) => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};
const commit = (cwd: string, msg: string) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
};
function newRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ag-prov-"));
  git(cwd, "init", "-q");
  put(cwd, "README.md", "base\n");
  const base = commit(cwd, "base");
  return { cwd, base };
}
const cfg = (over: Record<string, unknown> = {}, required = true): AutoSpecConfigResult => ({
  kind: "on",
  config: {
    dag: { enabled: false },
    designGate: {
      reportPath: REPORT,
      rulesFile: null,
      attestationKeyFile: null,
      uiPaths: ["src/ui/**"],
      requireForUi: required,
      ...over,
    },
    qualityLaw: null,
    notes: [],
  },
});
const ui = [{ path: "src/ui/a.tsx", scope: "base" as const }];
const status = async (c: AutoSpecConfigResult, cwd: string, sha: string, files = ui) =>
  (await collectAutoSpecGateEvidence(c, { cwd, headCommit: sha, files })).items[0]?.status;

/** UI commit C1, then a commit that adds the report FOR C1 (it cannot name its own commit). */
function withReport(over: Record<string, unknown> = {}, sig?: (c1: string, text: string) => string) {
  const r = newRepo();
  put(r.cwd, "src/ui/a.tsx", "export const a = 1;\n");
  const c1 = commit(r.cwd, "ui");
  const text = JSON.stringify({ ...pass, commit_sha: c1, ...over });
  put(r.cwd, REPORT, text);
  if (sig) put(r.cwd, ".autospec/reports/design-gates.sig", `${sig(c1, text)}\n`);
  const head = commit(r.cwd, "report");
  return { ...r, c1, head, text };
}

describe("design-gate provenance (reports are read from the commit, never the worktree)", () => {
  it("a committed report for the parent commit, with no UI change since, passes", async () => {
    const r = withReport();
    assert.equal(await status(cfg(), r.cwd, r.head), "passed");
  });

  it("a worker-written UNTRACKED report naming HEAD never counts", async () => {
    const r = newRepo();
    put(r.cwd, "src/ui/a.tsx", "export const a = 1;\n");
    const head = commit(r.cwd, "ui");
    put(r.cwd, REPORT, JSON.stringify({ ...pass, commit_sha: head }));
    put(r.cwd, ".autospec/reports/design-gates.commit", `${head}\n`);
    const out = await collectAutoSpecGateEvidence(cfg(), { cwd: r.cwd, headCommit: head, files: ui });
    assert.equal(out.items[0]?.status, "skipped");
    assert.match(out.items[0]?.reason ?? "", /not committed/);
  });

  it("editing the committed report in the worktree (to PASS) changes nothing: the committed bytes decide", async () => {
    const r = withReport({ status: "fail", status_line: "FAIL" });
    const before = await status(cfg(), r.cwd, r.head);
    assert.notEqual(before, "passed");
    put(r.cwd, REPORT, JSON.stringify({ ...pass, commit_sha: r.c1 }));
    assert.equal(await status(cfg(), r.cwd, r.head), before);
  });

  it("UI changed after the commit the report names -> stale; a non-UI change since is fine", async () => {
    const r = withReport();
    put(r.cwd, "docs/x.md", "doc\n");
    const docs = commit(r.cwd, "docs only");
    assert.equal(await status(cfg(), r.cwd, docs), "passed");
    put(r.cwd, "src/ui/a.tsx", "export const a = 2;\n");
    const changed = commit(r.cwd, "ui again");
    assert.equal(await status(cfg(), r.cwd, changed), "unavailable");
  });

  it("a report naming a commit that does not exist or is not an ancestor is stale", async () => {
    const r = withReport({ commit_sha: "c".repeat(40) });
    assert.equal(await status(cfg(), r.cwd, r.head), "unavailable");
  });

  it("a report symlinked to a file outside the repository does not pass", async () => {
    const r = newRepo();
    put(r.cwd, "src/ui/a.tsx", "x\n");
    const c1 = commit(r.cwd, "ui");
    const outside = mkdtempSync(join(tmpdir(), "pi-ag-out-"));
    writeFileSync(join(outside, "r.json"), JSON.stringify({ ...pass, commit_sha: c1 }));
    mkdirSync(join(r.cwd, ".autospec/reports"), { recursive: true });
    symlinkSync(join(outside, "r.json"), join(r.cwd, REPORT));
    const head = commit(r.cwd, "link");
    assert.notEqual(await status(cfg(), r.cwd, head), "passed");
  });

  it("uses Pi's rules file for classes; an unreadable one, or one with an unknown/missing check, fails closed", async () => {
    const r = withReport();
    assert.equal(await status(cfg({ rulesFile }), r.cwd, r.head), "passed");
    assert.equal(await status(cfg({ rulesFile: "/nonexistent/rules.yaml" }), r.cwd, r.head), "unavailable");
    for (const body of ["rules:\n  - id: a.b\n", "rules:\n  - id: a.b\n    check: maybe\n"]) {
      const f = join(mkdtempSync(join(tmpdir(), "pi-ag-rules-")), "rules.yaml");
      writeFileSync(f, body);
      assert.equal(await status(cfg({ rulesFile: f }), r.cwd, r.head), "unavailable", body);
    }
  });

  it("not required: shown but the item never blocks; invalid config is a required unavailable item", async () => {
    const r = withReport();
    const out = await collectAutoSpecGateEvidence(cfg({}, false), { cwd: r.cwd, headCommit: r.head, files: ui });
    assert.equal(out.items[0]?.required, false);
    const bad = await collectAutoSpecGateEvidence(
      { kind: "invalid", notes: ["bad"] },
      { cwd: r.cwd, headCommit: r.head, files: [] },
    );
    assert.equal(bad.items[0]?.required, true);
  });
});

describe("design-gate attestation (operator key outside the worktree)", () => {
  const key = "k".repeat(32);
  const keyFile = join(mkdtempSync(join(tmpdir(), "pi-ag-key-")), "design.key");
  writeFileSync(keyFile, `${key}\n`);
  const sign = (k: string) => (c1: string, text: string) =>
    createHmac("sha256", k)
      .update(`${c1}\n${createHash("sha256").update(text, "utf8").digest("hex")}`)
      .digest("hex");

  it("a valid HMAC passes; missing, wrong-key or tampered-report signatures do not", async () => {
    const good = withReport({}, sign(key));
    assert.equal(await status(cfg({ attestationKeyFile: keyFile }), good.cwd, good.head), "passed");
    const none = withReport();
    assert.equal(await status(cfg({ attestationKeyFile: keyFile }), none.cwd, none.head), "unavailable");
    const forged = withReport({}, sign("z".repeat(32)));
    assert.equal(await status(cfg({ attestationKeyFile: keyFile }), forged.cwd, forged.head), "unavailable");
    const r = withReport({}, (c1) => sign(key)(c1, "different report text"));
    assert.equal(await status(cfg({ attestationKeyFile: keyFile }), r.cwd, r.head), "unavailable");
    // Unreadable or too-short key: fail closed.
    assert.equal(await status(cfg({ attestationKeyFile: "/nonexistent/key" }), good.cwd, good.head), "unavailable");
  });
});

describe("orchestrated missions: design gate on the candidate commit", () => {
  it("requires evidence for a UI-touching candidate and blocks without it", () => {
    const r = newRepo();
    put(r.cwd, "src/ui/a.tsx", "x\n");
    const cand = commit(r.cwd, "ui candidate");
    const reasons = missionDesignGateReasons(cfg(), {
      repoRoot: r.cwd,
      candidates: [{ baseSha: r.base, candidateSha: cand }],
    });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0] ?? "", /design_gate \(not_run\)/);
  });

  it("passes with a committed report for the candidate's UI commit; ignores non-UI candidates", () => {
    const w = withReport();
    assert.deepEqual(
      missionDesignGateReasons(cfg(), { repoRoot: w.cwd, candidates: [{ baseSha: w.base, candidateSha: w.head }] }),
      [],
    );
    const r = newRepo();
    put(r.cwd, "src/core/x.ts", "x\n");
    const cand = commit(r.cwd, "core");
    assert.deepEqual(
      missionDesignGateReasons(cfg(), { repoRoot: r.cwd, candidates: [{ baseSha: r.base, candidateSha: cand }] }),
      [],
    );
  });

  it("an untracked report in the mission checkout does not satisfy the candidate", () => {
    const r = newRepo();
    put(r.cwd, "src/ui/a.tsx", "x\n");
    const cand = commit(r.cwd, "ui");
    put(r.cwd, REPORT, JSON.stringify({ ...pass, commit_sha: cand }));
    assert.equal(
      missionDesignGateReasons(cfg(), { repoRoot: r.cwd, candidates: [{ baseSha: r.base, candidateSha: cand }] })
        .length,
      1,
    );
  });

  it("fails closed on several candidates, a bad config, or an unusable repo; off/optional never block", () => {
    const r = newRepo();
    const two = [
      { baseSha: r.base, candidateSha: r.base },
      { baseSha: r.base, candidateSha: r.base },
    ];
    assert.equal(missionDesignGateReasons(cfg(), { repoRoot: r.cwd, candidates: two }).length, 1);
    assert.equal(
      missionDesignGateReasons({ kind: "invalid", notes: ["x"] }, { repoRoot: r.cwd, candidates: [] }).length,
      1,
    );
    assert.equal(
      missionDesignGateReasons(cfg(), {
        repoRoot: "/nonexistent/repo",
        candidates: [{ baseSha: "a".repeat(40), candidateSha: "b".repeat(40) }],
      }).length,
      1,
    );
    assert.deepEqual(missionDesignGateReasons({ kind: "off" }, { repoRoot: r.cwd, candidates: two }), []);
    assert.deepEqual(missionDesignGateReasons(cfg({}, false), { repoRoot: r.cwd, candidates: two }), []);
  });

  it("the synchronous CompletionGate refuses to complete on those reasons and is unchanged without them", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "t",
      goal: "g",
      user_request: "g",
      repository: ".",
      base_ref: "HEAD",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    const plain = new CompletionGate(store).evaluate(store.getMission(m.mission_id)!);
    const blocked = new CompletionGate(store, undefined, () => ["design_gate (not_run): no report"]).evaluate(
      store.getMission(m.mission_id)!,
    );
    assert.equal(blocked.can_complete, false);
    assert.ok(blocked.reasons.some((x) => x.startsWith("design_gate")));
    const same = new CompletionGate(store, undefined, () => []).evaluate(store.getMission(m.mission_id)!);
    assert.deepEqual(same, plain);
    const thrown = new CompletionGate(store, undefined, () => {
      throw new Error("boom");
    }).evaluate(store.getMission(m.mission_id)!);
    assert.equal(thrown.can_complete, false);
  });
});
