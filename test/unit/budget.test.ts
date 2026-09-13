import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetManager, DEFAULT_BUDGETS } from "../../src/budget/BudgetManager.ts";

test("budget: round 0 returns the base budget", () => {
  const b = new BudgetManager();
  assert.equal(b.budgetFor("implementer", 0, 0), DEFAULT_BUDGETS.implementer.base);
});

test("budget: escalates toward the hard cap when marginal value supports it", () => {
  const b = new BudgetManager();
  const highValue = DEFAULT_BUDGETS.implementer.base * 0.1; // well above threshold
  assert.equal(b.budgetFor("implementer", 0, highValue), 16_000);
  assert.equal(b.budgetFor("implementer", 1, highValue), 24_000);
  assert.equal(b.budgetFor("implementer", 2, highValue), 32_000);
  assert.equal(b.budgetFor("implementer", 3, highValue), 40_000);
  assert.equal(b.budgetFor("implementer", 10, highValue), 40_000); // capped
});

test("budget: does not escalate when marginal value is below threshold", () => {
  const b = new BudgetManager();
  assert.equal(b.budgetFor("implementer", 3, 0), 16_000); // no value, stays base
});

test("budget: shouldStop requires base spend and zero marginal value", () => {
  const b = new BudgetManager();
  assert.equal(b.shouldStop(0, 100, "implementer"), false); // below base
  assert.equal(b.shouldStop(0, DEFAULT_BUDGETS.implementer.base, "implementer"), true);
  assert.equal(b.shouldStop(1, DEFAULT_BUDGETS.implementer.base, "implementer"), false); // has value
});

test("budget: custom specs override defaults", () => {
  const b = new BudgetManager({ implementer: { base: 1000, hardCap: 2000, step: 500, marginalThreshold: 0.1 } });
  assert.equal(b.budgetFor("implementer", 0, 200), 1000);
  assert.equal(b.budgetFor("implementer", 1, 200), 1500);
  assert.equal(b.budgetFor("implementer", 5, 200), 2000);
});

test("budget: createState captures spent + escalation level", () => {
  const b = new BudgetManager();
  const st = b.createState("reviewer", 5000);
  assert.equal(st.role, "reviewer");
  assert.equal(st.spent, 5000);
  assert.equal(st.escalationLevel, 0);
});
