import assert from "node:assert/strict";
import { test } from "node:test";
import { TokenAccount } from "../../src/budget/TokenAccount.ts";

const reply = (usage: Record<string, unknown> | undefined) => ({ role: "assistant", model: "m", usage });

test("a field no provider reported is null, never 0", () => {
  const u = new TokenAccount().addMessages([reply({ input: 100, output: 40 })]).usage();
  assert.equal(u?.thinking, null, "no reasoning breakdown reported");
  assert.equal(u?.maxTokens, null, "no allowance recorded");
  assert.equal(u?.compactions, 0, "a count of events is a real zero");
  assert.equal(
    new TokenAccount().addMessages([reply({ input: 100 })]).usage()?.total,
    100,
    "sum of the reported parts",
  );
  assert.equal(new TokenAccount().addMessages([reply({ cost: { total: 1 } })]).usage()?.total, null);
  assert.equal(new TokenAccount().addMessages([{ role: "assistant" }, { role: "user" }]).usage(), null);
});

test("thinking is a subset of output: total is input + output, never plus thinking", () => {
  const u = new TokenAccount().addMessages([reply({ input: 100, output: 40, reasoning: 30 })]).usage();
  assert.equal(u?.output, 40);
  assert.equal(u?.thinking, 30);
  assert.equal(u?.total, 140);
});

test("sums every request of every attempt, the compactions and the largest allowance", () => {
  const account = new TokenAccount();
  account.addMessages([reply({ input: 10, output: 5, reasoning: 2 }), reply({ input: 20, output: 5 })]);
  account.addMessages([reply({ input: 30, output: 10, reasoning: 0 })]); // a retry's fresh session
  account.addCompaction();
  account.addCompaction({ input: 5, output: 1 }); // the summary request's tokens count, not as a turn
  account.addCompaction();
  account.useAllowance(4_096);
  account.useAllowance(8_192);
  account.useAllowance(undefined);
  const u = account.usage(1);
  assert.deepEqual(
    [u?.input, u?.output, u?.thinking, u?.total, u?.compactions, u?.maxTokens, u?.turns, u?.streamResumes],
    [65, 21, 2, 86, 3, 8_192, 3, 1],
  );
});
