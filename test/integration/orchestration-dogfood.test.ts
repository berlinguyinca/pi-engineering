import { test } from "node:test";

test("orchestration dogfood exercises the current runtime contract", { timeout: 120_000 }, async () => {
  await import("../../scripts/dogfood-orchestration.ts");
});
