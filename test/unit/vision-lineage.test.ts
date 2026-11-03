import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProbeResult } from "../../src/resilience/probe.ts";
import type { HerdrAgent, HerdrCli } from "../../src/runtime/herdr/HerdrCli.ts";
import type { HandoffLineageInput, LineageEmitter } from "../../src/runtime/herdr/lineage.ts";
import type { VisionDelegateSettings } from "../../src/visionDelegation/config.ts";
import { VisionDelegator } from "../../src/visionDelegation/delegate.ts";
import { emitVisionLineage, makeVisionLineageHook } from "../../src/visionDelegation/lineage.ts";
import { resultPath } from "../../src/visionDelegation/protocol.ts";
import { VisionRegistry } from "../../src/visionDelegation/registry.ts";
import type { LineageEvent } from "../../src/visionDelegation/types.ts";

function recorder(): { emitter: LineageEmitter; calls: HandoffLineageInput[] } {
  const calls: HandoffLineageInput[] = [];
  const emitter = { handoff: (i: HandoffLineageInput) => void calls.push(i) } as unknown as LineageEmitter;
  return { emitter, calls };
}

const ev = (over: Partial<LineageEvent> = {}): LineageEvent => ({
  phase: "out",
  requestId: "req-1",
  fromSession: "sess-text",
  toSession: "sess-vision",
  fromModel: "text-model",
  toModel: "lab/qwen3.8-vision",
  outcome: "ok",
  ...over,
});

test("out emits cause vision_delegate with the text and vision models", () => {
  const { emitter, calls } = recorder();
  emitVisionLineage(emitter, ev());
  assert.deepEqual(calls, [
    {
      id: "vision-req-1-out",
      kind: "vision",
      missionId: null,
      fromSession: "sess-text",
      toSession: "sess-vision",
      state: "acknowledged",
      checkpointSha: null,
      cause: "vision_delegate",
      fromModel: "text-model",
      toModel: "lab/qwen3.8-vision",
    },
  ]);
});

test("back with ok emits cause vision_return, kind vision and a committed state", () => {
  const { emitter, calls } = recorder();
  emitVisionLineage(emitter, ev({ phase: "back" }));
  assert.equal(calls.length, 1);
  const c = calls[0] as HandoffLineageInput;
  assert.equal(c.id, "vision-req-1-back");
  assert.equal(c.cause, "vision_return");
  assert.equal(c.kind, "vision");
  assert.equal(c.state, "committed");
  assert.equal(c.fromSession, "sess-vision");
  assert.equal(c.toSession, "sess-text");
  assert.equal(c.fromModel, "text-model");
  assert.equal(c.toModel, "lab/qwen3.8-vision");
  assert.equal(c.missionId, null);
  assert.equal(c.checkpointSha, null);
});

test("partial uses vision_partial, failed vision_failed, timeout vision_timeout", () => {
  const want = [
    ["partial", "vision_partial", "committed"],
    ["failed", "vision_failed", "failed"],
    ["timeout", "vision_timeout", "failed"],
  ] as const;
  for (const [outcome, kind, state] of want) {
    const { emitter, calls } = recorder();
    emitVisionLineage(emitter, ev({ phase: "back", outcome }));
    assert.equal(calls[0]?.kind, kind);
    assert.equal(calls[0]?.state, state);
  }
});

test("a back event with no vision session reports failed from the original session to null", () => {
  const { emitter, calls } = recorder();
  emitVisionLineage(emitter, ev({ phase: "back", toSession: null, outcome: "failed" }));
  const c = calls[0] as HandoffLineageInput;
  assert.equal(c.fromSession, "sess-text");
  assert.equal(c.toSession, null);
  assert.equal(c.state, "failed");
  // Even an ok outcome cannot be committed without a vision session.
  emitVisionLineage(emitter, ev({ phase: "back", toSession: null, outcome: "ok" }));
  assert.equal(calls[1]?.state, "failed");
});

test("ids are vision-<requestId>-out and -back so a retry dedupes", () => {
  const { emitter, calls } = recorder();
  emitVisionLineage(emitter, ev({ requestId: "abc" }));
  emitVisionLineage(emitter, ev({ requestId: "abc", phase: "back" }));
  emitVisionLineage(emitter, ev({ requestId: "abc" }));
  assert.deepEqual(
    calls.map((c) => c.id),
    ["vision-abc-out", "vision-abc-back", "vision-abc-out"],
  );
});

