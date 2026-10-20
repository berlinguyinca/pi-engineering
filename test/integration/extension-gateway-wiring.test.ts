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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("wiring: the response hook does not mutate shared state before a terminal body", async () => {
  const { controller, calls } = observableController();
  try {
    const handlers = loadExtension();
    const ctx = { ...ctxStub(), model: { provider: "acme", id: "busy", api: "openai-completions" } };
    for (const handler of handlers.get("after_provider_response") ?? []) {
      await handler({ status: 429, headers: { "retry-after": "8" } }, ctx);
    }
    assert.deepEqual(calls, []);
    assert.equal(controller.cooldownRemainingMs(), 0);
  } finally {
    setSharedAdmissionController(undefined);
  }
});

test("wiring: an uncorrelated response hook cannot contaminate a later terminal body", async () => {
  const { controller, calls } = observableController();
  try {
    const handlers = loadExtension();
    const ctx = { ...ctxStub(), model: { provider: "acme", id: "busy", api: "openai-completions" } };
    for (const handler of handlers.get("after_provider_response") ?? []) {
      await handler({ status: 503, headers: { "retry-after": "8" } }, ctx);
    }
    const errorMessage =
      '503: {"type":"inferweave_backpressure","reason":"NO_CONTEXT_CAPACITY","retryable":true,' +
      '"replay_safe":true,"request_state":"queued","action":"backoff","action_code":"IW-ACT-BACKOFF",' +
      '"retry_after_ms":1000,"scope":"model"}';
    for (const handler of handlers.get("message_end") ?? []) {
      await handler({ message: { role: "assistant", stopReason: "error", errorMessage } }, ctx);
    }
    assert.deepEqual(calls, ["noteObservedWait"]);
    assert.equal(controller.status().lastSignal?.retryAfterMs, 1_000);
    assert.equal(controller.cooldownRemainingMs({ provider: "acme", model: "other" }), 0);
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

test("wiring: explicit terminal InferWeave refusal aborts before the SDK can retry", async () => {
  let aborts = 0;
  const message = {
    role: "assistant",
    stopReason: "error",
    errorMessage:
      '503: {"action":"do_not_retry","action_code":"IW-ACT-DO-NOT-RETRY","code":"invalid_upstream_response",' +
      '"message":"The upstream returned unsupported error guidance; do not automatically replay this request.",' +
      '"reason":"invalid_upstream_response","replay_safe":false,"request_id":"80bba64a-76f6-44a5-9797-807bd3d68ae8",' +
      '"request_state":"unknown","retryable":false,"scope":"model","type":"inferweave_backpressure"}',
  };
  const before = structuredClone(message);
  const ctx = {
    ...ctxStub(),
    abort: () => {
      aborts++;
      return new Promise<void>(() => {});
    },
  };
  for (const handler of loadExtension().get("message_end") ?? []) {
    await handler({ message }, ctx);
  }
  assert.equal(aborts, 1);
  assert.deepEqual(message, before, "the original error and request ID are preserved");
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

test("wiring: /refresh-models refreshes healthy providers when the selected host is unavailable", async () => {
  const commands = loadWithCommands();
  const cmd = commands.get("refresh-models");
  assert.ok(cmd, "/refresh-models must be registered");

  const dir = mkdtempSync(join(tmpdir(), "refresh-wiring-"));
  const modelsPath = join(dir, "models.json");
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:8082/v1",
          models: [{ id: "local", contextWindow: 250_000, maxTokens: 32_768 }],
        },
        remote: {
          baseUrl: "https://healthy.example/v1",
          models: [{ id: "old", contextWindow: 8_192, maxTokens: 1_024 }],
        },
      },
    }),
    { mode: 0o600 },
  );
  process.env.PI_AGENT_DIR = dir;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:8082/")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (init?.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "fresh", ctx_per_request: 262_144 }] }),
    };
  }) as typeof fetch;

  const { ctx, notices } = notifyingCtx();
  try {
    await cmd.handler("", {
      ...ctx,
      model: { provider: "local", id: "local", api: "openai-completions" },
      modelRegistry: {
        getProviderAuthStatus: () => ({ configured: false }),
        getProviderAuth: async () => undefined,
      },
    });

    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.level, "warning");
    assert.match(notices[0]?.text ?? "", /local — skipped:/);
    assert.match(notices[0]?.text ?? "", /remote — 1 working model/);
    const written = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(written.providers.local.models[0].id, "local");
    assert.equal(written.providers.remote.models[0].id, "fresh");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
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

