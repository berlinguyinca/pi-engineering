/**
 * Phase 5 parity: Hindsight ("one store per fact"), per-worker prompt context, and the offline one-model mode.
 * Real processes: a real omp (gated on OMP_BIN), a scripted OpenAI-compatible model over real HTTP, and the repo's
 * own herdr-memory stub script (test/fixtures/herdr-memory-stub.sh) behind a logging shell wrapper. No mocks.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { OMP_FIREWALL_OVERLAY_YML } from "../../src/omp/firewall.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { OFFLINE_MODEL, engineerModelScript, realOmpEnv, startOfflineOmp } from "../support/ompOffline.ts";
import { startScriptedModel } from "../support/scriptedModelServer.ts";

const real = realOmpEnv();
const skip = real ? false : "UNVERIFIED: OMP_BIN not set; no real omp available";
const GOAL = "Implement add(a, b) to return the sum of a and b";
const ADD_OK = "export function add(a, b) {\n  return a + b;\n}\n";
const STUB = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures", "herdr-memory-stub.sh");
const scratch = mkdtempSync(join(tmpdir(), "pe-parity-mc-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Set `env` on process.env (omp inherits it from the host) for the duration of `fn`, then restore. */
async function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === v) continue;
    before.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1)];
  });
}

// ------------------------------------------------------------------ Hindsight

const FACT = "Project convention: the add function lives in src/add.js and uses ES modules.";

interface HindsightRun {
  calls: string[];
  context: string;
  outcome: string;
  files: string[];
}

