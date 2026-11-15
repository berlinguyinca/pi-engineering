/**
 * Phase 5 parity: Hindsight ("one store per fact"), per-worker prompt context, and the offline one-model mode.
 * Real processes: a real omp (gated on OMP_BIN), a scripted OpenAI-compatible model over real HTTP, and the repo's
 * own herdr-memory stub script (test/fixtures/herdr-memory-stub.sh) behind a logging shell wrapper. No mocks.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { OMP_FIREWALL_OVERLAY_YML } from "../../src/omp/firewall.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { engineerModelScript, realOmpEnv, startOfflineOmp } from "../support/ompOffline.ts";
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
      await sleep(1500); // fire-and-forget memory workers settle
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

describe("Hindsight: one store per fact", { skip, timeout: 300_000 }, () => {
  it("PE's herdr-memory path behaves identically on both paths, and omp writes no memory of its own", async () => {
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
});

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
 * The documented budget: how far the omp path's starting context per worker may exceed legacy's (chars / 4).
 * Measured on the scripted flow: scout +13%, reviewer +12%, implementer +34%. The read-only roles get +15%.
 * The implementer gets +40%: it is offered omp's own bash/read/grep/find tool descriptions, which are longer than
 * legacy's, plus the pe_write/pe_edit host tools (tools chars 12539 vs 9106), and omp adds a ~230 char user message.
 * 40% leaves headroom over the measurement without hiding a doubling; tightening it needs omp's tool text trimmed.
 */
const CONTEXT_BUDGET: Record<string, number> = { implementer: 0.4 };
const DEFAULT_BUDGET = 0.15;
const budgetOf = (role: string): number => CONTEXT_BUDGET[role] ?? DEFAULT_BUDGET;

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

async function measure(path: "legacy" | "omp", poison: boolean): Promise<Record<string, Sizes & { raw: string }>> {
  const fx = await makeFixtureRepo();
  try {
    if (poison) {
      const { execFileSync } = await import("node:child_process");
      mkdirSync(join(fx.root, ".claude", "skills", "leak"), { recursive: true });
      mkdirSync(join(fx.root, ".omp", "rules"), { recursive: true });
      writeFileSync(join(fx.root, "AGENTS.md"), "LEAK-SENTINEL-agents\n");
      writeFileSync(join(fx.root, "CLAUDE.md"), "LEAK-SENTINEL-claude\n");
      writeFileSync(
        join(fx.root, ".claude", "skills", "leak", "SKILL.md"),
        "---\nname: leak\ndescription: LEAK-SENTINEL-skill\n---\nLEAK-SENTINEL-skill-body\n",
      );
      writeFileSync(join(fx.root, ".omp", "rules", "r.md"), "LEAK-SENTINEL-rule\n");
      execFileSync("git", ["-C", fx.root, "add", "-A", "-f"]);
      execFileSync("git", ["-C", fx.root, "commit", "-q", "-m", "poison"]);
    }
    const script = engineerModelScript({ implement: ADD_OK });
    if (path === "omp") {
      const offline = await startOfflineOmp(script);
      try {
        if (poison) {
          // Also poison the isolated HOME: user-level skills, rules and context files in every discovery root.
          for (const root of [".omp/agent", ".claude", ".codex", ".agents", ".pi/agent"]) {
            mkdirSync(join(offline.home, root, "skills", "leak"), { recursive: true });
            writeFileSync(
              join(offline.home, root, "skills", "leak", "SKILL.md"),
              "---\nname: leak\ndescription: LEAK-SENTINEL-homeskill\n---\nLEAK-SENTINEL-homeskill\n",
            );
          }
          writeFileSync(join(offline.home, "AGENTS.md"), "LEAK-SENTINEL-homeagents\n");
          writeFileSync(join(offline.home, ".claude", "CLAUDE.md"), "LEAK-SENTINEL-homeclaude\n");
        }
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
  it("omp path starting context stays within the documented per-role budget of legacy", async () => {
    const legacy = await measure("legacy", false);
    const omp = await measure("omp", false);
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
        `${role}: omp ${tokens(o)} tokens vs legacy ${tokens(l)} exceeds the +${budgetOf(role) * 100}% budget`,
      );
    }
  });

  it("no skills, context files or rules leak into an omp worker's requests (firewall)", async () => {
    const omp = await measure("omp", true);
    assert.ok(Object.keys(omp).length >= 2);
    for (const [role, s] of Object.entries(omp)) {
      assert.doesNotMatch(s.raw, /LEAK-SENTINEL/, `${role}: a discovery root leaked into the request`);
    }
  });
});

// -------------------------------------------------------------- offline mode

describe("offline one-model mode", { skip, timeout: 300_000 }, () => {
  it("the whole engineer flow completes on the omp path with every proxy pointing at a dead port", async () => {
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
