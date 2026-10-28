/**
 * T16 env finding: commands whose text a worker can author (verifier checks, CAV tests) must not inherit Pi's Herdr
 * variables, and the retired Herdr variables are never an input and never survive in Pi's own environment.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDeterministicTest } from "../../src/cav/runner.ts";
import { runChecks } from "../../src/lifecycle/verification.ts";
import { isScrubbedEnvName, workerCommandEnv } from "../../src/lifecycle/workerEnv.ts";
import { scrubLegacyHerdrEnv } from "../../src/runtime/herdr/attentionIngest.ts";
import { sanitizeVerifierEnv } from "../../src/verify/childEnv.ts";

// Assembled at run time so no secret-shaped literal sits in the source.
const FAKE = ["not", "a", "real", "credential"].join("-");
const HERDR = [
  "HERDR_INGEST_API_KEY",
  "HERDR_INGEST_URL",
  "HERDR_HOST_ID",
  "HERDR_ENGINEERING_CONTROL_PLANE_KEY",
  "HERDR_ENGINEERING_CONTROL_PLANE_URL",
];

function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const name of HERDR) {
    saved.set(name, process.env[name]);
    process.env[name] = FAKE;
  }
  return fn().finally(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("workerCommandEnv drops Pi's Herdr variables and nothing else", () => {
  const env = workerCommandEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    NODE_ENV: "test",
    GH_TOKEN: FAKE, // not scrubbed: a project's own checks may need it (see the header of workerEnv.ts)
    ...Object.fromEntries(HERDR.map((n) => [n, FAKE])),
  });
  assert.deepEqual(Object.keys(env).sort(), ["GH_TOKEN", "HOME", "NODE_ENV", "PATH"]);
  assert.ok(isScrubbedEnvName("HERDR_ANYTHING"));
  assert.ok(!isScrubbedEnvName("PATH"));
});

test("the CommandVerifier child environment drops HERDR_* too", () => {
  const env = sanitizeVerifierEnv({ PATH: "/usr/bin", ...Object.fromEntries(HERDR.map((n) => [n, FAKE])) });
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "PI_ENGINEERING_VERIFIER_CHILD"]);
});

test("scrubLegacyHerdrEnv removes the retired variables from Pi's own environment", () => {
  const env: NodeJS.ProcessEnv = { HERDR_INGEST_URL: "u", HERDR_INGEST_API_KEY: FAKE, HERDR_HOST_ID: "h", PATH: "/x" };
  scrubLegacyHerdrEnv(env);
  assert.deepEqual(env, { PATH: "/x" });
});

const probe = `for v in ${HERDR.join(" ")}; do eval "test -z \\"\\$$v\\"" || { echo "leaked $v"; exit 3; }; done`;

test("the verifier's check commands do not see Pi's Herdr variables", async () => {
  const report = await withEnv(() =>
    runChecks({
      cwd: process.cwd(),
      specs: [
        {
          kind: "test",
          name: "env-probe",
          origin: "configuration",
          required: true,
          command: probe,
          timeoutMs: 20_000,
        } as never,
      ],
      artifacts: { put: async () => ({ uri: "artifact://probe" }) } as never,
      stage: "final",
      round: 1,
    }),
  );
  assert.equal(report.status, "passed", JSON.stringify(report));
});

test("CAV deterministic tests do not see Pi's Herdr variables", async () => {
  const result = await withEnv(() =>
    runDeterministicTest({ record: async () => {} } as never, {
      requirementId: "R1",
      command: "sh",
      args: ["-c", probe],
      role: "tester",
      workerRunId: "w1",
      gitSha: "0".repeat(40),
      cwd: process.cwd(),
    }),
  );
  assert.equal(result.passed, true);
});
