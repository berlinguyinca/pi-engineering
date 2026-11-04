import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesGlob } from "../../src/plannerWorker/contract.ts";
import { PROTECTED_TASK_AUTHORITY_GLOBS, scopeGateBlockedReason, scopeIntegrityCheck } from "../../src/plannerWorker/executor.ts";

const refs = { taskId: "T09", branch: "pi-eng-orch-PW-t09/task", base: "a".repeat(40), head: "b".repeat(40) };
const scope = (allowed: string[]) => ({ allowed, forbidden: [] });
type Gate = { ok: boolean; violations?: string[]; protectedHits?: string[]; refs: string };
const check = (changed: readonly unknown[], s = scope(["src/reader/**"])): Gate =>
  scopeIntegrityCheck({ changed: changed as readonly string[], scope: s, refs });

describe("scopeIntegrityCheck", () => {
  it("out-of-scope paths named in input order; in-scope passes; refs exact", () => {
    const r = check(["src/reader/read.ts", "src/ui/theme.ts", "docs/roadmap.md"]);
    assert.deepEqual([r.ok, r.violations, r.protectedHits], [false, ["src/ui/theme.ts", "docs/roadmap.md"], []]);
    assert.equal(r.refs, `task=T09 branch=${refs.branch} base=${refs.base} head=${refs.head} paths=src/ui/theme.ts,docs/roadmap.md`);
    assert.deepEqual(check(["src/reader/read.ts"]), { ok: true, refs: `task=T09 branch=${refs.branch} base=${refs.base} head=${refs.head} paths=` });
  });
  it("protected hits unauthorized even inside scope; override honoured; blocked-reason prefix", () => {
    assert.deepEqual(check(["docs/specs/x/manifests/tasks.json"], scope(["docs/specs/**"])), { ok: false, violations: [], protectedHits: ["docs/specs/x/manifests/tasks.json"], refs: `task=T09 branch=${refs.branch} base=${refs.base} head=${refs.head} paths=docs/specs/x/manifests/tasks.json` });
    assert.equal(scopeIntegrityCheck({ changed: ["x/y.lock"], scope: scope(["**"]), authorityProtected: ["x/*.lock"], refs }).ok, false);
    assert.equal(scopeGateBlockedReason("r"), "evidence: scope gate: r");
  });
  it("all six authority families protected; ordinary src/** clean", () => {
    const fam = ["docs/specs/b/manifests/tasks.json", "docs/specs/b/T08.handoff.json", "docs/specs/b/fixtures/manifest.json", "docs/specs/b/templates/task.md", "templates/contract.md", "scripts/bootstrap-one.ts"];
    assert.ok(fam.every((p) => PROTECTED_TASK_AUTHORITY_GLOBS.some((g) => matchesGlob(p, g))));
    assert.equal(check(fam, scope(["**"])).protectedHits?.length, 6);
    assert.equal(check(["src/a/b.ts", "src/main.ts"], scope(["src/**"])).ok, true);
  });
  it("dedup, bound to 20 with note only in refs, inert on odd input, deterministic", () => {
    assert.deepEqual(check(["x/y.ts", "x/y.ts"], scope(["src/**"])).violations, ["x/y.ts"]);
    const many = Array.from({ length: 25 }, (_, i) => `out/p${i}.ts`);
    const b = check(many, scope(["src/**"]));
    assert.deepEqual([b.ok, b.violations!.length, b.violations!.at(-1)], [false, 20, "out/p19.ts"]);
    assert.ok(b.refs.includes("…(+5 more)"));
    assert.ok(!b.violations!.some((p) => p.includes("…")));
    assert.equal(check([], scope(["src/**"])).ok, true);
    assert.equal(check(["src/reader/read.ts", null, 7, {}, []], scope(["src/reader/**"])).ok, true);
    assert.deepEqual(check(many, scope(["src/**"])), b);
  });
});
