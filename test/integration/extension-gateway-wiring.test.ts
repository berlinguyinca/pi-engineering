/**
 * The gateway event wiring inside the extension.
 *
 * Every review so far has noted that this layer is untested, and it has now
 * cost something real: a scoping fix to the `message_end` handler was written,
 * committed, and described in a commit message, but silently never applied —
 * the edit targeted a two-line form the formatter had already collapsed. The
 * unit tests could not catch it because they test `isAccountWideRefusal`, which
 * was correct; the bug was that this handler did not call it.
 *
 * So these tests load the real extension against a stub `ExtensionAPI`, capture
 * the handlers it registers, and drive them — asserting which admission method
 * each path actually reaches.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../../extensions/index.ts";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { setSharedAdmissionController } from "../../src/gateway/config.ts";

const PRODUCTION_429 =
  '429: {"active":4,"active_limit":4,"message":"inference admission: queue_timeout","queue_limit":100,"queued":30,' +
  '"reason":"queue_timeout","request_id":"wiring","retry_after_ms":30000,"scope":"agent","type":"inference_admission"}';

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Load the extension and capture the event handlers it registers. */
function loadExtension(): Map<string, Handler[]> {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
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
  };
  (extension as unknown as (pi: unknown) => void)(pi);
  return handlers;
}

/** A controller whose calls we can observe, installed as the shared one. */
function observableController() {
  const calls: string[] = [];
  const controller = new AdmissionController({
    maxConcurrency: 4,
    reservedSlots: 1,
    maxWaitMs: Number.POSITIVE_INFINITY,
    jitterMs: 0,
    sleep: async () => {},
  });
  const wrap = <K extends "noteWait" | "noteObservedWait">(name: K) => {
    const original = controller[name].bind(controller);
    (controller as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls.push(name);
      return (original as (...a: unknown[]) => unknown)(...args);
    };
  };
  wrap("noteWait");
  wrap("noteObservedWait");
  setSharedAdmissionController(controller);
  return { controller, calls };
}

function ctxStub() {
  return {
    ui: { notify: () => {}, custom: () => ({ close: () => {} }), setFooter: () => {}, onTerminalInput: () => () => {} },
    mode: "tui",
    cwd: process.cwd(),
    signal: undefined,
    model: undefined,
    modelRegistry: undefined,
    getContextUsage: () => undefined,
    isIdle: () => true,
  };
}

async function fireMessageEnd(handlers: Map<string, Handler[]>, errorMessage: string): Promise<void> {
  for (const handler of handlers.get("message_end") ?? []) {
    await handler({ message: { role: "assistant", stopReason: "error", errorMessage } }, ctxStub());
  }
}

test("wiring: a bare 503 on message_end does not park the whole process", async () => {
  // The regression that shipped: this handler kept the deprecated
  // `source === "body"` discriminator while its comment claimed otherwise. A
  // bare 503 is one model's outage, and arming the process-wide cooldown from it
  // stalls workers on models that are answering perfectly well.
  const { controller, calls } = observableController();
  try {
    await fireMessageEnd(loadExtension(), "503 no worker for model");

    assert.deepEqual(calls, ["noteObservedWait"], "a single model's outage must not become a runtime-wide stall");
    assert.equal(controller.cooldownRemainingMs(), 0);
  } finally {
    setSharedAdmissionController(undefined);
  }
});

test("wiring: an admission 429 on message_end parks every caller", async () => {
  const { controller, calls } = observableController();
  try {
    await fireMessageEnd(loadExtension(), PRODUCTION_429);

    assert.deepEqual(calls, ["noteWait"], "an account-wide refusal is exactly what the shared cooldown is for");
    assert.ok(controller.cooldownRemainingMs() > 0);
  } finally {
    setSharedAdmissionController(undefined);
  }
});

test("wiring: a 429 carrying only a Retry-After header is still account-wide", async () => {
  // The precise case the two discriminators disagreed on: `source` is "header",
  // so the old test sent it down the caller-scoped path.
  const { controller, calls } = observableController();
  try {
    await fireMessageEnd(loadExtension(), "429 Too Many Requests");

    assert.deepEqual(calls, ["noteWait"]);
    assert.ok(controller.cooldownRemainingMs() > 0);
  } finally {
    setSharedAdmissionController(undefined);
  }
});

test("wiring: a non-gateway assistant error touches the controller at all", async () => {
  const { calls } = observableController();
  try {
    await fireMessageEnd(loadExtension(), "401 invalid api key");
    assert.deepEqual(calls, [], "waiting cannot fix a bad key");
  } finally {
    setSharedAdmissionController(undefined);
  }
});

test("wiring: the gateway hooks are actually registered", () => {
  // If the extension stopped wiring these, every test above would pass
  // vacuously by firing an empty handler list.
  const handlers = loadExtension();
  for (const name of ["message_end", "before_provider_request", "after_provider_response", "session_start"]) {
    assert.ok((handlers.get(name) ?? []).length > 0, `${name} has no handler`);
  }
});

// ─── Command wiring ─────────────────────────────────────────────────────────
// Both reviews flagged the commands as untested, and untested wiring is how a
// scoping fix shipped unapplied earlier in this branch.

