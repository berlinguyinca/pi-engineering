/** T07 deviation signals: irrelevant refactor flagged (all four kinds), read-only investigation silent. */
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTaskAlignment, type TaskAction, type TaskAlignmentInput } from "../../src/aps/taskAlignment.ts";

const act = (tool: string, target: string, iteration: number, extra: Partial<TaskAction> = {}): TaskAction =>
  ({ iteration, tool, target, mutating: ["write", "edit"].includes(tool), taskId: "T07", ...extra });
const base: TaskAlignmentInput = { allowedScope: ["src/reader/**"], declaredTasks: ["T07"], allowedDependencies: [], actions: [] };
const run = (over: Partial<TaskAlignmentInput>) => evaluateTaskAlignment({ ...base, ...over });
const pairs = (rows: ReturnType<typeof run>) => rows.map((s) => [s.kind, s.subject]);
const drift: TaskAction[] = [act("write", "src/ui/theme.ts", 2), act("write", "src/ui/theme.ts", 5), act("edit", "docs/roadmap.md", 3),
  act("bash", "package.json", 4, { newDependency: "left-pad", taskId: "T99" })];
const stale = { criteria: ["tests green"], progressedAtIteration: { "tests green": 0 } };

test("irrelevant refactor flags all four kinds, sorted and deduplicated; read-only investigation stays silent", () => {
  const out = run({ actions: drift, allowedDependencies: ["zod"], acceptance: stale, stagnationIterations: 2 });
  assert.deepEqual(pairs(out), [["acceptance_stagnation", "tests green"], ["out_of_scope_write", "docs/roadmap.md"],
    ["out_of_scope_write", "src/ui/theme.ts"], ["task_expansion", "T99"], ["unrelated_dependency", "left-pad"]]);
  assert.equal(out[2]?.iteration, 2); // repeated write collapses to its first observation; output ordered by kind, subject, iteration
  for (const s of out) assert.match(s.evidence, new RegExp(s.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))); // evidence names its subject
  assert.deepEqual(run({ actions: [act("read", "src/ui/theme.ts", 1), act("grep", "docs/roadmap.md", 2), act("repo_search", "src/ui/theme.ts", 3)] }), []);
});

test("scope is judged by the caller's mutating flag; in-scope writes and an empty scope behave as specified", () => {
  const empty = run({ actions: [act("write", "src/reader/parse.ts", 1)], allowedScope: [] });
  assert.deepEqual(run({ actions: [act("write", "src/reader/parse.ts", 1)] }), []);
  assert.deepEqual(run({ actions: [act("write", "src/ui/theme.ts", 1, { mutating: false })] }), []); // caller override beats tool name
  assert.equal(run({ actions: [act("repo_search", "src/ui/theme.ts", 1, { mutating: true })] }).length, 1);
  assert.equal(empty[0]?.kind, "out_of_scope_write"); assert.match(empty[0]!.evidence, /none declared, so nothing is authorized/);
});

test("dependency compare is trimmed and case-insensitive; stagnation flags once, bad thresholds fall back to 10", () => {
  assert.deepEqual(run({ actions: [act("bash", "", 1, { newDependency: "Zod " })], allowedDependencies: ["zod"] }), []);
  assert.deepEqual(pairs(run({ actions: [act("bash", "", 1, { newDependency: "left-pad" })], allowedDependencies: ["zod"] })), [["unrelated_dependency", "left-pad"]]);
  const staleAt = (n: number) => ({ actions: [act("read", "src/reader/x.ts", n)], acceptance: stale });
  assert.equal(run({ ...staleAt(10), stagnationIterations: 10 }).length, 1);
  assert.equal(run({ ...staleAt(9), stagnationIterations: 10 }).length, 0);
  assert.equal(run({ ...staleAt(4), stagnationIterations: -3 }).length, 0); // non-positive threshold → default 10
  assert.equal(run({ ...staleAt(11), stagnationIterations: Number.NaN }).length, 1); // NaN → default 10
  assert.deepEqual(run({ actions: [act("read", "x", 9)], acceptance: { criteria: ["tests green"], progressedAtIteration: { "tests green": 9 } } }), []);
  assert.deepEqual(run({ actions: [], acceptance: stale }), []);
  const input: TaskAlignmentInput = { ...base, actions: drift, acceptance: stale, stagnationIterations: 2 };
  assert.deepEqual(evaluateTaskAlignment(input), evaluateTaskAlignment(input)); // identical input → identical output
});