test("a null emitter does nothing", () => {
  assert.doesNotThrow(() => emitVisionLineage(null, ev()));
  assert.doesNotThrow(() => makeVisionLineageHook(null)(ev()));
});

test("an emitter that throws never breaks the caller", () => {
  const emitter = {
    handoff: () => {
      throw new Error("sink down");
    },
  } as unknown as LineageEmitter;
  assert.doesNotThrow(() => emitVisionLineage(emitter, ev()));
  assert.doesNotThrow(() => makeVisionLineageHook(emitter)(ev({ phase: "back" })));
});

// --- integration with a real VisionDelegator ---------------------------------

const IMG = { data: Buffer.from("fake png bytes").toString("base64"), mimeType: "image/png" };
const healthy = async (): Promise<ProbeResult> => ({ healthy: true, authoritative: true });

function fakeHerdr(): HerdrCli {
  const noop = async () => undefined;
  const live: HerdrAgent = {
    agent_status: "working",
    cwd: "/work/repo",
    pane_id: "vision-pane-1",
    workspace_id: "w1",
    revision: 1,
    state_change_seq: 1,
  };
  return {
    status: async () => ({ ok: true, serverVersion: "0.9.1", protocol: 22 }),
    listAgents: async () => [],
    getAgent: async () => live,
    readAgent: async () => "",
    prompt: noop,
    wait: noop,
    startAgent: noop,
    sendKeys: noop,
    closePane: noop,
    createWorkspace: noop,
    createWorktree: noop,
    splitPane: async () => ({ paneId: "vision-pane-1" }),
  } as unknown as HerdrCli;
}

function delegatorWith(emitter: LineageEmitter, dir: string, ids: string[], clock: { t: number; fire: () => void }) {
  const settings: VisionDelegateSettings = {
    enabled: true,
    waitSeconds: 30,
    aliasPreference: ["qwen3.8-vision"],
    notes: [],
  };
  return new VisionDelegator({
    herdr: fakeHerdr(),
    settings,
    models: [{ provider: "lab", id: "qwen3.8-vision", input: ["text", "image"] }],
    probeFor: healthy,
    registry: new VisionRegistry(join(dir, "registry.json")),
    artifactDir: join(dir, "vision"),
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
      clock.fire();
    },
    newId: () => ids.shift() ?? "req-x",
    textModel: "text-model",
    originPaneId: "origin-pane",
    lineage: makeVisionLineageHook(emitter),
  });
}

test("a real VisionDelegator emits linked out/back handoffs for ok and timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-lineage-"));
  try {
    const { emitter, calls } = recorder();
    const clock = {
      t: 0,
      fire: () => {
        if (clock.t >= 2000 && !written) {
          written = true;
          const reqDir = join(dir, "vision", "req-1");
          const req = JSON.parse(readFileSync(join(reqDir, "request.json"), "utf8"));
          mkdirSync(join(reqDir, "results"), { recursive: true });
          writeFileSync(
            resultPath(reqDir, "req-1"),
            JSON.stringify({
              request_id: req.request_id,
              status: "ok",
              description: "d",
              text_in_image: "",
              findings_for_task: "f",
              uncertainties: [],
              images: req.images.map((i: { path: string; sha256: string }) => ({ path: i.path, sha256: i.sha256 })),
            }),
          );
        }
      },
    };
    let written = false;
    const d = delegatorWith(emitter, dir, ["req-1", "req-2"], clock);
    const base = { sessionId: "session-abcdef123456", cwd: "/work/repo", text: "t", images: [IMG], messages: [] };
    await d.handle(base);
    await d.handle(base); // no result is ever written for req-2, so it times out
    const summary = calls.map((c) => [c.id, c.cause, c.kind, c.state]);
    assert.deepEqual(summary, [
      ["vision-req-1-out", "vision_delegate", "vision", "acknowledged"],
      ["vision-req-1-back", "vision_return", "vision", "committed"],
      ["vision-req-2-out", "vision_delegate", "vision", "acknowledged"],
      ["vision-req-2-back", "vision_return", "vision_timeout", "failed"],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
