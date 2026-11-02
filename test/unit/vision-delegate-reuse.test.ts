import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { HerdrAgent, HerdrCli } from "../../src/runtime/herdr/HerdrCli.ts";
import { VisionDelegator, type VisionDelegatorDeps } from "../../src/visionDelegation/delegate.ts";
import { resultPath } from "../../src/visionDelegation/protocol.ts";
import { VisionRegistry } from "../../src/visionDelegation/registry.ts";

const IMG = { data: Buffer.from("fake png bytes").toString("base64"), mimeType: "image/png" };
const IMG2 = { data: Buffer.from("second image bytes").toString("base64"), mimeType: "image/jpeg" };
const SESSION = "session-abcdef123456";

interface Call {
  method: string;
  args: unknown[];
  at: number;
}

const liveAgent = (paneId: string): HerdrAgent => ({
  agent_status: "idle",
  cwd: "/work/repo",
  pane_id: paneId,
  workspace_id: "w1",
  revision: 1,
  state_change_seq: 1,
});

/** Fake clock: `sleep` advances time and fires scheduled actions whose time has come. */
function fakeClock() {
  let t = 0;
  const due: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      for (const d of [...due].sort((a, b) => a.at - b.at)) {
        if (d.at <= t) {
          due.splice(due.indexOf(d), 1);
          d.fn();
        }
      }
    },
    at: (ms: number, fn: () => void) => due.push({ at: ms, fn }),
  };
}

/** Fake vision side: writes a valid result for the request in `reqDir`. */
function writeResult(reqDir: string, over: Record<string, unknown> = {}): void {
  const req = JSON.parse(readFileSync(join(reqDir, "request.json"), "utf8"));
  mkdirSync(join(reqDir, "results"), { recursive: true });
  writeFileSync(
    resultPath(reqDir, req.request_id),
    JSON.stringify({
      request_id: req.request_id,
      status: "ok",
      description: `analysis of ${req.request_id}`,
      text_in_image: "",
      findings_for_task: "",
      uncertainties: [],
      images: req.images.map((i: { path: string; sha256: string }) => ({ path: i.path, sha256: i.sha256 })),
      ...over,
    }),
  );
}

interface Opts {
  /** Delay (ms of fake time) before the vision side answers each request; null = never answers. */
  answerAfter?: (requestId: string) => number | null;
  getAgent?: (target: string) => Promise<HerdrAgent | null>;
  failPrompt?: Error;
}

