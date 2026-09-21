import assert from "node:assert/strict";
import { test } from "node:test";
import { ChangeClassifier } from "../../src/cav/classify.ts";

test("a source-only diff derives unit + typecheck gates", () => {
  const c = new ChangeClassifier().classify(["src/cav/types.ts"]);
  assert.equal(c.touchesProtected, false);
  assert.ok(c.gates.some((g) => g.type === "unit" && g.required));
  assert.ok(c.gates.some((g) => g.type === "typecheck" && g.required));
  assert.ok(!c.gates.some((g) => g.type === "browser"));
});

test("a UI diff derives a required browser gate (UI_VERIFICATION contract)", () => {
  const c = new ChangeClassifier().classify(["src/ui/Panel.tsx"]);
  assert.ok(c.gates.some((g) => g.type === "browser" && g.required));
  assert.ok(c.kinds.includes("ui"));
});

test("a visual-reference diff derives a required visual gate", () => {
  const c = new ChangeClassifier().classify(["tests/cav/golden/hero.png"]);
  assert.ok(c.gates.some((g) => g.type === "visual" && g.required));
});

test("a protected-artifact diff is a hard failure and cannot pass", () => {
  const c = new ChangeClassifier().classify(["docs/specs/cav/ROADMAP.md"]);
  assert.equal(c.touchesProtected, true);
  assert.equal(c.protectedPath, "docs/specs/cav/ROADMAP.md");
  assert.ok(c.gates.some((g) => g.type === "protected" && g.required));
});

test("a test-only diff derives a unit gate but no typecheck gate", () => {
  const c = new ChangeClassifier().classify(["test/unit/cav-classify.test.ts"]);
  assert.equal(c.kinds.includes("test"), true);
  assert.ok(c.gates.some((g) => g.type === "unit"));
  assert.ok(!c.gates.some((g) => g.type === "typecheck"));
});

test("empty diff derives no gates (no change = no verification obligation)", () => {
  const c = new ChangeClassifier().classify([]);
  assert.equal(c.gates.length, 0);
  assert.equal(c.kinds.length, 0);
});

test("browser gating can be disabled via option", () => {
  const c = new ChangeClassifier({ uiRequiresBrowser: false }).classify(["src/ui/Panel.tsx"]);
  assert.ok(!c.gates.some((g) => g.type === "browser"));
});