/** A logging wrapper around the real stub script: every herdr-memory call lands in `log`, then the stub answers. */
function memoryCli(name: string): { cli: string; log: string; db: string } {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const stub = join(dir, "stub.sh");
  writeFileSync(stub, readFileSync(STUB, "utf8"));
  chmodSync(stub, 0o755);
  const cli = join(dir, "herdr-memory");
  const log = join(dir, "calls.log");
  const db = join(dir, "hindsight.jsonl");
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(stub)} "$@"\n`);
  chmodSync(cli, 0o755);
  writeFileSync(db, `${FACT}\n`);
  return { cli, log, db };
}

const callsOf = (log: string): string[] => {
  let body = "";
  try {
    body = readFileSync(log, "utf8");
  } catch {}
  return body
    .split("\n")
    .filter(Boolean)
    .map((l) => l.replace(/\b(WI|CAND|RUN|run|wi)-[A-Za-z0-9]+/g, "<id>"))
    .sort();
};

/** Poll until the herdr-memory call count is non-zero and unchanged for 500 ms (10 s deadline), instead of a blind sleep. */
async function waitForCalls(log: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const n = callsOf(log).length;
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    } else if (n > 0 && Date.now() - stableSince >= 500) return;
    await sleep(100);
  }
  throw new Error(`herdr-memory calls never settled (saw ${last})`);
}

async function hindsightRun(path: "legacy" | "omp"): Promise<HindsightRun> {
  const mem = memoryCli(`hindsight-${path}`);
  const fx = await makeFixtureRepo();
  const offline = path === "omp" ? await startOfflineOmp(engineerModelScript({ implement: ADD_OK })) : undefined;
  const blackhole = {
    config: {
      enabled: true,
      durable: { kind: "hindsight" as const, cli: mem.cli, scopes: ["project"], timeoutMs: 5000, harness: "pi" },
      providerTimeoutMs: 5000,
    },
  };
  let context = "";
  try {
    const env = { ...(offline?.env ?? {}), MEMORY_STUB_DB: mem.db };
    return await withEnv(env, async () => {
      const worker =
        path === "legacy"
          ? new FakeWorkerExecutor({
              scout: (req) => {
                context = req.context ?? "";
                return { status: "completed", summary: "scouted", details: {} };
              },
              implementer: async (req) => {
                const { writeFile } = await import("node:fs/promises");
                await writeFile(join(req.cwd, "src", "add.js"), ADD_OK, "utf8");
                return { status: "completed", summary: "implemented", details: {} };
              },
              reviewer: () => ({ status: "completed", summary: "clean", details: { findings: [] } }),
            })
          : undefined; // omp: EngineeringRuntime.open makes the production selection from the flags
      const rt = await EngineeringRuntime.open({ cwd: fx.root, worker, verifier: new CommandVerifier(), blackhole });
      let outcome: string;
      try {
        outcome = (await rt.engineer(GOAL)).outcome;
      } finally {
        await rt.close();
      }
      await waitForCalls(mem.log); // fire-and-forget memory workers settle
      if (offline) {
        const scout = offline.server.turns.find((t) => /# Role: scout/.test(t.system));
        context = scout?.system ?? "";
      }
      return { calls: callsOf(mem.log), context, outcome, files: offline ? walk(offline.home) : [] };
    });
  } finally {
    await offline?.close();
    await fx.cleanup();
  }
}

describe(
  "Hindsight: PE memory calls equal legacy, omp leaves no memory-named files",
  { skip, timeout: 300_000 },
  () => {
    it("PE's herdr-memory calls are identical on both paths and no memory-named file appears in the omp HOME", async () => {
      const legacy = await hindsightRun("legacy");
      const omp = await hindsightRun("omp");
      assert.equal(omp.outcome, legacy.outcome);
      assert.ok(legacy.calls.length > 0, "the herdr-memory stub was called (the fixture exercises Hindsight)");
      assert.deepEqual(omp.calls, legacy.calls, "same herdr-memory calls, same arguments");
      assert.match(legacy.context, /\[hindsight durable memory\]/, "legacy worker context carries the recalled fact");
      assert.match(omp.context, /\[hindsight durable memory\]/, "omp worker prompt carries the same recalled fact");
      assert.ok(omp.context.includes(FACT), "the recalled fact reaches the omp worker prompt verbatim");
      // skill-descriptions.db is omp's startup cache of skill descriptions (skills are disabled, it holds no memory);
      // Library/Caches is bun's package cache and .omp/logs are omp's own logs.
      const own = omp.files.filter((f) => !f.startsWith("Library/Caches/") && !f.startsWith(".omp/logs/"));
      const leaked = own.filter((f) =>
        /memor|mnemo|hindsight|autolearn|rollout|insight|managed-skills|^\.omp\/agent\/skills/i.test(f),
      );
      assert.deepEqual(leaked, [], `no omp memory files in the isolated HOME (files: ${own.join(", ")})`);
    });

    it("the firewall overlay switches omp memory and autolearn off", () => {
      assert.match(OMP_FIREWALL_OVERLAY_YML, /memory:\n {2}backend: "off"/);
      assert.match(OMP_FIREWALL_OVERLAY_YML, /autolearn:\n {2}enabled: false/);
    });
  },
);

// -------------------------------------------------------------------- context

interface Sizes {
  system: number;
  tools: number;
  messages: number;
}
const sizesOf = (raw: string): Sizes => {
  const body = JSON.parse(raw) as { messages?: Array<{ role?: string }>; tools?: unknown[] };
  const msgs = body.messages ?? [];
  const isSys = (m: { role?: string }) => m.role === "system" || m.role === "developer";
  return {
    system: JSON.stringify(msgs.filter(isSys)).length,
    tools: JSON.stringify(body.tools ?? []).length,
    messages: JSON.stringify(msgs.filter((m) => !isSys(m))).length,
  };
};
const total = (s: Sizes): number => s.system + s.tools + s.messages;
/** token approximation: chars / 4 (no tokenizer is a dependency of this repo) */
const tokens = (s: Sizes): number => Math.ceil(total(s) / 4);

/** The first request of each worker role (assistantTurns === 0): the context a worker starts with. */
function firstRequests(server: { turns: Array<{ system: string; assistantTurns: number }>; bodies: string[] }): Record<
  string,
  Sizes & { raw: string }
> {
  const out: Record<string, Sizes & { raw: string }> = {};
  server.turns.forEach((turn, i) => {
    const role = /# Role: (\w+)/.exec(turn.system)?.[1] ?? "unknown";
    if (turn.assistantTurns === 0 && !out[role])
      out[role] = { ...sizesOf(server.bodies[i] ?? "{}"), raw: server.bodies[i] ?? "" };
  });
  return out;
}

/**
 * A RATCHET AGAINST GROWTH, not a parity claim: omp's starting context is larger than legacy's and the ratio
 * only bounds how much worse it may get. Measured on the scripted flow: scout +13%, reviewer +12%, implementer
 * +24% (omp's own bash/read/edit/grep/glob tool text, tools chars 11312 vs 9106, and a ~230 char user message).
 * It was +34% before the overlay set edit.mode=replace and turned off bash async/auto-background (src/omp/firewall.ts).
 * The remainder is omp's built-in tool text, which PE cannot trim without upstream changes (report: Known gaps);
 * it is pinned, not endorsed. Two bounds per role: a ratio over legacy, and an absolute token ceiling so a slow
 * drift of both paths cannot hide behind the ratio.
 */
const CONTEXT_BUDGET: Record<string, number> = { implementer: 0.28 };
const DEFAULT_BUDGET = 0.15;
const budgetOf = (role: string): number => CONTEXT_BUDGET[role] ?? DEFAULT_BUDGET;
/** Absolute ceilings on the omp path's starting context in approx tokens (measured omp: scout 2617, implementer 3671, reviewer 2794; legacy 2311 / 2972 / 2485). */
const OMP_CEILING_TOKENS: Record<string, number> = { scout: 3000, implementer: 3800, reviewer: 3200 };

async function legacyAgentDir(baseUrl: string): Promise<string> {
  const dir = mkdtempSync(join(scratch, "legacy-agent-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        pelocal: {
          baseUrl,
          api: "openai-completions",
          apiKey: "sk-local-not-used",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
          models: [
            {
              id: "scripted",
              name: "scripted",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ defaultProvider: "pelocal", defaultModel: "scripted", enabledModels: ["pelocal/scripted"] }),
  );
  return dir;
}

/** Every instruction source omp discovers in the repository, each carrying its own sentinel. */
function poisonRepo(root: string): void {
  const files: Record<string, string> = {
    "AGENTS.md": "LEAK-SENTINEL-agents\n",
    "CLAUDE.md": "LEAK-SENTINEL-claude\n",
    "SYSTEM.md": "LEAK-SENTINEL-system\n",
    ".github/copilot-instructions.md": "LEAK-SENTINEL-copilot\n",
    ".cursor/rules/r.mdc": "---\nalwaysApply: true\n---\nLEAK-SENTINEL-cursor\n",
    ".claude/skills/leak/SKILL.md":
      "---\nname: leak\ndescription: LEAK-SENTINEL-skill\n---\nLEAK-SENTINEL-skill-body\n",
    ".omp/rules/r.md": "LEAK-SENTINEL-rule\n",
    ".omp/SYSTEM.md": "LEAK-SENTINEL-ompsystem\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  execFileSync("git", ["-C", root, "add", "-A", "-f"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "poison"]);
}

/** User-level skills, rules and context files in every discovery root of the isolated HOME. */
function poisonHome(home: string): void {
  for (const root of [".omp/agent", ".claude", ".codex", ".agents", ".pi/agent"]) {
    mkdirSync(join(home, root, "skills", "leak"), { recursive: true });
    writeFileSync(
      join(home, root, "skills", "leak", "SKILL.md"),
      "---\nname: leak\ndescription: LEAK-SENTINEL-homeskill\n---\nLEAK-SENTINEL-homeskill\n",
    );
  }
  mkdirSync(join(home, ".omp", "agent", "rules"), { recursive: true });
  writeFileSync(join(home, ".omp", "agent", "rules", "r.md"), "LEAK-SENTINEL-homerule\n");
  writeFileSync(join(home, ".omp", "agent", "AGENTS.md"), "LEAK-SENTINEL-homeompagents\n");
  writeFileSync(join(home, "AGENTS.md"), "LEAK-SENTINEL-homeagents\n");
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "LEAK-SENTINEL-homeclaude\n");
}

const SENTINEL = /LEAK-SENTINEL-[a-z]+/g;
const sentinelsIn = (bodies: readonly string[]): string[] => [
  ...new Set(bodies.flatMap((b) => b.match(SENTINEL) ?? [])),
];

/** The firewalled omp path (PE's real worker selection) on a poisoned repo and HOME: every request body of every turn. */
async function firewalledBodies(): Promise<string[]> {
  const fx = await makeFixtureRepo();
  const offline = await startOfflineOmp(engineerModelScript({ implement: ADD_OK }));
  try {
    poisonRepo(fx.root);
    poisonHome(offline.home);
    await withEnv(offline.env, async () => {
      const rt = await EngineeringRuntime.open({ cwd: fx.root, verifier: new CommandVerifier() });
      try {
        assert.equal((await rt.engineer(GOAL)).outcome, "promoted");
      } finally {
        await rt.close();
      }
    });
    return [...offline.server.bodies];
  } finally {
    await offline.close();
    await fx.cleanup();
  }
}

/** Positive control: the same poisoned repo and HOME, a real omp run WITHOUT the firewall flags. */
async function unfirewalledBodies(): Promise<string[]> {
  const fx = await makeFixtureRepo();
  const offline = await startOfflineOmp(() => ({ kind: "text", text: "ok" }));
  try {
    poisonRepo(fx.root);
    poisonHome(offline.home);
    const launch = real as { bin: string; args: string };
    await new Promise<void>((resolve) => {
      const child = execFile(
        launch.bin,
        [...launch.args.split(" ").filter(Boolean), "-p", "say ok", "--no-session", "--model", OFFLINE_MODEL],
        { cwd: fx.root, env: offline.env, timeout: 90_000 },
        () => resolve(),
      );
      child.stdin?.end(); // omp -p reads piped stdin until EOF
    });
    return [...offline.server.bodies];
  } finally {
    await offline.close();
    await fx.cleanup();
  }
}

async function measure(path: "legacy" | "omp"): Promise<Record<string, Sizes & { raw: string }>> {
  const fx = await makeFixtureRepo();
  try {
    const script = engineerModelScript({ implement: ADD_OK });
    if (path === "omp") {
      const offline = await startOfflineOmp(script);
      try {
        await withEnv(offline.env, async () => {
          const rt = await EngineeringRuntime.open({ cwd: fx.root, verifier: new CommandVerifier() });
          try {
            assert.equal((await rt.engineer(GOAL)).outcome, "promoted");
          } finally {
            await rt.close();
          }
        });
        return firstRequests(offline.server);
      } finally {
        await offline.close();
      }
    }
    const server = await startScriptedModel(script);
    try {
      const agentDir = await legacyAgentDir(server.baseUrl);
      const worker = new PiWorkerExecutor({
        agentDir,
        aps: false,
        gatewayConfig: resolveGatewayConfig({ enabled: false }),
      });
      const rt = await EngineeringRuntime.open({ cwd: fx.root, agentDir, worker, verifier: new CommandVerifier() });
      try {
        assert.equal((await rt.engineer(GOAL)).outcome, "promoted");
      } finally {
        await rt.close();
      }
      return firstRequests(server);
    } finally {
      await server.close();
    }
  } finally {
    await fx.cleanup();
  }
}

describe("per-worker prompt context", { skip, timeout: 600_000 }, () => {
  it("omp starting context ratchets against growth (not a parity claim): per-role ratio and absolute ceiling", async () => {
    const legacy = await measure("legacy");
    const omp = await measure("omp");
    const rows: string[] = ["role | path | system chars | tools chars | messages chars | approx tokens"];
    for (const role of Object.keys(legacy)) {
      for (const [name, m] of [
        ["legacy", legacy],
        ["omp", omp],
      ] as const) {
        const s = m[role];
        if (s) rows.push(`${role} | ${name} | ${s.system} | ${s.tools} | ${s.messages} | ${tokens(s)}`);
      }
    }
    console.log(`CONTEXT-METRICS\n${rows.join("\n")}`);
    assert.ok(Object.keys(legacy).length >= 2 && Object.keys(omp).length >= 2, "measured at least two roles");
    for (const role of Object.keys(legacy)) {
      const l = legacy[role];
      const o = omp[role];
      assert.ok(l && o, `role ${role} measured on both paths`);
      assert.ok(
        tokens(o) <= Math.ceil(tokens(l) * (1 + budgetOf(role))),
        `${role}: omp ${tokens(o)} tokens vs legacy ${tokens(l)} exceeds the +${budgetOf(role) * 100}% ratchet`,
      );
      const ceiling = OMP_CEILING_TOKENS[role];
      assert.ok(ceiling !== undefined, `role ${role} has an absolute ceiling`);
      assert.ok(tokens(o) <= ceiling, `${role}: omp ${tokens(o)} tokens exceeds the absolute ceiling ${ceiling}`);
    }
  });

  it("no skills, context files or rules leak into ANY request of an omp worker (firewall), and the control proves they are discoverable", async () => {
    const control = await unfirewalledBodies();
    const surfaced = sentinelsIn(control);
    assert.ok(
      surfaced.length > 0,
      "positive control: an unfirewalled omp run must surface at least one sentinel, else the leak scan proves nothing",
    );
    console.log(`FIREWALL-CONTROL unfirewalled omp surfaced: ${surfaced.join(", ")}`);
    const bodies = await firewalledBodies();
    assert.ok(bodies.length >= 3, "every role made at least one request");
    assert.deepEqual(sentinelsIn(bodies), [], "no discovery root reached any turn of any role, tool results included");
  });
});

// -------------------------------------------------------------- offline mode

describe("proxy-dead mode (not a connection-attempt proof)", { skip, timeout: 300_000 }, () => {
  it("the engineer flow completes on the omp path with every proxy variable pointing at a dead port and loopback exempt", async () => {
    const fx = await makeFixtureRepo();
    const offline = await startOfflineOmp(engineerModelScript({ implement: ADD_OK }));
    const dead = "http://127.0.0.1:9";
    try {
      await withEnv(
        {
          ...offline.env,
          HTTP_PROXY: dead,
          HTTPS_PROXY: dead,
          ALL_PROXY: dead,
          http_proxy: dead,
          https_proxy: dead,
          all_proxy: dead,
          // the scripted model on loopback is the ONE model; everything else would have to cross the dead proxy
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
        async () => {
          const rt = await EngineeringRuntime.open({ cwd: fx.root, verifier: new CommandVerifier() });
          try {
            const report = await rt.engineer(GOAL);
            assert.equal(report.outcome, "promoted");
            assert.equal(report.verification?.passed, true);
          } finally {
            await rt.close();
          }
        },
      );
      assert.ok(offline.server.turns.length >= 3, "every role talked to the one local model");
    } finally {
      await offline.close();
      await fx.cleanup();
    }
  });
});
