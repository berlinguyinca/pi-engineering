import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ContextBroker, requiredContextGate } from "../../src/context/ContextBroker.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

test("unavailable required context is reported and blocks launch by default (T05)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const broker = (await ContextBroker.open(fixture.root))!;
    const pkg = await broker.assembleContext("implement add function", 4000, ["src/missing.ts"]);
    assert.equal(pkg.omissions?.length, 1, "one omission per required file the package could not deliver");
    assert.equal(pkg.omissions![0]!.kind, "unavailable");
    assert.equal(pkg.omissions![0]!.path, "src/missing.ts");
    assert.ok(!pkg.items.some((i) => i.path === "src/missing.ts"), "no item for an unreadable required file");
    const blocked = requiredContextGate(pkg);
    assert.equal(blocked.canLaunch, false, "missing indispensable evidence blocks launch by default");
    assert.ok(blocked.reason?.includes("src/missing.ts"), "the reason names the missing path");
    const allowed = requiredContextGate(pkg, { allowBlockedInvestigation: true });
    assert.equal(allowed.canLaunch, true, "the explicit policy permits blocked investigation");
    assert.equal(allowed.reason, blocked.reason, "and the reason is still returned to surface");
  } finally {
    await fixture.cleanup();
  }
});

test("truncation reports token counts without blocking; whole delivery reports nothing (T05)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await writeFile(join(fixture.root, "big.txt"), "x".repeat(8000));
    const broker = (await ContextBroker.open(fixture.root))!;
    const tight = await broker.assembleContext("implement add", 400, ["big.txt"]);
    assert.equal(tight.items.find((i) => i.path === "big.txt")?.truncated, true, "item stays truncated:true");
    assert.ok(tight.totalTokens <= 400, "budget accounting is unchanged");
    const omission = tight.omissions![0]!;
    assert.equal(tight.omissions?.length, 1);
    assert.equal(omission.kind, "truncated");
    assert.equal(omission.path, "big.txt");
    assert.ok((omission.requestedTokens ?? 0) > (omission.providedTokens ?? 0), "token counts size the hole");
    assert.deepEqual(requiredContextGate(tight), { canLaunch: true }, "truncation alone never blocks");
    const whole = await broker.assembleContext("implement add", 4000, ["src/add.js"]);
    assert.equal(whole.omissions, undefined, "a required file delivered whole records nothing");
    const none = await broker.assembleContext("implement add", 4000, []);
    assert.equal(none.omissions, undefined, "an empty required list invents no omissions field");
  } finally {
    await fixture.cleanup();
  }
});
