import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { StackLifecycleError, runRealStackLifecycle } from "../../src/cav/stack.ts";

const REPO = resolve(import.meta.dirname, "../..");

test("real stack lifecycle: starts a real process, health-checks it, verifies, and stops", async () => {
  // Use the control-plane server itself (a real HTTP stack) on an ephemeral port.
  const port = 18080 + Math.floor(Math.random() * 500);
  const storeFile = `${REPO}/.pi-eng/cav/test-store-${Date.now()}.jsonl`;
  const result = await runRealStackLifecycle(
    {
      command: "node",
      args: ["--experimental-strip-types", "scripts/control-server.ts", String(port)],
      cwd: REPO,
      healthUrl: `http://127.0.0.1:${port}/health`,
      startupTimeoutMs: 15000,
    },
    async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status?: string };
      assert.equal(body.status, "ok");
    },
  );
  assert.equal(result.started, true);
  assert.equal(result.healthy, true);
  assert.equal(result.stopped, true);
  assert.ok(result.healthBody.length > 0);
});

test("real stack lifecycle fails closed when the stack never becomes healthy", async () => {
  // A port with nothing listening => never healthy => error, no PASS.
  const port = 19999 + Math.floor(Math.random() * 100);
  await assert.rejects(
    runRealStackLifecycle(
      {
        command: "node",
        args: ["-e", "setTimeout(()=>{},60000)"], // starts but never serves
        cwd: REPO,
        healthUrl: `http://127.0.0.1:${port}/health`,
        startupTimeoutMs: 800,
        pollMs: 100,
      },
      async () => {},
    ),
    (err) => err instanceof StackLifecycleError && /did not become healthy/.test(err.message),
  );
});

test("real stack lifecycle fails closed when the process cannot start", async () => {
  await assert.rejects(
    runRealStackLifecycle(
      {
        command: "definitely-not-a-real-binary-zzz",
        args: [],
        cwd: REPO,
        healthUrl: "http://127.0.0.1:1/health",
        startupTimeoutMs: 800,
        pollMs: 100,
      },
      async () => {},
    ),
  );
});
