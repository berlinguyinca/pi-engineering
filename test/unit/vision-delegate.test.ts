import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProbeResult } from "../../src/resilience/probe.ts";
import type { HerdrAgent, HerdrCli } from "../../src/runtime/herdr/HerdrCli.ts";
import type { VisionDelegateSettings } from "../../src/visionDelegation/config.ts";
import { VisionDelegator, type VisionDelegatorDeps, visionAgentName } from "../../src/visionDelegation/delegate.ts";
import { resultPath } from "../../src/visionDelegation/protocol.ts";
import { VisionRegistry } from "../../src/visionDelegation/registry.ts";
import { VISION_ROLE_PROMPT } from "../../src/visionDelegation/rolePrompt.ts";

const IMG = { data: Buffer.from("fake png bytes").toString("base64"), mimeType: "image/png" };
const IMG2 = { data: Buffer.from("second image bytes").toString("base64"), mimeType: "image/jpeg" };
const MODELS = [{ provider: "lab", id: "qwen3.8-vision", input: ["text", "image"] }];
const healthy = async (): Promise<ProbeResult> => ({ healthy: true, authoritative: true });
const MESSAGES = [
  { role: "user", text: "Help me fix the login page layout." },
  { role: "assistant", text: "Sure, send me a screenshot." },
];

interface Call {
  method: string;
  args: unknown[];
}

interface FakeHerdrOpts {
  split?: boolean;
  failStart?: Error;
  /** Answer for `getAgent`; default: a live agent. */
  getAgent?: (target: string) => Promise<HerdrAgent | null>;
  failClose?: Error;
}

const liveAgent = (paneId: string): HerdrAgent => ({
  agent_status: "working",
  cwd: "/work/repo",
  pane_id: paneId,
  workspace_id: "w1",
  revision: 1,
  state_change_seq: 1,
});

function fakeHerdr(opts: FakeHerdrOpts = {}): { herdr: HerdrCli; calls: Call[] } {
  const calls: Call[] = [];
  const rec =
    (method: string, ret?: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return ret;
    };
  let n = 0;
  /** Like herdr: an agent started with a name answers to it; maps name -> pane id. */
  const names = new Map<string, string>();
  const herdr: HerdrCli = {
    status: async () => ({ ok: true, serverVersion: "0.9.1", protocol: 22 }),
    listAgents: async () => [],
    getAgent: async (target: string) => {
      calls.push({ method: "getAgent", args: [target] });
      return opts.getAgent ? opts.getAgent(target) : liveAgent(names.get(target) ?? target);
    },
    readAgent: async () => "",
    prompt: rec("prompt") as HerdrCli["prompt"],
    wait: rec("wait") as HerdrCli["wait"],
    startAgent: async (...args: unknown[]) => {
      // Like herdr, refuse a second agent with a name that is already taken.
      if (calls.some((c) => c.method === "startAgent" && c.args[2] === args[2])) {
        throw new Error(`agent name already in use: ${String(args[2])}`);
      }
      calls.push({ method: "startAgent", args });
      names.set(String(args[2]), String(args[0]));
      if (opts.failStart) throw opts.failStart;
    },
    sendKeys: rec("sendKeys") as HerdrCli["sendKeys"],
    closePane: async (target: string) => {
      calls.push({ method: "closePane", args: [target] });
      if (opts.failClose) throw opts.failClose;
    },
    createWorkspace: rec("createWorkspace") as HerdrCli["createWorkspace"],
    createWorktree: rec("createWorktree") as HerdrCli["createWorktree"],
  };
  if (opts.split !== false) {
    herdr.splitPane = async (o) => {
      calls.push({ method: "splitPane", args: [o] });
      n += 1;
      return { paneId: `vision-pane-${n}` };
    };
  }
  return { herdr, calls };
}

/** Fake clock: `sleep` advances time and fires scheduled actions whose time has come. */
function fakeClock() {
  let t = 0;
  const due: Array<{ at: number; fn: () => void }> = [];
  const fire = () => {
    for (const d of [...due].sort((a, b) => a.at - b.at)) {
      if (d.at <= t) {
        due.splice(due.indexOf(d), 1);
        d.fn();
      }
    }
  };
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      fire();
    },
    at: (ms: number, fn: () => void) => due.push({ at: ms, fn }),
  };
}

function readRequest(dir: string): { request_id: string; images: Array<{ path: string; sha256: string }> } {
  return JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
}

