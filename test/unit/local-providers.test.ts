import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_TOKENS,
  partitionByToolSupport,
  readCapabilityVerdicts,
  registerLocalProviders,
} from "../../src/workers/localProviders.ts";

/** A ModelRuntime stub that records what a provider was registered with. */
function fakeRuntime(): { registered: Array<{ id: string; config: any }>; runtime: ModelRuntime } {
  const registered: Array<{ id: string; config: any }> = [];
  const runtime = {
    registerProvider(id: string, config: any) {
      registered.push({ id, config });
    },
  } as unknown as ModelRuntime;
  return { registered, runtime };
}

/** Assert exactly one provider was registered and hand back its config. */
function onlyConfig(registered: Array<{ id: string; config: any }>): any {
  assert.equal(registered.length, 1, `expected exactly one registered provider, got ${registered.length}`);
  const entry = registered[0];
  assert.ok(entry);
  return entry.config;
}

/** Run `fn` with QWEN_NODES_FILE pointing at a temp file holding `nodes`. */
async function withNodesFile(nodes: unknown, fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "localproviders-"));
  const path = join(dir, "qwen-nodes.json");
  await writeFile(path, JSON.stringify(nodes), "utf-8");
  const prior = process.env.QWEN_NODES_FILE;
  process.env.QWEN_NODES_FILE = path;
  try {
    await fn();
  } finally {
    if (prior === undefined) delete process.env.QWEN_NODES_FILE;
    else process.env.QWEN_NODES_FILE = prior;
    await rm(dir, { recursive: true, force: true });
  }
}

async function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

const nodeWith = (models: unknown[]) => ({
  nodes: [
    {
      provider: "metabolomics",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-test",
      contextWindow: 262144,
      models,
    },
  ],
});

test("partition: a model probed unable to call tools is held out", () => {
  const { kept, heldOut } = partitionByToolSupport(
    [
      { id: "broken-model", tools: false },
      { id: "working-model", tools: true },
    ],
    {},
  );
  assert.deepEqual(
    kept.map((m) => m.id),
    ["working-model"],
  );
  assert.deepEqual(heldOut, ["broken-model"]);
});

test("partition: an unjudged model is kept, because missing is not the same as broken", () => {
  // The one time a missing verdict was read as "no tools", a working model was
  // benched across every host running the probe.
  const { kept, heldOut } = partitionByToolSupport([{ id: "unjudged-model" }], {});
  assert.deepEqual(
    kept.map((m) => m.id),
    ["unjudged-model"],
  );
  assert.deepEqual(heldOut, []);
});

test("partition: the verdict files fill in for a model that says nothing", () => {
  const { kept, heldOut } = partitionByToolSupport([{ id: "a" }, { id: "b" }], { a: false, b: true });
  assert.deepEqual(
    kept.map((m) => m.id),
    ["b"],
  );
  assert.deepEqual(heldOut, ["a"]);
});

test("partition: an explicit statement on the model beats a cached verdict", () => {
  // The nodes file is written from the probe AND the operator pin, so it is the
  // freshest operator-authored statement available and wins, exactly as it does
  // in the interactive extension.
  const { kept } = partitionByToolSupport([{ id: "a", tools: true }], { a: false });
  assert.deepEqual(
    kept.map((m) => m.id),
    ["a"],
  );
});

test("readCapabilityVerdicts: the operator pin beats the probe cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caps-"));
  await writeFile(
    join(dir, "capability-cache.json"),
    JSON.stringify({ models: { m: { tools: false, reason: "probe said so" } } }),
    "utf-8",
  );
  await writeFile(
    join(dir, "capabilities.json"),
    JSON.stringify({ models: { m: { tools: true, reason: "operator pin" } } }),
    "utf-8",
  );
  const verdicts = await readCapabilityVerdicts(dir);
  assert.equal(verdicts.m, true);
  await rm(dir, { recursive: true, force: true });
});

test("readCapabilityVerdicts: absent directory yields no verdicts rather than throwing", async () => {
  const verdicts = await readCapabilityVerdicts(join(tmpdir(), "definitely-not-here-4f8a1c"));
  assert.deepEqual(verdicts, {});
});