/** Load the extension, capturing commands as well as event handlers. */
function loadWithCommands(): Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }> {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
  const pi = {
    on: () => {},
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => {
      commands.set(name, options);
    },
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    setModel: async () => false,
    events: { on: () => {}, emit: () => {} },
  };
  (extension as unknown as (pi: unknown) => void)(pi);
  return commands;
}

function notifyingCtx() {
  const notices: Array<{ text: string; level: string }> = [];
  return {
    notices,
    ctx: {
      ...ctxStub(),
      ui: { ...ctxStub().ui, notify: (text: string, level: string) => notices.push({ text, level }) },
    },
  };
}

test("wiring: /gateway is registered and renders without a model or registry", async () => {
  const commands = loadWithCommands();
  const cmd = commands.get("gateway");
  assert.ok(cmd, "/gateway must be registered");

  const { ctx, notices } = notifyingCtx();
  await cmd.handler("", ctx);

  assert.equal(notices.length, 1);
  // A session with nothing resolved yet must still get a usable report rather
  // than an exception.
  assert.match(notices[0]?.text ?? "", /Slots:/);
  assert.match(notices[0]?.text ?? "", /Policy:/);
});

test("wiring: /refresh-models is registered and refuses without a provider", async () => {
  const commands = loadWithCommands();
  const cmd = commands.get("refresh-models");
  assert.ok(cmd, "/refresh-models must be registered");

  const { ctx, notices } = notifyingCtx();
  // No model selected and no provider argument: the command must say so rather
  // than guessing a provider and rewriting the operator's config against it.
  await cmd.handler("", ctx);

  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.level, "warning");
  assert.match(notices[0]?.text ?? "", /No provider to refresh/);
});

test("wiring: a failing /refresh-models reports that nothing was changed", async () => {
  const commands = loadWithCommands();
  const cmd = commands.get("refresh-models");
  assert.ok(cmd);

  const { ctx, notices } = notifyingCtx();
  // A provider that cannot be reached. The operator's first question is whether
  // their configuration survived, so the answer belongs in the message.
  await cmd.handler("provider-that-does-not-exist", { ...ctx, signal: AbortSignal.abort() });

  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.level, "error");
  assert.match(notices[0]?.text ?? "", /was not changed/);
});

test("wiring: /update is registered and reports without mutating anything", async () => {
  const commands = loadWithCommands();
  const cmd = commands.get("update");
  assert.ok(cmd, "/update must be registered");

  const { ctx, notices } = notifyingCtx();
  await cmd.handler("--check", ctx);

  assert.equal(notices.length, 1);
  // Whatever this checkout's state, the command must produce a usable line
  // rather than an exception or a wall of git output.
  assert.ok((notices[0]?.text ?? "").length > 0);
  assert.ok((notices[0]?.text ?? "").split("\n").length <= 4, "a notice, not a git transcript");
});

test("wiring: update checking survives the gateway being disabled", async () => {
  // Found by fresh-context review. The session_start auto-check was nested
  // inside the gateway-admission guard, so PI_GATEWAY_ADMISSION_ENABLED=0
  // silently switched off update checking too — two unrelated features sharing
  // one switch, which is exactly the kind of coupling nobody discovers until
  // they are stuck on stale code with no idea why.
  const prevGateway = process.env.PI_GATEWAY_ADMISSION_ENABLED;
  const prevUpdate = process.env.PI_SELF_UPDATE;
  process.env.PI_GATEWAY_ADMISSION_ENABLED = "0";
  process.env.PI_SELF_UPDATE = "check";
  setSharedAdmissionController(undefined);
  try {
    const handlers = loadExtension();
    const starts = handlers.get("session_start") ?? [];
    assert.ok(starts.length > 0, "session_start must still be wired with the gateway disabled");

    // Driving them must not throw, and must not block on the network.
    const ctx = ctxStub();
    await Promise.all(starts.map((h) => Promise.resolve(h({}, ctx))));
  } finally {
    if (prevGateway === undefined) delete process.env.PI_GATEWAY_ADMISSION_ENABLED;
    else process.env.PI_GATEWAY_ADMISSION_ENABLED = prevGateway;
    if (prevUpdate === undefined) delete process.env.PI_SELF_UPDATE;
    else process.env.PI_SELF_UPDATE = prevUpdate;
    setSharedAdmissionController(undefined);
  }
});

test("wiring: session_start returns without waiting on the update check", async () => {
  // The "deliberately not awaited" claim, verified rather than asserted in a
  // comment: a session must never wait on a network call to start.
  const prev = process.env.PI_SELF_UPDATE;
  process.env.PI_SELF_UPDATE = "check";
  try {
    const handlers = loadExtension();
    const starts = handlers.get("session_start") ?? [];
    const ctx = ctxStub();

    const began = Date.now();
    await Promise.all(starts.map((h) => Promise.resolve(h({}, ctx))));
    const elapsed = Date.now() - began;

    // A real fetch against a remote takes far longer than this; anything under
    // a second proves the handler did not await one.
    assert.ok(elapsed < 1_000, `session_start took ${elapsed}ms — it is awaiting the check`);
  } finally {
    if (prev === undefined) delete process.env.PI_SELF_UPDATE;
    else process.env.PI_SELF_UPDATE = prev;
  }
});
