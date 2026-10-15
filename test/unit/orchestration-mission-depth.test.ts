import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import {
  assertRootMissionAllowed,
  childEnv,
  missionDepth,
  missionDepthSpawnHook,
} from "../../src/orchestration/missionMode.ts";
import { IMPLEMENTER_TOOLS } from "../../src/orchestration/realBackends.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

describe("missionDepth (R-MODE recursion guard)", () => {
  it("is 0 when unset and parses a non-negative integer", () => {
    assert.equal(missionDepth({}), 0);
    assert.equal(missionDepth({ PI_MISSION_DEPTH: "0" }), 0);
    assert.equal(missionDepth({ PI_MISSION_DEPTH: "1" }), 1);
    assert.equal(missionDepth({ PI_MISSION_DEPTH: "3" }), 3);
    assert.equal(missionDepth({ PI_MISSION_DEPTH: " 2 " }), 2);
  });

  it("counts anything malformed as depth 1", () => {
    for (const raw of ["abc", "", "-1", "1.5", "1e2", "0x1", "NaN", "Infinity", "2 3", "--1"]) {
      assert.equal(missionDepth({ PI_MISSION_DEPTH: raw }), 1, JSON.stringify(raw));
    }
  });

  it("counts an integer too large to be safe as malformed", () => {
    assert.equal(missionDepth({ PI_MISSION_DEPTH: "99999999999999999999" }), 1);
  });
});

describe("assertRootMissionAllowed", () => {
  it("allows a root mission", () => {
    assert.doesNotThrow(() => assertRootMissionAllowed({}));
    assert.doesNotThrow(() => assertRootMissionAllowed({ PI_MISSION_DEPTH: "0" }));
  });

  it("throws when PI_MISSION_DEPTH is 1, naming the variable", () => {
    assert.throws(() => assertRootMissionAllowed({ PI_MISSION_DEPTH: "1" }), /PI_MISSION_DEPTH/);
    assert.throws(() => assertRootMissionAllowed({ PI_MISSION_DEPTH: "4" }), /nested|root/i);
  });

  it("throws for a malformed count, as depth 1", () => {
    assert.throws(() => assertRootMissionAllowed({ PI_MISSION_DEPTH: "abc" }), /PI_MISSION_DEPTH/);
  });
});

describe("childEnv", () => {
  it("sets the depth to the parent's plus 1 and keeps the rest", () => {
    assert.deepEqual(childEnv({ PATH: "/bin", HOME: "/h" }), { PATH: "/bin", HOME: "/h", PI_MISSION_DEPTH: "1" });
    assert.equal(childEnv({ PI_MISSION_DEPTH: "1" }).PI_MISSION_DEPTH, "2");
    assert.equal(childEnv({ PI_MISSION_DEPTH: "abc" }).PI_MISSION_DEPTH, "2");
  });

  it("drops undefined values and does not mutate its input", () => {
    const parent = { A: "1", B: undefined, PI_MISSION_DEPTH: "2" };
    const child = childEnv(parent);
    assert.equal(Object.hasOwn(child, "B"), false);
    assert.equal(parent.PI_MISSION_DEPTH, "2");
  });
});

describe("the spawn hook against a real child process", () => {
  it("a bash child sees the parent depth plus 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-depth-"));
    const saved = process.env.PI_MISSION_DEPTH;
    try {
      const bash = createBashToolDefinition(dir, { spawnHook: missionDepthSpawnHook });
      for (const [parent, want] of [
        [undefined, "1"],
        ["1", "2"],
        ["abc", "2"],
      ] as const) {
        if (parent === undefined) delete process.env.PI_MISSION_DEPTH;
        else process.env.PI_MISSION_DEPTH = parent;
        const result = await bash.execute(
          "call-1",
          { command: 'printf "depth=%s" "$PI_MISSION_DEPTH"' },
          undefined,
          undefined,
          // The session context is only read to expose session env vars; none is wanted here.
          undefined as unknown as Parameters<typeof bash.execute>[4],
        );
        const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.match(text, new RegExp(`depth=${want}$`), `parent=${parent}`);
      }
    } finally {
      if (saved === undefined) delete process.env.PI_MISSION_DEPTH;
      else process.env.PI_MISSION_DEPTH = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a real PiWorkerExecutor session", () => {
  it("its bash child sees PI_MISSION_DEPTH equal to the parent depth plus 1, with no wall-clock budget", async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "probe-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const call = (res: ServerResponse, name: string, args: unknown) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        chunk({
          role: "assistant",
          tool_calls: [
            { index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        }),
      );
      res.write(chunk({}, "tool_calls"));
      res.end("data: [DONE]\n\n");
    };
    const script = [
      { name: "bash", args: { command: 'printf "%s" "$PI_MISSION_DEPTH" > depth.txt' } },
      {
        name: "worker_result",
        args: {
          status: "completed",
          summary: "wrote the depth",
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
        },
      },
    ];
    let requests = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        const next = script[requests++];
        if (next) call(res, next.name, next.args);
        else res.writeHead(500).end("unexpected extra request");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), "pi-depth-worker-"));
    const saved = process.env.PI_MISSION_DEPTH;
    process.env.PI_MISSION_DEPTH = "2";
    try {
      writeFileSync(
        join(dir, "models.json"),
        JSON.stringify({
          providers: {
            probe: {
              baseUrl: `http://127.0.0.1:${port}/v1`,
              api: "openai-completions",
              apiKey: "k",
              models: [{ id: "probe-model", contextWindow: 100_000, maxTokens: 4096 }],
            },
          },
        }),
      );
      const executor = new PiWorkerExecutor({
        agentDir: dir,
        aps: false,
        gatewayConfig: resolveGatewayConfig({ enabled: false }),
        transientSleep: async () => {},
        transientRand: () => 0,
      });
      const run = await executor.run({
        role: "implementer",
        task: "record the mission depth",
        tools: [...IMPLEMENTER_TOOLS],
        cwd: dir,
        deliverables: ["depth.txt"],
        isolatedWorktree: true,
        modelOverride: { provider: "probe", id: "probe-model" },
      });
      assert.equal(run.result.status, "completed", run.result.summary);
      assert.equal(readFileSync(join(dir, "depth.txt"), "utf8"), "3");
    } finally {
      if (saved === undefined) delete process.env.PI_MISSION_DEPTH;
      else process.env.PI_MISSION_DEPTH = saved;
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