function setup(ids: string[], opts: Opts = {}, over: Partial<VisionDelegatorDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vision-reuse-"));
  const clock = fakeClock();
  const calls: Call[] = [];
  const queue = [...ids];
  const answer = (reqDir: string) => {
    const id = reqDir.split("/").at(-1) ?? "";
    const delay = opts.answerAfter ? opts.answerAfter(id) : 1000;
    if (delay !== null) clock.at(clock.now() + delay, () => writeResult(reqDir));
  };
  let panes = 0;
  /** Like herdr: an agent started with a name answers to it; maps name -> pane id. */
  const names = new Map<string, string>();
  const rec = (method: string, args: unknown[]) => calls.push({ method, args, at: clock.now() });
  const herdr: HerdrCli = {
    status: async () => ({ ok: true, serverVersion: "0.9.1", protocol: 22 }),
    listAgents: async () => [],
    getAgent: async (target: string) => {
      rec("getAgent", [target]);
      return opts.getAgent ? opts.getAgent(target) : liveAgent(names.get(target) ?? target);
    },
    readAgent: async () => "",
    prompt: async (target: string, text: string, timeoutMs?: number) => {
      rec("prompt", [target, text, timeoutMs]);
      if (opts.failPrompt) throw opts.failPrompt;
      const m = text.match(/(\/\S+)\/request\.json/);
      if (m?.[1]) answer(m[1]);
    },
    wait: async () => liveAgent("x"),
    startAgent: async (paneId: string, kind: string, name: string, args: readonly string[] = []) => {
      rec("startAgent", [paneId, kind, name, args]);
      names.set(name, paneId);
      const instr = args.find((a) => a.endsWith("instructions.md"));
      if (instr) answer(dirname(instr.slice(1)));
    },
    sendKeys: async () => {},
    closePane: async (target: string) => {
      rec("closePane", [target]);
    },
    createWorkspace: async () => ({ workspaceId: "w", paneId: "p", path: "/" }),
    createWorktree: async () => ({ workspaceId: "w", paneId: "p", path: "/" }),
    splitPane: async (o) => {
      rec("splitPane", [o]);
      panes += 1;
      return { paneId: `vision-pane-${panes}` };
    },
  };
  const registry = new VisionRegistry(join(dir, "registry.json"));
  const deps: VisionDelegatorDeps = {
    herdr,
    settings: { enabled: true, waitSeconds: 30, aliasPreference: ["qwen3.8-vision"], notes: [] },
    models: [{ provider: "lab", id: "qwen3.8-vision", input: ["text", "image"] }],
    probeFor: async () => ({ healthy: true, authoritative: true }),
    registry,
    artifactDir: join(dir, "vision"),
    now: clock.now,
    sleep: clock.sleep,
    newId: () => queue.shift() ?? "req-overflow",
    textModel: "text-model",
    originPaneId: "origin-pane",
    ...over,
  };
  return {
    clock,
    calls,
    names,
    registry,
    deps,
    reqDir: (id: string) => join(deps.artifactDir, id),
    delegator: new VisionDelegator(deps),
    of: (method: string) => calls.filter((c) => c.method === method),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const input = (over: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  cwd: "/work/repo",
  text: "Why does this look broken?",
  images: [IMG],
  messages: [{ role: "user", text: "Help me fix the login page layout." }],
  ...over,
});

function text(out: Awaited<ReturnType<VisionDelegator["handle"]>>): string {
  assert.equal(out.action, "transform");
  if (out.action !== "transform") throw new Error("unreachable");
  assert.deepEqual(out.images, []);
  return out.text;
}
const state = (reqDir: string) => JSON.parse(readFileSync(join(reqDir, "state.json"), "utf8"));
const chains = (d: VisionDelegator) => (d as unknown as { chains: Map<string, unknown> }).chains;

test("a second image reuses the registered pane and prompts it instead of starting one", async () => {
  const s = setup(["req-1", "req-2"]);
  try {
    assert.match(text(await s.delegator.handle(input())), /analysis of req-1/);
    const out = text(await s.delegator.handle(input({ images: [IMG2] })));
    assert.match(out, /STATUS: ok/);
    assert.match(out, /analysis of req-2/);
    assert.match(out, /qwen3\.8-vision/);
    assert.equal(s.of("startAgent").length, 1);
    assert.equal(s.of("splitPane").length, 1);
    const prompts = s.of("prompt");
    assert.equal(prompts.length, 1);
    // R22: the reused agent is addressed by its unique name, and its pane id is checked first.
    assert.equal(prompts[0]?.args[0], "vision-session--req-1");
    assert.ok(
      s.of("getAgent").some((c) => c.args[0] === "vision-session--req-1"),
      "checks the agent by name before reuse",
    );
    assert.equal(s.of("closePane").length, 0, "the reused pane stays open");
    assert.equal(s.registry.get(SESSION)?.paneId, "vision-pane-1");
    const st = state(s.reqDir("req-2"));
    assert.equal(st.status, "done");
    assert.equal(st.injected, true);
    assert.equal(st.pane_id, "vision-pane-1");
    for (const f of ["instructions.md", "request.json", "handoff.md"]) {
      assert.ok(existsSync(join(s.reqDir("req-2"), f)), `${f} written for the reused request`);
    }
  } finally {
    s.cleanup();
  }
});

test("the prompt names the new requestId and the result file path", async () => {
  const s = setup(["req-1", "req-2"]);
  try {
    await s.delegator.handle(input());
    await s.delegator.handle(input({ images: [IMG, IMG2] }));
    const promptText = String(s.of("prompt")[0]?.args[1]);
    const dir = s.reqDir("req-2");
    assert.ok(promptText.includes("req-2"));
    assert.ok(promptText.includes(resultPath(dir, "req-2")));
    assert.ok(promptText.includes(join(dir, "request.json")));
    assert.ok(promptText.includes(join(dir, "instructions.md")));
    assert.ok(promptText.includes(join(dir, "handoff.md")));
    const req = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
    for (const img of req.images) assert.ok(promptText.includes(img.path), "names each image path");
    // Paths only: never the handoff body or image data.
    assert.doesNotMatch(promptText, /Why does this look broken/);
    assert.doesNotMatch(promptText, /login page layout/);
    assert.ok(!promptText.includes(IMG.data) && !promptText.includes(IMG2.data));
  } finally {
    s.cleanup();
  }
});

test("a dead pane (getAgent returns null) starts a new session and the handback says earlier images are not in its context", async () => {
  let dead = false;
  const s = setup(["req-1", "req-2"], {
    // Looked up by name (R22); the fake maps each started name to its pane.
    getAgent: async (t) => (dead && t === "vision-session--req-1" ? null : liveAgent(s.names.get(t) ?? t)),
  });
  try {
    await s.delegator.handle(input());
    dead = true;
    const out = text(await s.delegator.handle(input()));
    assert.match(out, /analysis of req-2/);
    assert.match(out, /earlier images .*no longer in the vision session's context/i);
    assert.equal(s.of("prompt").length, 0);
    assert.equal(s.of("startAgent").length, 2);
    assert.equal(s.registry.get(SESSION)?.paneId, "vision-pane-2");
  } finally {
    s.cleanup();
  }
});

test("registry entry is removed when the pane is gone", async () => {
  let dead = false;
  // The new session cannot be started, so only the removal remains visible.
  const s = setup(["req-1", "req-2"], { getAgent: async (t) => (dead ? null : liveAgent(t)) });
  try {
    await s.delegator.handle(input());
    assert.equal(s.registry.get(SESSION)?.paneId, "vision-pane-1");
    dead = true;
    s.deps.originPaneId = undefined;
    const out = text(await new VisionDelegator(s.deps).handle(input()));
    assert.match(out, /herdr is unavailable/);
    assert.equal(s.registry.get(SESSION), undefined);
  } finally {
    s.cleanup();
  }
});

test("a throwing getAgent fails explicitly without removing the entry or starting a new session", async () => {
  let broken = false;
  const s = setup(["req-1", "req-2"], {
    getAgent: async (t) => {
      if (broken) throw new Error("herdr socket hiccup");
      return liveAgent(t);
    },
  });
  try {
    await s.delegator.handle(input());
    broken = true;
    const out = text(await s.delegator.handle(input()));
    assert.match(out, /vision session .*unavailable/i);
    assert.match(out, /herdr socket hiccup/);
    assert.match(out, /\/images\/[0-9a-f]{64}\.png/);
    assert.equal(s.registry.get(SESSION)?.paneId, "vision-pane-1");
    assert.equal(s.of("startAgent").length, 1);
    assert.equal(s.of("prompt").length, 0);
    assert.equal(s.of("closePane").length, 0);
  } finally {
    s.cleanup();
  }
});

test("a second image arriving during an analysis waits for the first and is handled in order", async () => {
  const s = setup(["req-1", "req-2"], { answerAfter: (id) => (id === "req-1" ? 25_000 : 20_000) });
  try {
    const statuses: Array<string | undefined> = [];
    const first = s.delegator.handle(input());
    const second = s.delegator.handle(input({ images: [IMG2], status: (t: string | undefined) => statuses.push(t) }));
    assert.equal(statuses[0], "waiting for earlier image…");
    const [a, b] = await Promise.all([first, second]);
    assert.match(text(a), /analysis of req-1/);
    // Answered 45 s after the first started, but 20 s after it began running: no timeout.
    assert.match(text(b), /analysis of req-2/);
    const start = s.of("startAgent")[0];
    const prompt = s.of("prompt")[0];
    assert.ok(start && prompt);
    assert.ok(prompt.at >= 25_000, "the second is delivered only after the first's result");
    assert.ok(statuses.includes("analyzing image (up to 30s)…"));
    assert.equal(statuses.at(-1), undefined);
    assert.equal(chains(s.delegator).size, 0, "idle session chains are dropped");
  } finally {
    s.cleanup();
  }
});

test("different sessions run independently", async () => {
  const s = setup(["req-a", "req-b"], { answerAfter: (id) => (id === "req-a" ? 10_000 : 1000) });
  try {
    const a = s.delegator.handle(input({ sessionId: "session-A-000000" }));
    const b = s.delegator.handle(input({ sessionId: "session-B-000000" }));
    await Promise.all([a, b]);
    const starts = s.of("startAgent");
    assert.equal(starts.length, 2);
    assert.ok((starts[1]?.at ?? Number.POSITIVE_INFINITY) < 10_000, "B did not wait for A");
  } finally {
    s.cleanup();
  }
});

test("a failed or rejected earlier call does not block the next", async () => {
  const s = setup(["req-1", "req-2", "req-3"], { answerAfter: (id) => (id === "req-1" ? null : 1000) });
  try {
    const timedOut = s.delegator.handle(input());
    // A non-string text makes the failure path itself throw: the call must still settle.
    const broken = s.delegator.handle(input({ text: undefined, status: () => {} }));
    const third = s.delegator.handle(
      input({
        status: () => {
          throw new Error("status sink broke");
        },
      }),
    );
    assert.match(text(await timedOut), /analysis timed out/);
    assert.match(text(await broken), /failed unexpectedly/);
    assert.match(text(await third), /analysis of req-3/);
    assert.equal(chains(s.delegator).size, 0);
  } finally {
    s.cleanup();
  }
});

test("a reused delegation that times out removes the entry and closes the pane", async () => {
  const s = setup(["req-1", "req-2", "req-3"], { answerAfter: (id) => (id === "req-2" ? null : 1000) });
  try {
    await s.delegator.handle(input());
    const out = text(await s.delegator.handle(input()));
    assert.match(out, /analysis timed out/);
    assert.match(out, /\/images\/[0-9a-f]{64}\.png/);
    assert.equal(state(s.reqDir("req-2")).status, "timed_out");
    assert.equal(s.registry.get(SESSION), undefined);
    assert.ok(s.of("closePane").some((c) => c.args[0] === "vision-pane-1"));
    // The next image starts clean in a new pane.
    assert.match(text(await s.delegator.handle(input())), /analysis of req-3/);
    assert.equal(s.of("startAgent").length, 2);
    assert.equal(s.registry.get(SESSION)?.paneId, "vision-pane-2");
  } finally {
    s.cleanup();
  }
});

test("a reused delegation whose prompt throws fails explicitly and drops the session", async () => {
  const s = setup(["req-1", "req-2"]);
  try {
    await s.delegator.handle(input());
    const herdr = s.deps.herdr;
    herdr.prompt = async () => {
      throw new Error("agent_blocked");
    };
    const out = text(await s.delegator.handle(input()));
    assert.match(out, /agent_blocked/);
    assert.equal(s.registry.get(SESSION), undefined);
    assert.ok(s.of("closePane").some((c) => c.args[0] === "vision-pane-1"));
  } finally {
    s.cleanup();
  }
});

test("R12: a result written just before the pane exits is still delivered", async () => {
  let gone = false;
  const s = setup(["req-1"], { answerAfter: () => null, getAgent: async (t) => (gone ? null : liveAgent(t)) });
  try {
    // At the first pane check (5th poll) the result lands and the pane is gone in the same instant.
    s.deps.herdr.getAgent = async (t) => {
      if (s.clock.now() >= 2000 && !gone) {
        writeResult(s.reqDir("req-1"), { description: "written just before exit" });
        gone = true;
      }
      return gone ? null : liveAgent(s.names.get(t) ?? t);
    };
    const out = text(await s.delegator.handle(input()));
    assert.match(out, /written just before exit/);
    assert.equal(state(s.reqDir("req-1")).status, "done");
  } finally {
    s.cleanup();
  }
});

// --- C1 (R22): a reused pane is addressed by its unique agent name, and its pane id must match ---

const NAME1 = "vision-session--req-1";

test("C1: a registered name now answering from a different pane is never prompted or closed; a new session starts", async () => {
  let imposter = false;
  const s = setup(["req-1", "req-2"], {
    getAgent: async (t) => {
      if (t === NAME1) return liveAgent(imposter ? "user-pane-9" : "vision-pane-1");
      return liveAgent(s.names.get(t) ?? t);
    },
  });
  try {
    await s.delegator.handle(input());
    assert.equal(s.registry.get(SESSION)?.agentName, NAME1);
    imposter = true;
    const out = text(await s.delegator.handle(input({ images: [IMG2] })));
    assert.ok(
      s.of("getAgent").some((c) => c.args[0] === NAME1),
      "the reuse check asks by agent name",
    );
    assert.equal(s.of("prompt").length, 0, "nothing is typed into the pane or the imposter");
    assert.equal(s.of("closePane").length, 0, "the unconfirmed pane is never closed");
    assert.equal(s.of("startAgent").length, 2, "a new vision session is started");
    assert.match(out, /analysis of req-2/);
    assert.match(out, /earlier images .*no longer in the vision session's context/i);
    const entry = s.registry.get(SESSION);
    assert.equal(entry?.paneId, "vision-pane-2");
    assert.equal(entry?.agentName, "vision-session--req-2");
  } finally {
    s.cleanup();
  }
});

test("C1: a registered name that herdr no longer knows starts a new session, and a later failure closes only the new pane", async () => {
  let gone = false;
  const s = setup(["req-1", "req-2"], {
    answerAfter: (id) => (id === "req-2" ? null : 1000),
    getAgent: async (t) => {
      if (t === NAME1) return gone ? null : liveAgent("vision-pane-1");
      return liveAgent(s.names.get(t) ?? t);
    },
  });
  try {
    await s.delegator.handle(input());
    gone = true;
    const out = text(await s.delegator.handle(input()));
    assert.match(out, /analysis timed out/);
    assert.match(out, /earlier images .*no longer in the vision session's context/i);
    assert.equal(s.of("prompt").length, 0);
    assert.deepEqual(
      s.of("closePane").map((c) => c.args[0]),
      ["vision-pane-2"],
      "only the pane this call created is closed, never vision-pane-1",
    );
    assert.equal(s.registry.get(SESSION), undefined, "the stale entry is gone and the failed new one never registered");
  } finally {
    s.cleanup();
  }
});

test("C1: a confirmed reuse prompts the agent by name, never by bare pane id", async () => {
  const s = setup(["req-1", "req-2"]);
  try {
    await s.delegator.handle(input());
    await s.delegator.handle(input({ images: [IMG2] }));
    const prompts = s.of("prompt");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.args[0], NAME1);
    assert.ok(!s.of("getAgent").some((c) => c.args[0] === "vision-pane-1"), "never looked up by bare pane id");
  } finally {
    s.cleanup();
  }
});