test("register: a tool-incapable model is never registered on a worker", async () => {
  await withNodesFile(
    nodeWith([
      { id: "working-model", contextWindow: 262144 },
      { id: "broken-model", contextWindow: 950272, tools: false },
    ]),
    async () => {
      const { registered, runtime } = fakeRuntime();
      await registerLocalProviders(runtime, { verdicts: {} });
      const ids = onlyConfig(registered).models.map((m: { id: string }) => m.id);
      assert.deepEqual(ids, ["working-model"]);
    },
  );
});

test("register: a verdict held in the capability files is honoured too", async () => {
  await withNodesFile(nodeWith([{ id: "guessed-model" }]), async () => {
    const { registered, runtime } = fakeRuntime();
    await registerLocalProviders(runtime, { verdicts: { "guessed-model": false } });
    assert.equal(registered.length, 0, "a node whose only model is benched must not register");
  });
});

test("register: QWEN_ALLOW_NO_TOOLS=1 puts benched models back in the lane", async () => {
  await withNodesFile(nodeWith([{ id: "broken-model", tools: false }]), async () => {
    await withEnv("QWEN_ALLOW_NO_TOOLS", "1", async () => {
      const { registered, runtime } = fakeRuntime();
      await registerLocalProviders(runtime, { verdicts: {} });
      const model = onlyConfig(registered).models[0];
      assert.ok(model);
      assert.equal(model.id, "broken-model");
    });
  });
});

test("register: completion budget is 32768, not the 8192 this file used to hardcode", async () => {
  // The interactive extension allows 32768 for the same model on the same node.
  // A worker capped at 8192 truncated long patches silently, which read as a
  // model giving up rather than as two readers of one config disagreeing.
  await withNodesFile(nodeWith([{ id: "a" }]), async () => {
    const { registered, runtime } = fakeRuntime();
    await registerLocalProviders(runtime, { verdicts: {} });
    const model = onlyConfig(registered).models[0];
    assert.ok(model);
    assert.equal(model.maxTokens, DEFAULT_MAX_TOKENS);
    assert.equal(DEFAULT_MAX_TOKENS, 32768);
  });
});

test("register: maxTokens is overridable per node and per model, model first", async () => {
  await withNodesFile(
    {
      nodes: [
        {
          provider: "metabolomics",
          baseUrl: "https://llm.example/v1",
          maxTokens: 16384,
          models: [{ id: "a" }, { id: "b", maxTokens: 65536 }],
        },
      ],
    },
    async () => {
      const { registered, runtime } = fakeRuntime();
      await registerLocalProviders(runtime, { verdicts: {} });
      const models = onlyConfig(registered).models as Array<{ id: string; maxTokens: number }>;
      const byId = Object.fromEntries(models.map((m) => [m.id, m.maxTokens]));
      assert.equal(byId.a, 16384, "node default applies");
      assert.equal(byId.b, 65536, "model statement wins");
    },
  );
});

test("register: reasoning_effort is off unless the node declares it", async () => {
  // A plain llama.cpp router ignores `reasoning_effort`; the gateway honours it.
  // Sending it unconditionally is how a node ends up "thinking" nobody asked it
  // to, so the node has to opt in.
  await withNodesFile(
    {
      nodes: [
        { provider: "plain", baseUrl: "http://127.0.0.1:8080/v1", models: [{ id: "m" }] },
        { provider: "gw", baseUrl: "https://llm.example/v1", supportsReasoningEffort: true, models: [{ id: "m" }] },
      ],
    },
    async () => {
      const { registered, runtime } = fakeRuntime();
      await registerLocalProviders(runtime, { verdicts: {} });
      const byProvider = Object.fromEntries(registered.map((r) => [r.id, r.config.models[0].compat]));
      assert.equal(byProvider.plain.supportsReasoningEffort, false);
      assert.equal(byProvider.gw.supportsReasoningEffort, true);
      assert.equal(byProvider.plain.thinkingFormat, "qwen-chat-template");
    },
  );
});

test("register: a node with no models at all is skipped, not registered empty", async () => {
  await withNodesFile({ nodes: [{ provider: "empty", baseUrl: "https://llm.example/v1" }] }, async () => {
    const { registered, runtime } = fakeRuntime();
    await registerLocalProviders(runtime, { verdicts: {} });
    assert.equal(registered.length, 0);
  });
});