/** Fake vision side: writes a result answering the request in `reqDir`. */
function writeResult(reqDir: string, requestId: string, over: Record<string, unknown> = {}): void {
  const req = readRequest(reqDir);
  const file = resultPath(reqDir, requestId);
  mkdirSync(join(reqDir, "results"), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      request_id: req.request_id,
      status: "ok",
      description: "A login form with a misaligned submit button.",
      text_in_image: "Sign in",
      findings_for_task: "The button overflows the card on the right.",
      uncertainties: [],
      images: req.images.map((i) => ({ path: i.path, sha256: i.sha256 })),
      ...over,
    }),
  );
}

function setup(
  over: Partial<VisionDelegatorDeps> = {},
  herdrOpts: Parameters<typeof fakeHerdr>[0] = {},
  ids: string[] = ["req-1", "req-2", "req-3"],
) {
  const dir = mkdtempSync(join(tmpdir(), "vision-delegate-"));
  const clock = fakeClock();
  const { herdr, calls } = fakeHerdr(herdrOpts);
  const queue = [...ids];
  const settings: VisionDelegateSettings = {
    enabled: true,
    waitSeconds: 30,
    aliasPreference: ["qwen3.8-vision"],
    notes: [],
  };
  const registry = new VisionRegistry(join(dir, "registry.json"));
  const deps: VisionDelegatorDeps = {
    herdr,
    settings,
    models: MODELS,
    probeFor: healthy,
    registry,
    artifactDir: join(dir, "vision"),
    now: clock.now,
    sleep: clock.sleep,
    newId: () => queue.shift() ?? `req-${Math.random().toString(36).slice(2)}`,
    textModel: "text-model",
    originPaneId: "origin-pane",
    ...over,
  };
  const reqDir = (id: string) => join(deps.artifactDir, id);
  return {
    dir,
    clock,
    calls,
    deps,
    registry,
    reqDir,
    delegator: new VisionDelegator(deps),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const input = (over: Record<string, unknown> = {}) => ({
  sessionId: "session-abcdef123456",
  cwd: "/work/repo",
  text: "Why does this look broken?",
  images: [IMG],
  messages: MESSAGES,
  ...over,
});

type Out = Awaited<ReturnType<VisionDelegator["handle"]>>;
function transformText(out: Out): string {
  assert.equal(out.action, "transform");
  if (out.action !== "transform") throw new Error("unreachable");
  assert.deepEqual(out.images, []);
  assert.ok(out.text.trim().length > 0, "transform text must never be empty");
  return out.text;
}
const state = (reqDir: string) => JSON.parse(readFileSync(join(reqDir, "state.json"), "utf8"));

test("no images continues untouched", async () => {
  const s = setup();
  try {
    const out = await s.delegator.handle(input({ images: [] }));
    assert.deepEqual(out, { action: "continue" });
    assert.equal(s.calls.length, 0);
    assert.equal(existsSync(s.deps.artifactDir), false);
  } finally {
    s.cleanup();
  }
});

test("ok result becomes a transform that removes the images and carries the analysis", async () => {
  const s = setup();
  try {
    s.clock.at(2000, () => writeResult(s.reqDir("req-1"), "req-1"));
    const statuses: Array<string | undefined> = [];
    const out = await s.delegator.handle(input({ status: (t: string | undefined) => statuses.push(t) }));
    const text = transformText(out);
    assert.match(text, /STATUS: ok/);
    assert.match(text, /misaligned submit button/);
    assert.match(text, /Why does this look broken\?/);
    assert.match(text, /qwen3\.8-vision/);
    assert.equal(statuses[0], "analyzing image (up to 30s)…");
    assert.equal(statuses.at(-1), undefined);
    assert.equal(state(s.reqDir("req-1")).status, "done");
    assert.equal(state(s.reqDir("req-1")).injected, true);
    const entry = s.registry.get("session-abcdef123456");
    assert.equal(entry?.paneId, "vision-pane-1");
    assert.equal(entry?.agentName, "vision-session--req-1");
    assert.equal(entry?.sessionDir, join(s.reqDir("req-1"), "session"));
    assert.equal(
      s.calls.some((c) => c.method === "closePane"),
      false,
      "an ok result keeps its pane open",
    );
  } finally {
    s.cleanup();
  }
});

test("partial and failed results are stated as such in the text", async () => {
  for (const status of ["partial", "failed"] as const) {
    const s = setup();
    try {
      s.clock.at(1000, () => writeResult(s.reqDir("req-1"), "req-1", { status }));
      const text = transformText(await s.delegator.handle(input()));
      assert.match(text, new RegExp(`STATUS: ${status}`));
      assert.match(text, /\/images\/[0-9a-f]{64}\.png/);
    } finally {
      s.cleanup();
    }
  }
});

test("result for another requestId is ignored and the wait continues", async () => {
  const s = setup();
  try {
    s.clock.at(1000, () => writeResult(s.reqDir("req-1"), "req-1", { request_id: "someone-else" }));
    s.clock.at(4000, () => writeResult(s.reqDir("req-1"), "req-1", { description: "the real answer" }));
    const text = transformText(await s.delegator.handle(input()));
    assert.match(text, /the real answer/);
    assert.equal(s.clock.now() >= 4000, true);
  } finally {
    s.cleanup();
  }
});

test("hash mismatch is a failed delegation", async () => {
  const s = setup();
  try {
    s.clock.at(1000, () => {
      const req = readRequest(s.reqDir("req-1"));
      writeResult(s.reqDir("req-1"), "req-1", {
        images: req.images.map((i) => ({ path: i.path, sha256: "0".repeat(64) })),
      });
    });
    const text = transformText(await s.delegator.handle(input()));
    assert.match(text, /failed/i);
    assert.match(text, /sha256 mismatch/);
    assert.match(text, /\/images\/[0-9a-f]{64}\.png/);
    assert.ok(s.clock.now() < 30_000, "stops waiting at once");
    assert.equal(state(s.reqDir("req-1")).status, "failed");
    assert.equal(s.registry.get("session-abcdef123456"), undefined);
  } finally {
    s.cleanup();
  }
});

test('timeout produces an explicit "analysis timed out" text and never an empty message', async () => {
  for (const text of ["Why does this look broken?", ""]) {
    const s = setup();
    try {
      const out = transformText(await s.delegator.handle(input({ text })));
      assert.match(out, /analysis timed out/);
      assert.match(out, /\/images\/[0-9a-f]{64}\.png/);
      assert.ok(s.clock.now() >= 30_000);
      const st = state(s.reqDir("req-1"));
      assert.equal(st.status, "timed_out");
      assert.equal(st.injected, false);
    } finally {
      s.cleanup();
    }
  }
});

test("a result written after the timeout is recorded and not injected", async () => {
  const s = setup();
  try {
    const first = transformText(await s.delegator.handle(input()));
    assert.match(first, /analysis timed out/);
    writeResult(s.reqDir("req-1"), "req-1", { description: "LATE ANSWER" });
    s.clock.at(s.clock.now() + 1000, () => writeResult(s.reqDir("req-2"), "req-2", { description: "second answer" }));
    const second = transformText(await s.delegator.handle(input()));
    assert.match(second, /second answer/);
    assert.doesNotMatch(second, /LATE ANSWER/);
    assert.equal(state(s.reqDir("req-1")).status, "timed_out");
    assert.equal(state(s.reqDir("req-1")).injected, false);
    assert.ok(existsSync(resultPath(s.reqDir("req-1"), "req-1")), "late result left on disk");
  } finally {
    s.cleanup();
  }
});

test("abort signal cancels the wait and records a late result as not injected", async () => {
  const ac = new AbortController();
  const s = setup();
  try {
    s.clock.at(2000, () => ac.abort());
    const statuses: Array<string | undefined> = [];
    const out = transformText(
      await s.delegator.handle(input({ signal: ac.signal, status: (t: string | undefined) => statuses.push(t) })),
    );
    assert.match(out, /cancelled/);
    assert.match(out, /\/images\/[0-9a-f]{64}\.png/);
    assert.ok(s.clock.now() < 30_000);
    assert.equal(statuses.at(-1), undefined);
    writeResult(s.reqDir("req-1"), "req-1", { description: "LATE ANSWER" });
    assert.deepEqual(
      { status: state(s.reqDir("req-1")).status, injected: state(s.reqDir("req-1")).injected },
      { status: "cancelled", injected: false },
    );
    s.clock.at(s.clock.now() + 500, () => writeResult(s.reqDir("req-2"), "req-2"));
    assert.doesNotMatch(transformText(await s.delegator.handle(input())), /LATE ANSWER/);
  } finally {
    s.cleanup();
  }
});

test("no healthy vision model continues with a plain note and the image path", async () => {
  const s = setup({ probeFor: async () => ({ healthy: false, authoritative: true, reason: "relocating" }) });
  try {
    const text = transformText(await s.delegator.handle(input()));
    assert.match(text, /no vision model/i);
    assert.match(text, /relocating/);
    assert.match(text, /Why does this look broken\?/);
    const m = text.match(/(\/\S+\/images\/[0-9a-f]{64}\.png)/);
    assert.ok(m?.[1] && existsSync(m[1]), "names an existing saved image path");
    assert.equal(s.calls.length, 0);
  } finally {
    s.cleanup();
  }
});

test("herdr missing continues with a note", async () => {
  for (const variant of ["no-split", "no-origin"] as const) {
    const s =
      variant === "no-split" ? setup({}, { split: false }) : setup({ originPaneId: undefined }, { split: true });
    try {
      const text = transformText(await s.delegator.handle(input()));
      assert.match(text, /herdr/i);
      assert.match(text, /unavailable/i);
      assert.match(text, /\/images\/[0-9a-f]{64}\.png/);
      assert.equal(
        s.calls.some((c) => c.method === "startAgent"),
        false,
      );
    } finally {
      s.cleanup();
    }
  }
});

test("a herdr error becomes an explicit note, never a throw", async () => {
  const s = setup({}, { failStart: new Error("pane exploded") });
  try {
    const text = transformText(await s.delegator.handle(input()));
    assert.match(text, /pane exploded/);
    assert.match(text, /\/images\/[0-9a-f]{64}\.png/);
  } finally {
    s.cleanup();
  }
});

test("empty user text still yields a sensible message", async () => {
  const s = setup();
  try {
    s.clock.at(1000, () => writeResult(s.reqDir("req-1"), "req-1"));
    const text = transformText(await s.delegator.handle(input({ text: "", messages: [] })));
    assert.match(text, /no accompanying text/);
    assert.match(text, /misaligned submit button/);
    assert.ok(readFileSync(join(s.reqDir("req-1"), "handoff.md"), "utf8").trim().length > 0);
  } finally {
    s.cleanup();
  }
});

test("the vision pane is started with --provider, --model, @handoff.md, @image args and no handoff text in argv", async () => {
  const s = setup();
  try {
    s.clock.at(1000, () => writeResult(s.reqDir("req-1"), "req-1"));
    await s.delegator.handle(input({ images: [IMG, IMG2] }));
    const split = s.calls.find((c) => c.method === "splitPane");
    assert.deepEqual(split?.args[0], { paneId: "origin-pane", cwd: "/work/repo", direction: "right" });
    const start = s.calls.find((c) => c.method === "startAgent");
    assert.ok(start);
    const [paneId, kind, name, args] = start.args as [string, string, string, string[]];
    assert.equal(paneId, "vision-pane-1");
    assert.equal(kind, "pi");
    assert.equal(name, "vision-session--req-1");
    const dir = s.reqDir("req-1");
    const flag = (f: string) => args[args.indexOf(f) + 1];
    assert.equal(flag("--provider"), "lab");
    assert.equal(flag("--model"), "qwen3.8-vision");
    assert.equal(flag("--session-dir"), join(dir, "session"));
    assert.ok(existsSync(join(dir, "session")), "session dir is created");
    assert.equal(args.indexOf("--session-dir"), args.indexOf("--model") + 2);
    assert.equal(args.indexOf("--append-system-prompt"), args.indexOf("--session-dir") + 2);
    const rolePath = flag("--append-system-prompt");
    assert.ok(rolePath);
    assert.equal(readFileSync(rolePath, "utf8"), VISION_ROLE_PROMPT);
    assert.ok(args.includes(`@${join(dir, "handoff.md")}`));
    assert.ok(args.includes(`@${join(dir, "instructions.md")}`));
    const req = readRequest(dir);
    assert.equal(req.images.length, 2);
    for (const img of req.images) assert.ok(args.includes(`@${img.path}`));
    const handoff = readFileSync(join(dir, "handoff.md"), "utf8");
    assert.match(handoff, /Why does this look broken\?/);
    const joined = args.join("\n");
    assert.doesNotMatch(joined, /Why does this look broken/);
    assert.doesNotMatch(joined, /login page layout/);
    assert.ok(!joined.includes(IMG.data) && !joined.includes(IMG2.data));
    const instructions = readFileSync(join(dir, "instructions.md"), "utf8");
    assert.ok(instructions.includes(resultPath(dir, "req-1")));
    assert.ok(instructions.includes("req-1"));
    assert.ok(instructions.includes(join(dir, "request.json")));
  } finally {
    s.cleanup();
  }
});

test("two sessions delegating at once never read each other's result files", async () => {
  const shared = mkdtempSync(join(tmpdir(), "vision-delegate-shared-"));
  const a = setup({ artifactDir: join(shared, "vision") }, {}, ["req-a"]);
  const b = setup({ artifactDir: join(shared, "vision") }, {}, ["req-b"]);
  try {
    // B's answer lands first; A must keep waiting for its own.
    b.clock.at(1000, () => writeResult(b.reqDir("req-b"), "req-b", { description: "answer for B" }));
    a.clock.at(3000, () => writeResult(a.reqDir("req-a"), "req-a", { description: "answer for A" }));
    const [outA, outB] = await Promise.all([
      a.delegator.handle(input({ sessionId: "session-A-000000" })),
      b.delegator.handle(input({ sessionId: "session-B-000000" })),
    ]);
    const ta = transformText(outA);
    const tb = transformText(outB);
    assert.match(ta, /answer for A/);
    assert.doesNotMatch(ta, /answer for B/);
    assert.match(tb, /answer for B/);
    assert.doesNotMatch(tb, /answer for A/);
  } finally {
    a.cleanup();
    b.cleanup();
    rmSync(shared, { recursive: true, force: true });
  }
});

test("a throwing lineage hook does not break the delegation", async () => {
  const events: string[] = [];
  const s = setup({
    lineage: (e) => {
      events.push(`${e.phase}:${e.outcome}`);
      throw new Error("lineage sink down");
    },
  });
  try {
    s.clock.at(1000, () => writeResult(s.reqDir("req-1"), "req-1"));
    const text = transformText(await s.delegator.handle(input()));
    assert.match(text, /STATUS: ok/);
    assert.deepEqual(events, ["out:ok", "back:ok"]);
  } finally {
    s.cleanup();
  }
});

test("lineage reports a timeout as phase back, outcome timeout", async () => {
  const events: Array<Record<string, unknown>> = [];
  const s = setup({ lineage: (e) => events.push({ ...e }) });
  try {
    await s.delegator.handle(input());
    assert.equal(events.length, 2);
    assert.deepEqual(events[1], {
      phase: "back",
      requestId: "req-1",
      fromSession: "session-abcdef123456",
      toSession: "vision-session--req-1",
      fromModel: "text-model",
      toModel: "lab/qwen3.8-vision",
      outcome: "timeout",
    });
  } finally {
    s.cleanup();
  }
});

test("a dead vision pane fails the delegation at once, not at the deadline", async () => {
  const s = setup({}, { getAgent: async () => (s.clock.now() >= 3000 ? null : liveAgent("vision-pane-1")) });
  try {
    const events: string[] = [];
    s.deps.lineage = (e) => events.push(`${e.phase}:${e.outcome}`);
    const text = transformText(await new VisionDelegator(s.deps).handle(input()));
    assert.match(text, /the vision pane exited before writing a result/);
    assert.match(text, /\/images\/[0-9a-f]{64}\.png/);
    assert.ok(s.clock.now() < 10_000, `failed at ${s.clock.now()}ms, well before the 30s deadline`);
    assert.deepEqual(events, ["out:ok", "back:failed"]);
    const st = state(s.reqDir("req-1"));
    assert.equal(st.status, "failed");
    assert.equal(st.injected, false);
    assert.equal(st.pane_id, "vision-pane-1");
    assert.ok(s.calls.some((c) => c.method === "closePane" && c.args[0] === "vision-pane-1"));
    assert.equal(s.registry.get("session-abcdef123456"), undefined);
  } finally {
    s.cleanup();
  }
});

test("a throwing getAgent is not a dead pane and does not end the wait", async () => {
  const s = setup(
    {},
    {
      getAgent: async () => {
        throw new Error("herdr socket hiccup");
      },
    },
  );
  try {
    s.clock.at(12_000, () => writeResult(s.reqDir("req-1"), "req-1"));
    const text = transformText(await s.delegator.handle(input()));
    assert.match(text, /STATUS: ok/);
    assert.ok(s.calls.filter((c) => c.method === "getAgent").length >= 2, "pane checks ran");
  } finally {
    s.cleanup();
  }
});

test("two delegations in the same session use different agent names", async () => {
  // The first pane is gone by the second image, so a second agent is started (no reuse).
  let firstDone = false;
  // Agents are looked up by name (R22): req-1's agent lives in vision-pane-1, req-2's in vision-pane-2.
  const paneOf = (t: string) => (t === "vision-session--req-1" ? "vision-pane-1" : "vision-pane-2");
  const s = setup(
    {},
    { getAgent: async (t) => (firstDone && t === "vision-session--req-1" ? null : liveAgent(paneOf(t))) },
  );
  try {
    s.clock.at(1000, () => writeResult(s.reqDir("req-1"), "req-1"));
    assert.match(transformText(await s.delegator.handle(input())), /STATUS: ok/);
    firstDone = true;
    s.clock.at(s.clock.now() + 1000, () => writeResult(s.reqDir("req-2"), "req-2"));
    assert.match(transformText(await s.delegator.handle(input())), /STATUS: ok/);
    const names = s.calls.filter((c) => c.method === "startAgent").map((c) => c.args[2]);
    assert.deepEqual(names, ["vision-session--req-1", "vision-session--req-2"]);
  } finally {
    s.cleanup();
  }
});

test("agent names are lowercased, sanitized and at most 32 chars", () => {
  const name = visionAgentName("Sess/ion:ABCDEFG", "Req_ID.12345678");
  assert.equal(name, "vision-sess-ion-req-id-1");
  assert.match(name, /^[a-z0-9-]+$/);
  assert.ok(visionAgentName("x".repeat(80), "y".repeat(80)).length <= 32);
});

test("a timeout closes its pane, and a throwing closePane does not break the transform", async () => {
  for (const failClose of [undefined, new Error("close refused")]) {
    const s = setup({}, { failClose });
    try {
      const text = transformText(await s.delegator.handle(input()));
      assert.match(text, /analysis timed out/);
      assert.ok(s.calls.some((c) => c.method === "closePane" && c.args[0] === "vision-pane-1"));
      const st = state(s.reqDir("req-1"));
      assert.equal(st.status, "timed_out");
      assert.equal(st.pane_id, "vision-pane-1");
    } finally {
      s.cleanup();
    }
  }
});

test("cancel and a rejected result also close the pane", async () => {
  const ac = new AbortController();
  const c = setup();
  const r = setup();
  try {
    c.clock.at(1000, () => ac.abort());
    assert.match(transformText(await c.delegator.handle(input({ signal: ac.signal }))), /cancelled/);
    assert.ok(c.calls.some((x) => x.method === "closePane"));
    r.clock.at(1000, () => writeResult(r.reqDir("req-1"), "req-1", { images: [] }));
    assert.match(transformText(await r.delegator.handle(input())), /image missing from echo/);
    assert.ok(r.calls.some((x) => x.method === "closePane"));
  } finally {
    c.cleanup();
    r.cleanup();
  }
});

test("I1: the same image pasted twice is sent once, an ok result echoing it once is accepted, and the handback names it once", async () => {
  const s = setup();
  try {
    s.clock.at(1000, () => writeResult(s.reqDir("req-1"), "req-1"));
    const text = transformText(await s.delegator.handle(input({ images: [IMG, IMG] })));
    const req = readRequest(s.reqDir("req-1"));
    assert.equal(req.images.length, 1, "request.json lists the distinct image once");
    assert.match(text, /STATUS: ok/);
    assert.match(text, /misaligned submit button/);
    const path = req.images[0]?.path ?? "";
    assert.equal(text.split(path).length - 1, 1, "the handback names the image once");
    assert.equal(state(s.reqDir("req-1")).status, "done");
  } finally {
    s.cleanup();
  }
});

test("I2: an unexpected throw inside the queue wrapper keeps the user's text and names the saved images", async () => {
  const s = setup({
    now: () => {
      throw new Error("clock broke");
    },
  });
  try {
    const text = transformText(await s.delegator.handle(input({ text: "Please check the chart legend" })));
    assert.match(text, /failed unexpectedly \(clock broke\)/);
    assert.match(text, /Please check the chart legend/);
    assert.doesNotMatch(text, /no accompanying text/);
    assert.match(text, /\/images\/[0-9a-f]{64}\.png/, "the already-saved image is named");
    assert.doesNotMatch(text, /could not be saved/);
  } finally {
    s.cleanup();
  }
});
