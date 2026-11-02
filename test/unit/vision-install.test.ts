import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import extension from "../../extensions/index.ts";
import type { VisionDelegateSettings } from "../../src/visionDelegation/config.ts";
import type { VisionDelegateInput, VisionDelegateOutput } from "../../src/visionDelegation/delegate.ts";
import {
  type VisionHandler,
  installVisionDelegation,
  registerVisionDelegation,
} from "../../src/visionDelegation/install.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    on(event: string, handler: (event: never, ctx: never) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler as unknown as Handler]);
    },
    input(): Handler {
      const list = handlers.get("input") ?? [];
      assert.equal(list.length, 1, "exactly one input handler");
      return list[0] as Handler;
    },
  };
}

const IMG = { type: "image", data: "aW1n", mimeType: "image/png" };
const TEXT_MODEL = { provider: "lab", id: "qwen3.8-27b", input: ["text"] };
const VISION_MODEL = { provider: "lab", id: "qwen3.8-vision", input: ["text", "image"] };

function fakeCtx(over: { model?: unknown; signal?: AbortSignal } = {}) {
  const statuses: Array<[string, string | undefined]> = [];
  const notes: Array<[string, string]> = [];
  const ctx = {
    model: "model" in over ? over.model : TEXT_MODEL,
    cwd: "/work/project",
    signal: over.signal,
    sessionManager: {
      getSessionId: () => "sess-1234",
      getBranch: () => [
        { type: "message", message: { role: "user", content: "fix the layout" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "send a screenshot" }] } },
        { type: "custom", message: { role: "user", content: "ignored" } },
      ],
    },
    ui: {
      setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      notify: (message: string, type: string) => notes.push([message, type]),
    },
  };
  return { ctx, statuses, notes };
}

const event = (over: Record<string, unknown> = {}) => ({
  type: "input",
  text: "what is wrong here?",
  images: [IMG],
  source: "interactive",
  ...over,
});

const TRANSFORM: VisionDelegateOutput = {
  action: "transform",
  text: "what is wrong here?\n\n[vision analysis]",
  images: [],
};

function fakeDelegator(impl?: (input: VisionDelegateInput) => Promise<VisionDelegateOutput>) {
  const calls: VisionDelegateInput[] = [];
  const delegator: VisionHandler = {
    handle: async (input) => {
      calls.push(input);
      return impl ? impl(input) : TRANSFORM;
    },
  };
  return { delegator, calls };
}

function setup(build?: (ctx: unknown) => Promise<VisionHandler | null>) {
  const pi = fakePi();
  const d = fakeDelegator();
  let builds = 0;
  registerVisionDelegation(pi, {
    build:
      build ??
      (async () => {
        builds++;
        return d.delegator;
      }),
  });
  return { pi, d, builds: () => builds };
}

test("passes through when the model accepts images", async () => {
  const { pi, d, builds } = setup();
  const { ctx, notes } = fakeCtx({ model: VISION_MODEL });
  assert.deepEqual(await pi.input()(event(), ctx), { action: "continue" });
  assert.equal(builds(), 0);
  assert.equal(d.calls.length, 0);
  assert.equal(notes.length, 0);
});

test("passes through when there are no images", async () => {
  const { pi, builds } = setup();
  const { ctx, notes } = fakeCtx();
  assert.deepEqual(await pi.input()(event({ images: [] }), ctx), { action: "continue" });
  assert.deepEqual(await pi.input()(event({ images: undefined }), ctx), { action: "continue" });
  assert.equal(builds(), 0);
  assert.equal(notes.length, 0);
});

test("passes through when there is no model", async () => {
  const { pi, builds } = setup();
  const { ctx } = fakeCtx({ model: undefined });
  assert.deepEqual(await pi.input()(event(), ctx), { action: "continue" });
  assert.equal(builds(), 0);
});

test("passes through for the rpc source and for the extension source (R16)", async () => {
  const { pi, builds } = setup();
  for (const source of ["rpc", "extension"]) {
    const { ctx, notes } = fakeCtx();
    assert.deepEqual(await pi.input()(event({ source }), ctx), { action: "continue" }, source);
    assert.equal(notes.length, 0, source);
  }
  assert.equal(builds(), 0);
});

