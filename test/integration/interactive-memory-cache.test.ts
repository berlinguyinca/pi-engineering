/**
 * The client profile, not a cached connection, decides where memory goes.
 *
 * Pi keeps no endpoint and no token, so there is nothing to rotate inside Pi: the
 * `herdr-memory` client re-reads its own profile on every call. What Pi does hold
 * is the client executable built into each provider — so the guarantee that still
 * matters is that a changed client is used by the next operation rather than a
 * memoised one. (A `blackhole` config that still names the retired HTTP fields is
 * refused at config resolution; that guard lives in test/unit/blackhole.test.ts.)
 *
 * No EngineeringRuntime here on purpose: opening one needs the artifact store,
 * which needs Linux, and this guarantee lives entirely in the client seam.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HindsightDurableMemory,
  type HindsightRunner,
  probeHindsightStatus,
  resolveHindsightFromEnv,
} from "../../src/blackhole/hindsight.ts";

const ALPHA = "/profiles/alpha/herdr-memory";
const BETA = "/profiles/beta/herdr-memory";

/** A client whose answers depend on which executable was called. */
function clientAwareRunner(calls: string[]): HindsightRunner {
  return async (cli, args) => {
    calls.push(`${cli} ${args.join(" ")}`);
    if (args[0] === "status") {
      return { stdout: JSON.stringify({ healthy: true, project: cli === BETA ? "beta" : "alpha" }), exitCode: 0 };
    }
    if (args[0] === "recall") {
      return {
        stdout: JSON.stringify({
          results: [
            { memory_id: cli === BETA ? "beta-1" : "alpha-1", text: cli === BETA ? "beta note" : "alpha note" },
          ],
        }),
        exitCode: 0,
      };
    }
    return { stdout: "{}", exitCode: 0 };
  };
}

test("the next operation uses the client Pi just recorded, not a cached one", async () => {
  const calls: string[] = [];
  const run = clientAwareRunner(calls);

  const first = await probeHindsightStatus({ cli: ALPHA, run });
  assert.equal(first.ok && first.project, "alpha");

  // A changed profile is a different executable: nothing about the client's
  // identity is memoised, so the very next check already asks the new one.
  const second = await probeHindsightStatus({ cli: BETA, run });
  assert.equal(second.ok && second.project, "beta");

  // A provider built from the changed client recalls through the changed client.
  const durable = new HindsightDurableMemory({ cli: BETA, scopes: ["project"], run });
  assert.deepEqual(
    (await durable.search("deploy notes")).map((note) => [note.id, note.text]),
    [["beta-1", "beta note"]],
  );
  const recalls = calls.filter((call) => call.includes(" recall "));
  assert.ok(recalls.length > 0, "the search should have reached the client");
  assert.ok(
    recalls.every((call) => call.startsWith(`${BETA} `)),
    `a recall went to a retired client: ${recalls.join(" | ")}`,
  );
});

test("the environment names only the client, never an endpoint or a key", () => {
  const resolved = resolveHindsightFromEnv({ PI_HINDSIGHT_ENABLED: "1", PI_HINDSIGHT_CLI: BETA });
  assert.deepEqual(resolved, { cli: BETA, scopes: ["project"], timeoutMs: 5000 });
  // Opt-out is total: without the opt-in there is no memory configuration at all.
  assert.equal(resolveHindsightFromEnv({ PI_HINDSIGHT_ENABLED: "0", PI_HINDSIGHT_CLI: BETA }), null);
});
