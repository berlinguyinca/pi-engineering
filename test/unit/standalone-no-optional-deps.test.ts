/**
 * Standalone proof (acceptance 1 seed): Pi runs a mission/worker path with
 * AutoSpec, GitHub, InferWeave and Herdr all unconfigured. No network, no
 * throw, and no control-plane outbox or lineage state is created.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeFile } from "node:fs/promises";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { createIngestFromEnv } from "../../src/runtime/herdr/ingestFromEnv.ts";
import { resolveStateRoot } from "../../src/runtime/isolation/stateDir.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const OPTIONAL_ENV = /^(HERDR_|AUTOSPEC_|INFERWEAVE_|GITHUB_|GH_|PI_GATEWAY_)/;

test("a mission runs end to end with every optional adapter absent and touches no network", async () => {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (OPTIONAL_ENV.test(key)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(`fetch ${String(input)}`);
    throw new Error("network is forbidden in standalone mode");
  }) as typeof fetch;
  // Every net-based client (http, https, named imports of connect) goes through Socket.prototype.connect.
  const realSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const target = args[0] as { path?: string } | string | undefined;
    const isUnixPath = typeof target === "string" ? Number.isNaN(Number(target)) : typeof target?.path === "string";
    if (!isUnixPath) calls.push(`connect ${JSON.stringify(args[0])}`);
    if (!isUnixPath) throw new Error("TCP sockets are forbidden in standalone mode");
    return (realSocketConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-standalone-agent-"));
  const fixture = await makeFixtureRepo();
  try {
    assert.equal(createIngestFromEnv(process.env), null, "no Herdr ingest without configuration");

    const worker = new FakeWorkerExecutor({
      planner: () => ({
        status: "completed",
        summary: "planned",
        details: {
          tasks: [
            {
              title: "implement add",
              kind: "implementation",
              risk: "medium",
              depends_on: [],
              scope_paths: ["src/add.js"],
            },
          ],
        },
      }),
      scout: () => ({ status: "completed", summary: "scouted", details: {} }),
      implementer: async (req) => {
        await writeFile(join(req.cwd, "src", "add.js"), "export function add(a, b) {\n  return a + b;\n}\n");
        return { status: "completed", summary: "implemented", details: {} };
      },
      reviewer: () => ({ status: "completed", summary: "clean", details: { findings: [] } }),
    });
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker,
      verifier: new CommandVerifier(),
      agentDir, // empty: nothing from the operator's real providers / settings
    });
    try {
      const plan = await rt.plan("build add");
      const result = await rt.executePlan(plan.plan_work_item.id, { parallel: false });
      assert.equal(result.outcome, "completed", `expected completed, got ${result.outcome}: ${result.summary}`);
    } finally {
      await rt.close();
    }

    assert.deepEqual(calls, [], "no network or socket call");
    const controlPlane = join(resolveStateRoot(), "control-plane");
    const leftovers = existsSync(controlPlane) ? readdirSync(controlPlane) : [];
    assert.deepEqual(
      leftovers.filter((f) => f.startsWith("outbox") || f.startsWith("seq") || f === "instance-id"),
      [],
      "no outbox or sequence state without an emitter",
    );
  } finally {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realSocketConnect;
    rmSync(agentDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
    await fixture.cleanup();
  }
});
