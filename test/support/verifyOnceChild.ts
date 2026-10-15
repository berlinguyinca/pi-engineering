// Child process for the cross-process verification-cache test: computes once or reuses.
import { appendFileSync } from "node:fs";
import { verifyOnce } from "../../src/verify/resultCache.ts";

const [cwd, commonDir, marker] = process.argv.slice(2) as [string, string, string];
const profile = { name: "p", stages: [{ name: "test", command: "node", args: ["--test"], required: true }] };
const result = await verifyOnce({ cwd, commonDir, profile }, async () => {
  appendFileSync(marker, "ran\n");
  await new Promise((resolve) => setTimeout(resolve, 800));
  return { value: { ok: true }, passed: true };
});
process.stdout.write(JSON.stringify({ reused: result.reused, runId: result.runId }));