test("delegates for a text-only model and returns the transform unchanged", async () => {
  const { pi, d } = setup();
  const { ctx } = fakeCtx();
  const out = await pi.input()(event(), ctx);
  assert.equal(out, TRANSFORM, "the delegator's result object is returned as is");
  assert.equal(d.calls.length, 1);
  const call = d.calls[0] as VisionDelegateInput;
  assert.equal(call.cwd, "/work/project");
  assert.equal(call.text, "what is wrong here?");
  assert.deepEqual(call.images, [{ data: "aW1n", mimeType: "image/png" }], "images mapped to {data, mimeType}");
  assert.deepEqual(call.messages, [
    { role: "user", text: "fix the layout" },
    { role: "assistant", text: "send a screenshot" },
  ]);
  assert.equal(call.signal, undefined, "an idle Pi exposes no abort signal");
});

test("session id comes from ctx.sessionManager.getSessionId()", async () => {
  const { pi, d } = setup();
  const { ctx } = fakeCtx();
  await pi.input()(event(), ctx);
  assert.equal(d.calls[0]?.sessionId, "sess-1234");
});

test("passes ctx.signal through when Pi exposes one", async () => {
  const { pi, d } = setup();
  const controller = new AbortController();
  const { ctx } = fakeCtx({ signal: controller.signal });
  await pi.input()(event(), ctx);
  assert.equal(d.calls[0]?.signal, controller.signal);
});

test("the status callback drives ctx.ui.setStatus('vision-delegation', ...)", async () => {
  const { pi, d } = setup();
  const { ctx, statuses } = fakeCtx();
  await pi.input()(event(), ctx);
  const status = d.calls[0]?.status;
  assert.ok(status);
  status("analyzing image…");
  status(undefined);
  assert.deepEqual(statuses, [
    ["vision-delegation", "analyzing image…"],
    ["vision-delegation", undefined],
  ]);
});

test("a delegator build failure returns continue and notifies the user", async () => {
  const { pi } = setup(async () => {
    throw new Error("registry unreadable");
  });
  const { ctx, notes } = fakeCtx();
  assert.deepEqual(await pi.input()(event(), ctx), { action: "continue" });
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.[1], "warning");
  assert.match(notes[0]?.[0] ?? "", /not analyzed/i);
  assert.match(notes[0]?.[0] ?? "", /registry unreadable/);
});

test("a null delegator returns continue and notifies", async () => {
  const { pi } = setup(async () => null);
  const { ctx, notes } = fakeCtx();
  assert.deepEqual(await pi.input()(event(), ctx), { action: "continue" });
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.[1], "warning");
  assert.match(notes[0]?.[0] ?? "", /not analyzed/i);
});

test("a delegator handle that throws returns continue and notifies", async () => {
  const pi = fakePi();
  const d = fakeDelegator(async () => {
    throw new Error("boom");
  });
  registerVisionDelegation(pi, { build: async () => d.delegator });
  const { ctx, notes } = fakeCtx();
  assert.deepEqual(await pi.input()(event(), ctx), { action: "continue" });
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.[1], "warning");
  assert.match(notes[0]?.[0] ?? "", /not analyzed/i);
  assert.match(notes[0]?.[0] ?? "", /boom/);
});

test("a streaming input is not delegated: continue, with a plain notice (R17)", async () => {
  const { pi, d, builds } = setup();
  for (const streamingBehavior of ["steer", "followUp"]) {
    const { ctx, notes } = fakeCtx();
    assert.deepEqual(await pi.input()(event({ streamingBehavior }), ctx), { action: "continue" });
    assert.equal(notes.length, 1, streamingBehavior);
    assert.equal(notes[0]?.[1], "warning");
    assert.match(notes[0]?.[0] ?? "", /not analyzed/i);
    assert.match(notes[0]?.[0] ?? "", /busy/i);
  }
  assert.equal(builds(), 0);
  assert.equal(d.calls.length, 0);
});

// --- installVisionDelegation: the settings gate used by extensions/index.ts -----------------------------

const SETTINGS: VisionDelegateSettings = {
  enabled: true,
  waitSeconds: 300,
  aliasPreference: ["qwen3.8-vision"],
  notes: [],
};

function install(settings: VisionDelegateSettings | (() => Promise<VisionDelegateSettings>)) {
  const pi = fakePi();
  const d = fakeDelegator();
  const counts = { load: 0, make: 0 };
  const made: unknown[] = [];
  installVisionDelegation(pi, {
    loadSettings: async () => {
      counts.load++;
      return typeof settings === "function" ? settings() : settings;
    },
    makeDelegator: async (s, current) => {
      counts.make++;
      made.push([s, current]);
      return d.delegator;
    },
  });
  return { pi, d, counts, made };
}

test("install: settings are not read at load time", () => {
  const { pi, counts } = install(SETTINGS);
  assert.equal(counts.load, 0);
  assert.equal((pi.handlers.get("input") ?? []).length, 1);
});