test("wiring: provider auth failure cannot fall through to an anonymous catalog write", async () => {
  const commands = loadWithCommands();
  const cmd = commands.get("refresh-models");
  assert.ok(cmd);

  const dir = mkdtempSync(join(tmpdir(), "refresh-auth-"));
  const modelsPath = join(dir, "models.json");
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  const before = JSON.stringify({
    providers: {
      secured: {
        baseUrl: "https://secured.example/v1",
        models: [{ id: "old", contextWindow: 8_192 }],
      },
    },
  });
  writeFileSync(modelsPath, before, { mode: 0o600 });
  process.env.PI_AGENT_DIR = dir;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "anonymous", ctx_per_request: 262_144 }] }),
  })) as unknown as typeof fetch;

  const { ctx, notices } = notifyingCtx();
  try {
    await cmd.handler("secured", {
      ...ctx,
      model: { provider: "secured", id: "old", api: "openai-completions" },
      modelRegistry: {
        getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
        getProviderAuth: async () => {
          throw new Error("credential store unavailable");
        },
      },
    });

    assert.equal(notices[0]?.level, "error");
    assert.match(notices[0]?.text ?? "", /credential store unavailable/);
    assert.equal(readFileSync(modelsPath, "utf8"), before);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: malformed models.json is reported instead of disguised as no provider", async () => {
  const commands = loadWithCommands();
  const cmd = commands.get("refresh-models");
  assert.ok(cmd);

  const dir = mkdtempSync(join(tmpdir(), "refresh-malformed-"));
  const modelsPath = join(dir, "models.json");
  const previousAgentDir = process.env.PI_AGENT_DIR;
  writeFileSync(modelsPath, "{not json", { mode: 0o600 });
  process.env.PI_AGENT_DIR = dir;

  const { ctx, notices } = notifyingCtx();
  try {
    await cmd.handler("", ctx);

    assert.equal(notices[0]?.level, "error");
    assert.match(notices[0]?.text ?? "", /refresh-models failed:/);
    assert.match(notices[0]?.text ?? "", /configuration was not changed/i);
    assert.equal(readFileSync(modelsPath, "utf8"), "{not json");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
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

test("wiring: the session_start check honours PI_SELF_UPDATE=0", async () => {
  // The auto-apply path runs unattended against the operator's own checkout, so
  // the off switch has to actually be wired to it.
  const prev = process.env.PI_SELF_UPDATE;
  process.env.PI_SELF_UPDATE = "0";
  try {
    const handlers = loadExtension();
    const starts = handlers.get("session_start") ?? [];
    const ctx = ctxStub();
    const began = Date.now();
    await Promise.all(starts.map((h) => Promise.resolve(h({}, ctx))));

    assert.ok(Date.now() - began < 1_000, "disabled means no work at all, not work that is ignored");
  } finally {
    if (prev === undefined) delete process.env.PI_SELF_UPDATE;
    else process.env.PI_SELF_UPDATE = prev;
  }
});

test("wiring: an auto-opened panel never captures the keyboard", async () => {
  // A panel that takes focus at session start makes pi accept no typing at all.
  // That shipped once, because `ui.custom()`'s doc comment says "with keyboard
  // focus" and never mentions the OverlayOptions flag that turns it off. The
  // panel may open itself; it may not own the keyboard when it does.
  const prev = process.env.PI_PANEL_AUTO_OPEN;
  process.env.PI_PANEL_AUTO_OPEN = "1";
  try {
    let capturing: boolean | undefined;
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

    const ctx = {
      ...ctxStub(),
      ui: {
        ...ctxStub().ui,
        custom: (_factory: unknown, options?: { overlayOptions?: () => { nonCapturing?: boolean } }) => {
          const resolved = options?.overlayOptions?.();
          capturing = resolved?.nonCapturing !== true;
          return Promise.resolve();
        },
      },
    };
    for (const h of handlers.get("session_start") ?? []) await Promise.resolve(h({}, ctx));

    assert.notEqual(capturing, true, "a session start must never seize the keyboard");
  } finally {
    if (prev === undefined) delete process.env.PI_PANEL_AUTO_OPEN;
    else process.env.PI_PANEL_AUTO_OPEN = prev;
  }
});

test("wiring: exiting clears the screen but not the scrollback", async () => {
  // Erasing what the operator did is not tidying — they may still want to
  // scroll back through the session or copy from it. So the visible screen is
  // cleared (2J) and the scrollback (3J) is left alone.
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const realTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const handlers = loadExtension();
    for (const h of handlers.get("session_shutdown") ?? []) await Promise.resolve(h({}, ctxStub()));
  } finally {
    process.stdout.write = realWrite;
    Object.defineProperty(process.stdout, "isTTY", { value: realTty, configurable: true });
  }

  const escapes = written.filter((w) => w.includes("[2J"));
  assert.equal(escapes.length, 1, "the screen is cleared exactly once");
  assert.ok(!escapes[0]?.includes("[3J"), "the scrollback must survive");
});

test("wiring: a non-terminal stdout is never written to", async () => {
  // Escape codes in a pipe become control characters in somebody's log file.
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const realTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const handlers = loadExtension();
    for (const h of handlers.get("session_shutdown") ?? []) await Promise.resolve(h({}, ctxStub()));
  } finally {
    process.stdout.write = realWrite;
    Object.defineProperty(process.stdout, "isTTY", { value: realTty, configurable: true });
  }

  assert.equal(written.filter((w) => w.includes("[2J")).length, 0, "no escape codes when stdout is not a terminal");
});

