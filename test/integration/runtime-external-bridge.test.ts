// Exercises the Herdr connection layer; opts back in from the harness-wide
// HERDR_DISABLED default (test/support/isolatedState.ts).
delete process.env.HERDR_DISABLED;
/**
 * T16 wiring through the REAL EngineeringRuntime: with a stored join credential AND `herdr.url` in the global YAML the
 * runtime heartbeats to Herdr by itself; with either missing it sends nothing. Removing `startExternalBridge` from the
 * runtime start-up path makes the first test fail (nothing ever reaches the server).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { ExternalAgentClient } from "../../src/runtime/herdr/externalAgent.ts";
import { resolveStateRoot } from "../../src/runtime/isolation/stateDir.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

const CRED = ["cred", String(process.pid), "rt"].join("-");

async function plane() {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if ((req.url ?? "").endsWith("/agents/join")) {
      res.statusCode = 201;
      res.end(JSON.stringify({ agent_id: "ag-rt", credential: CRED, device_id: "dev-rt", room_id: "r" }));
      return;
    }
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-eng-extbridge-"));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "f"]);
  return root;
}

const open = (agentDir: string) =>
  EngineeringRuntime.open({ cwd: repo(), agentDir, worker: new FakeWorkerExecutor({}) } as never);
const heartbeats = (seen: Array<{ url: string }>) => seen.filter((s) => s.url.endsWith("/heartbeat")).length;
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
};

describe("the runtime starts the external-agent bridge itself", () => {
  it("credential + herdr.url: the runtime heartbeats with Agent auth; the bridge stops with the runtime", async () => {
    const p = await plane();
    try {
      const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
      writeFileSync(join(agentDir, "engineering.yaml"), `herdr:\n  url: ${p.url}\n`);
      mkdirSync(resolveStateRoot(), { recursive: true });
      await ExternalAgentClient.join(p.url, "code", resolveStateRoot());
      const before = p.seen.length;
      const rt = await open(agentDir);
      try {
        await until(() => heartbeats(p.seen) > 0);
        assert.ok(heartbeats(p.seen) > 0, "the runtime sent a heartbeat");
        assert.equal(p.seen.at(-1)?.auth, `Agent ${CRED}`);
        assert.ok(rt.externalBridge, "the bridge is held by the runtime");
        assert.ok(p.seen.length > before);
      } finally {
        await rt.close();
      }
    } finally {
      await p.close();
    }
  });

  it("no herdr.url in the YAML: nothing is sent and no bridge exists", async () => {
    const p = await plane();
    try {
      const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
      mkdirSync(resolveStateRoot(), { recursive: true });
      await ExternalAgentClient.join(p.url, "code", resolveStateRoot());
      const joinCalls = p.seen.length;
      const rt = await open(agentDir);
      try {
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(rt.externalBridge, null);
        assert.equal(p.seen.length, joinCalls, "no request after start-up");
      } finally {
        await rt.close();
      }
    } finally {
      await p.close();
    }
  });
});