test("install: settings are not read for input that never needs delegation", async () => {
  const { pi, counts } = install(SETTINGS);
  await pi.input()(event({ images: [] }), fakeCtx().ctx);
  await pi.input()(event(), fakeCtx({ model: VISION_MODEL }).ctx);
  await pi.input()(event({ source: "rpc" }), fakeCtx().ctx);
  assert.equal(counts.load, 0);
});

test("install: when settings.enabled is false nothing is delegated and nothing is built", async () => {
  const { pi, d, counts } = install({ ...SETTINGS, enabled: false });
  const { ctx, notes } = fakeCtx();
  assert.deepEqual(await pi.input()(event(), ctx), { action: "continue" });
  assert.deepEqual(await pi.input()(event(), ctx), { action: "continue" });
  assert.equal(counts.make, 0);
  assert.equal(d.calls.length, 0);
  assert.equal(notes.length, 0, "the kill switch is silent");
});

test("install: a config note (e.g. malformed block) is shown once", async () => {
  const { pi } = install({ ...SETTINGS, enabled: false, notes: ["vision_delegate off: unknown keys x"] });
  const { ctx, notes } = fakeCtx();
  await pi.input()(event(), ctx);
  await pi.input()(event(), ctx);
  assert.deepEqual(notes, [["vision_delegate off: unknown keys x", "warning"]]);
});

test("install: when enabled, settings load once and one delegator is cached for the process", async () => {
  const { pi, d, counts, made } = install(SETTINGS);
  const first = fakeCtx();
  const second = fakeCtx();
  assert.equal(await pi.input()(event(), first.ctx), TRANSFORM);
  assert.equal(await pi.input()(event(), second.ctx), TRANSFORM);
  assert.equal(counts.load, 1);
  assert.equal(counts.make, 1);
  assert.equal(d.calls.length, 2);
  const [s, current] = made[0] as [unknown, () => unknown];
  assert.equal(s, SETTINGS);
  assert.equal(current(), second.ctx, "the cached delegator sees the latest call's context");
});

test("install: a settings load failure is not cached as success and is reported", async () => {
  let n = 0;
  const { pi, d } = install(async () => {
    n++;
    if (n === 1) throw new Error("disk error");
    return SETTINGS;
  });
  const a = fakeCtx();
  assert.deepEqual(await pi.input()(event(), a.ctx), { action: "continue" });
  assert.match(a.notes[0]?.[0] ?? "", /not analyzed/i);
  const b = fakeCtx();
  assert.equal(await pi.input()(event(), b.ctx), TRANSFORM, "a later call retries the load");
  assert.equal(d.calls.length, 1);
});

test("install: a failed build is retried on the next image", async () => {
  const pi = fakePi();
  const d = fakeDelegator();
  let n = 0;
  installVisionDelegation(pi, {
    loadSettings: async () => SETTINGS,
    makeDelegator: async () => {
      n++;
      if (n === 1) throw new Error("no registry");
      return d.delegator;
    },
  });
  const a = fakeCtx();
  assert.deepEqual(await pi.input()(event(), a.ctx), { action: "continue" });
  assert.equal(a.notes.length, 1);
  assert.equal(await pi.input()(event(), fakeCtx().ctx), TRANSFORM);
});

// --- the live extension -----------------------------------------------------------------------------

function liveInputHandlers(): Handler[] {
  const handlers = new Map<string, Handler[]>();
  (extension as unknown as (pi: unknown) => void)({
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: () => {},
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    setModel: async () => false,
    events: { on: () => {}, emit: () => {} },
  });
  return handlers.get("input") ?? [];
}

test("the live extension installs the vision gate, and vision_delegate.enabled: false keeps it inert", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-install-live-"));
  const saved = process.env.PI_AGENT_DIR;
  try {
    process.env.PI_AGENT_DIR = dir;
    writeFileSync(join(dir, "engineering.yaml"), "vision_delegate:\n  enabled: false\n");
    const inputs = liveInputHandlers();
    assert.equal(inputs.length, 1, "one input handler from the vision delegation");
    const { ctx, notes } = fakeCtx();
    let registryTouched = false;
    const live = {
      ...ctx,
      get modelRegistry() {
        registryTouched = true;
        return {};
      },
    };
    assert.deepEqual(await (inputs[0] as Handler)(event(), live), { action: "continue" });
    assert.equal(notes.length, 0);
    assert.equal(registryTouched, false, "no delegator is built when disabled");
  } finally {
    if (saved === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