test("wiring: refresh accepts a timeout before the provider and clears its visible progress", async () => {
  const cmd = loadWithCommands().get("refresh-models")!;
  const dir = mkdtempSync(join(tmpdir(), "refresh-progress-wiring-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  const path = join(dir, "models.json");
  const before = JSON.stringify({
    providers: {
      remote: {
        baseUrl: "https://refresh.example/v1",
        models: [{ id: "flash-next", contextWindow: 8192 }],
      },
    },
  });
  writeFileSync(path, before);
  process.env.PI_AGENT_DIR = dir;
  let attempts = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/models"))
      return Response.json({ data: [{ id: "flash-next", ctx_per_request: 8192 }] });
    attempts += 1;
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }),
    );
  }) as typeof fetch;
  const { ctx, notices } = notifyingCtx();
  const statuses: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  try {
    await cmd.handler("--timeout 1 remote", {
      ...ctx,
      ui: {
        ...ctx.ui,
        setStatus: (_key: string, value: string | undefined) => statuses.push(value),
        setWidget: (_key: string, value: string[] | undefined) => widgets.push(value),
      },
    });
    assert.equal(attempts, 2, "CLI timeout must reach both probe attempts");
    assert.ok(statuses.some((value) => /remote.*0%/.test(value ?? "")));
    assert.ok(widgets.some((value) => /flash-next/.test(value?.join(" ") ?? "")));
    assert.ok(widgets.some((value) => /attempt 2/.test(value?.join(" ") ?? "")));
    assert.equal(statuses.at(-1), undefined);
    assert.equal(widgets.at(-1), undefined);
    assert.match(notices[0]?.text ?? "", /probe timed out/);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: refresh rejects invalid timeout and unknown arguments before accessing the gateway", async () => {
  const cmd = loadWithCommands().get("refresh-models")!;
  for (const args of [
    "--timeout",
    "--timeout 0",
    "--timeout Infinity",
    "--timeout 3601",
    "--timeout abc",
    "--timeout -5",
    "--unknown",
    "one two",
  ]) {
    const { ctx, notices } = notifyingCtx();
    await cmd.handler(args, { ...ctx, signal: AbortSignal.abort() });
    assert.equal(notices[0]?.level, "error");
    assert.match(notices[0]?.text ?? "", /usage:|timeout.*1.*3600/i);
  }
});

for (const cancel of [false, true]) {
  test(`wiring: refresh progress ${cancel ? "clears on cancellation" : "shows 0, 50 and 100 percent with alias identity"}`, async () => {
    const cmd = loadWithCommands().get("refresh-models")!;
    const dir = mkdtempSync(join(tmpdir(), "refresh-visible-"));
    const previousAgentDir = process.env.PI_AGENT_DIR;
    const previousFetch = globalThis.fetch;
    const path = join(dir, "models.json");
    const before = JSON.stringify({ providers: { remote: { baseUrl: "https://refresh.example/v1", models: [] } } });
    writeFileSync(path, before);
    process.env.PI_AGENT_DIR = dir;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ choices: [{ message: { content: "OK" } }] })
        : Response.json({
            data: [
              { id: "fast", x_alias: true, x_backing_model: "qwen" },
              { id: "qwen", ctx_per_request: 8192 },
            ],
          })) as typeof fetch;
    const { ctx, notices } = notifyingCtx();
    const controller = new AbortController();
    const statuses: Array<string | undefined> = [];
    const widgets: Array<string[] | undefined> = [];
    try {
      await cmd.handler("remote --dry-run", {
        ...ctx,
        signal: controller.signal,
        ui: {
          ...ctx.ui,
          setStatus: (_key: string, value: string | undefined) => statuses.push(value),
          setWidget: (_key: string, value: string[] | undefined) => {
            widgets.push(value);
            if (cancel && value?.join(" ").includes("Probing")) controller.abort();
          },
        },
      });
      assert.ok(widgets.some((value) => /Probing fast → qwen \(alias\)/.test(value?.join(" ") ?? "")));
      if (cancel) assert.equal(notices[0]?.level, "error");
      else {
        const percentages = statuses
          .filter(Boolean)
          .map((value) => value!.match(/(\d+)%/)?.[1])
          .filter(Boolean);
        assert.deepEqual([...new Set(percentages)], ["0", "50", "100"]);
        assert.equal(notices[0]?.level, "info");
      }
      assert.equal(statuses.at(-1), undefined);
      assert.equal(widgets.at(-1), undefined);
      assert.equal(readFileSync(path, "utf8"), before);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = previousAgentDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("wiring: native working activity and gateway waits survive a disabled custom footer", async () => {
  const previous = process.env.PI_STATUS_BAR_ENABLED;
  process.env.PI_STATUS_BAR_ENABLED = "0";
  const dir = mkdtempSync(join(tmpdir(), "working-wiring-"));
  const { controller } = observableController();
  const notices: string[] = [];
  let text: string | undefined;
  let panel: string[] | undefined;
  const handlers = loadExtension();
  const ctx = {
    ...ctxStub(),
    cwd: dir,
    hasUI: true,
    isProjectTrusted: () => false,
    model: { provider: "metabolomics", id: "qwen" },
    sessionManager: { getSessionId: () => "working-wiring" },
    ui: {
      ...ctxStub().ui,
      notify: (message: string) => notices.push(message),
      setStatus: () => {},
      setWorkingMessage: (value?: string) => {
        text = value;
      },
      setWidget: (key: string, value: string[] | undefined) => {
        if (key === "engineering-working") panel = value;
      },
    },
  };
  const fire = async (name: string, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
  };
  try {
    await fire("session_start");
    await fire("agent_start");
    assert.match(text!, /Waiting for model.*metabolomics\/qwen/);
    controller.noteObservedWait({
      retryAfterMs: 5_000,
      retryable: true,
      source: "transport-drop",
      reason: "upstream_transport_error",
      provider: "metabolomics",
      model: "qwen",
    });
    assert.match(
      text!,
      /Waiting for model/,
      "a background request on the same provider/model must not overwrite the foreground",
    );
    assert.equal(panel, undefined);
    await fire("message_end", {
      message: {
        role: "assistant",
        stopReason: "error",
        provider: "metabolomics",
        model: "qwen",
        errorMessage:
          '503: {"type":"inferweave_backpressure","reason":"upstream_transport_error","retryable":true,"retry_after_ms":5000,"replay_safe":true,"request_state":"queued","action":"backoff","action_code":"IW-ACT-BACKOFF"}',
      },
    });
    assert.match(text!, /Gateway transport interruption/);
    assert.ok(panel);
    assert.ok(
      notices.every((message) => !message.includes("— holding")),
      "persistent UI suppresses the redundant fallback notification",
    );
    await fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "ok" } });
    assert.match(text!, /Model responding/);
    assert.equal(panel, undefined);
    await fire("tool_execution_start", { toolCallId: "one", toolName: "bash", args: { command: "npm test" } });
    assert.match(text!, /npm test/);
    controller.noteObservedWait({
      retryAfterMs: 5_000,
      retryable: true,
      source: "transport-drop",
      reason: "upstream_transport_error",
      provider: "metabolomics",
      model: "qwen",
    });
    assert.match(text!, /npm test/, "background waits must not replace a foreground tool");
    await fire("model_select", { model: { provider: "other-provider", id: "qwen" } });
    await fire("message_end", {
      message: {
        role: "assistant",
        stopReason: "error",
        provider: "metabolomics",
        model: "qwen",
        errorMessage: PRODUCTION_429,
      },
    });
    assert.equal(panel, undefined, "an old serving route cannot restore its wait after model selection");
    assert.doesNotMatch(text!, /Gateway/);
    await fire("agent_settled");
    assert.equal(text, undefined);
  } finally {
    await fire("session_shutdown");
    setSharedAdmissionController(undefined);
    if (previous === undefined) delete process.env.PI_STATUS_BAR_ENABLED;
    else process.env.PI_STATUS_BAR_ENABLED = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: retry UI belongs to the foreground abort signal even for identical model routes", async () => {
  const previous = process.env.PI_STATUS_BAR_ENABLED;
  process.env.PI_STATUS_BAR_ENABLED = "0";
  const dir = mkdtempSync(join(tmpdir(), "working-request-"));
  let clock = 0;
  let release: (() => void) | undefined;
  const controller = new AdmissionController({
    maxConcurrency: 4,
    jitterMs: 0,
    now: () => clock,
    sleep: async (ms) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      clock += ms;
    },
  });
  setSharedAdmissionController(controller);
  const model = {
    provider: "working-request-test",
    id: "qwen",
    api: "openai-completions",
    contextWindow: 100_000,
    maxTokens: 1000,
  };
  let calls = 0;
  let wrapped: ((model: unknown, context: unknown, options: unknown) => { result(): Promise<unknown> }) | undefined;
  const base = {
    streamSimple: () => {
      const failed = ++calls % 2 === 1;
      const message = {
        role: "assistant",
        content: failed ? [] : [{ type: "text", text: "ok" }],
        provider: model.provider,
        model: model.id,
        api: model.api,
        stopReason: failed ? "error" : "stop",
        errorMessage: failed ? PRODUCTION_429 : undefined,
        usage: {
          input: 0,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message };
        },
        result: async () => message,
      };
    },
  };
  const foreground = new AbortController();
  let text: string | undefined;
  let panel: string[] | undefined;
  const handlers = loadExtension();
  const ctx = {
    ...ctxStub(),
    cwd: dir,
    hasUI: true,
    signal: foreground.signal,
    isProjectTrusted: () => false,
    model,
    sessionManager: { getSessionId: () => "working-request" },
    modelRegistry: {
      getProvider: () => base,
      registerProvider: (_id: string, config: { streamSimple?: typeof wrapped }) => {
        wrapped = config.streamSimple;
      },
    },
    ui: {
      ...ctxStub().ui,
      setStatus: () => {},
      setWorkingMessage: (value?: string) => {
        text = value;
      },
      setWidget: (key: string, value: string[] | undefined) => {
        if (key === "engineering-working") panel = value;
      },
    },
  };
  const fire = async (name: string, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
  };
  const waitForHold = async () => {
    for (let i = 0; i < 100 && !release; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(release, "wrapped provider must reach an admission hold");
  };
  try {
    await fire("session_start");
    assert.ok(wrapped);
    await fire("agent_start");
    await fire("tool_execution_start", { toolCallId: "tool", toolName: "bash", args: { command: "npm test" } });
    const background = wrapped(model, { messages: [] }, { signal: new AbortController().signal });
    await waitForHold();
    assert.match(text!, /npm test/);
    assert.equal(panel, undefined);
    release!();
    release = undefined;
    await background.result();
    assert.match(text!, /npm test/);
    // Cache warming can emit this host hook with the foreground context even
    // though its actual request uses a separate abort signal.
    controller.noteWait({
      retryAfterMs: 5_000,
      retryable: true,
      source: "body",
      reason: "queue_timeout",
      provider: model.provider,
      model: model.id,
    });
    const warmingHook = fire("before_provider_request");
    await waitForHold();
    assert.match(text!, /npm test/, "a cache-warmer host hook must not take the foreground spinner");
    assert.equal(panel, undefined);
    release!();
    release = undefined;
    await warmingHook;
    await fire("tool_execution_end", { toolCallId: "tool", toolName: "bash" });
    const active = wrapped(model, { messages: [] }, { signal: foreground.signal });
    await waitForHold();
    assert.match(text!, /Gateway capacity wait.*retry in 30s/);
    assert.match(panel!.join(" "), /30\/100 queued.*4 admitted/);
    release!();
    release = undefined;
    await active.result();
    assert.equal(panel, undefined, "actual foreground completion clears the wait");
    await fire("agent_settled");
    assert.equal(text, undefined);
  } finally {
    release?.();
    await fire("session_shutdown");
    setSharedAdmissionController(undefined);
    if (previous === undefined) delete process.env.PI_STATUS_BAR_ENABLED;
    else process.env.PI_STATUS_BAR_ENABLED = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: /model-refresh reloads after a real write, and not on a dry run", async () => {
  const commands = loadWithCommands();
  assert.ok(commands.get("model-refresh"), "/model-refresh must be registered");
  assert.ok(commands.get("refresh-models"), "the old name stays as an alias");

  const dir = mkdtempSync(join(tmpdir(), "model-refresh-reload-"));
  const modelsPath = join(dir, "models.json");
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: { remote: { baseUrl: "https://healthy.example/v1", models: [{ id: "old", contextWindow: 8_192 }] } },
    }),
    { mode: 0o600 },
  );
  process.env.PI_AGENT_DIR = dir;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [{ id: "fresh", ctx_per_request: 262_144 }] }) };
  }) as typeof fetch;

  try {
    let reloads = 0;
    const { ctx, notices } = notifyingCtx();
    const withReload = { ...ctx, reload: async () => void reloads++ };

    await commands.get("model-refresh")?.handler("--dry-run", withReload);
    assert.equal(reloads, 0, "a preview changes nothing, so there is nothing to reload");

    await commands.get("model-refresh")?.handler("", withReload);
    assert.equal(reloads, 1);
    assert.match(notices.at(-1)?.text ?? "", /Reloaded\./);

    await commands.get("refresh-models")?.handler("", withReload);
    assert.match(notices.at(-1)?.text ?? "", /now \/model-refresh/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: /model-sync aligns provider settings, keeps the host key, refreshes once and reloads once", async () => {
  const commands = loadWithCommands();
  const cmd = commands.get("model-sync");
  assert.ok(cmd, "/model-sync must be registered");

  const dir = mkdtempSync(join(tmpdir(), "model-sync-wiring-"));
  const modelsPath = join(dir, "models.json");
  const canonicalPath = join(dir, "canonical.json");
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        remote: {
          baseUrl: "https://old.example/v1",
          apiKey: "host-key",
          models: [{ id: "old", contextWindow: 8_192 }],
        },
      },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    canonicalPath,
    JSON.stringify({
      providers: {
        remote: { baseUrl: "https://healthy.example/v1" },
        keyless: { baseUrl: "https://keyless.example/v1" },
      },
    }),
  );
  writeFileSync(join(dir, "model-sync.json"), JSON.stringify({ source: canonicalPath }));
  process.env.PI_AGENT_DIR = dir;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.match(String(input), /^https:\/\/healthy\.example\/v1\//, "refresh uses freshly synced URL");
    if (init?.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [{ id: "fresh", ctx_per_request: 262_144 }] }) };
  }) as typeof fetch;

  try {
    let reloads = 0;
    const { ctx, notices } = notifyingCtx();
    const statuses: Array<string | undefined> = [];
    const withReload = {
      ...ctx,
      modelRegistry: {
        getProviderAuthStatus: (id: string) => ({ configured: id === "remote" }),
        getProviderAuth: async () => ({ auth: { apiKey: "host-key", baseUrl: "https://old.example/v1" } }),
      },
      ui: { ...ctx.ui, setStatus: (_key: string, value: string | undefined) => statuses.push(value) },
      reload: async () => void reloads++,
    };

    await cmd.handler("--dry-run", withReload);
    assert.equal(JSON.parse(readFileSync(modelsPath, "utf8")).providers.remote.baseUrl, "https://old.example/v1");
    assert.equal(reloads, 0);

    await cmd.handler("", withReload);
    const written = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(written.providers.remote.baseUrl, "https://healthy.example/v1");
    assert.equal(written.providers.remote.apiKey, "host-key");
    assert.equal(written.providers.remote.models[0].id, "fresh");
    assert.equal(written.providers.keyless, undefined, "no credential here, so the provider is not created");
    assert.equal(reloads, 1);
    assert.ok(
      statuses.some((value) => /100%/.test(value ?? "")),
      "sync shares visible probe progress",
    );
    assert.equal(statuses.at(-1), undefined);
    assert.equal(notices.at(-1)?.level, "warning", "a provider that needs a key is a warning");
    assert.match(notices.at(-1)?.text ?? "", /keyless: needs-key/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: /model-sync without a configured source says how to configure one", async () => {
  const cmd = loadWithCommands().get("model-sync");
  assert.ok(cmd);
  const dir = mkdtempSync(join(tmpdir(), "model-sync-nosource-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = dir;
  try {
    const { ctx, notices } = notifyingCtx();
    await cmd.handler("", ctx);
    assert.equal(notices[0]?.level, "error");
    assert.match(notices[0]?.text ?? "", /no sync source configured/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: /model-sync --check reports drift and writes nothing", async () => {
  const cmd = loadWithCommands().get("model-sync");
  assert.ok(cmd);
  const dir = mkdtempSync(join(tmpdir(), "model-sync-check-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const modelsPath = join(dir, "models.json");
  const before = JSON.stringify({ providers: { p: { baseUrl: "https://old.example/v1", apiKey: "k" } } });
  writeFileSync(modelsPath, before, { mode: 0o600 });
  writeFileSync(
    join(dir, "canonical.json"),
    JSON.stringify({ providers: { p: { baseUrl: "https://new.example/v1" } } }),
  );
  writeFileSync(join(dir, "model-sync.json"), JSON.stringify({ source: join(dir, "canonical.json") }));
  process.env.PI_AGENT_DIR = dir;
  try {
    const { ctx, notices } = notifyingCtx();
    await cmd.handler("--check", ctx);
    assert.equal(notices[0]?.level, "warning");
    assert.match(notices[0]?.text ?? "", /Out of sync/);
    assert.equal(readFileSync(modelsPath, "utf8"), before);

    writeFileSync(
      join(dir, "canonical.json"),
      JSON.stringify({ providers: { p: { baseUrl: "https://old.example/v1" } } }),
    );
    await cmd.handler("--check", ctx);
    assert.equal(notices[1]?.level, "info");
    assert.match(notices[1]?.text ?? "", /In sync/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
