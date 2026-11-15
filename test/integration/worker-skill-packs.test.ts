/**
 * Opt-in worker skill packs, end to end with real processes: a scripted OpenAI-compatible model over real HTTP, the
 * legacy PiWorkerExecutor, and (gated on OMP_BIN) a real omp. No mocks of PE code.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { OmpWorkerExecutor } from "../../src/omp/OmpWorkerExecutor.ts";
import { WORKER_SKILLS_ENV } from "../../src/skillpack/workerPacks.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import { OFFLINE_MODEL, realOmpEnv, startOfflineOmp } from "../support/ompOffline.ts";
import { type ScriptReply, type ScriptTurn, startScriptedModel } from "../support/scriptedModelServer.ts";
import { repoGrantingPack } from "../support/workerSkillFixture.ts";

const real = realOmpEnv();
const ompSkip = real ? false : "UNVERIFIED: OMP_BIN not set; no real omp available";
const scratch = mkdtempSync(join(tmpdir(), "pe-wsp-int-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const finish = (turn: ScriptTurn): ScriptReply =>
  turn.priorCalls.includes("worker_result")
    ? { kind: "text", text: "done" }
    : {
        kind: "tool",
        name: "worker_result",
        args: {
          status: "completed",
          summary: "ok",
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
      };
const agentTurn = (turns: ScriptTurn[]): ScriptTurn | undefined => turns.find((t) => t.toolNames.length > 0);
/** Ratchet: first-request bytes (request body) the pe-operator pack may add for a granted role. Lower it, never raise it. */
const OMP_PACK_BYTE_CEILING = 400; // measured 305
const LEGACY_PACK_BYTE_CEILING = 1_100; // measured 903 (pi's skill preamble is larger)
const SKILL_SECTION = /<available_skills>|## Skills|pe-operator/;

async function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
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

function legacyAgentDir(baseUrl: string): string {
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

interface LegacySeen {
  turn: ScriptTurn;
  body: string;
  activity: string[];
}

async function legacyFirstTurn(
  fx: { repo: string; state: string },
  role: "scout" | "implementer",
  env: NodeJS.ProcessEnv,
): Promise<LegacySeen> {
  const server = await startScriptedModel(finish);
  try {
    const worker = new PiWorkerExecutor({
      agentDir: legacyAgentDir(server.baseUrl),
      aps: false,
      gatewayConfig: resolveGatewayConfig({ enabled: false }),
    });
    const activity: string[] = [];
    await withEnv({ PI_ENGINEERING_STATE_DIR: fx.state, ...env }, () =>
      worker.run({
        role,
        task: "inspect",
        context: "",
        cwd: fx.repo,
        tools: ["read"],
        timeoutMs: 120_000,
        onActivity: (a: { summary: string }) => activity.push(a.summary),
      } as never),
    );
    const turn = agentTurn(server.turns);
    assert.ok(turn, "the model must have been called");
    return { turn, activity, body: server.bodies[server.turns.indexOf(turn)] ?? "" };
  } finally {
    await server.close();
  }
}

describe("worker skill packs: legacy path", () => {
  it("sees the pack's skill only for the allowlisted role", async () => {
    const fx = repoGrantingPack(["scout"]);
    const scout = await legacyFirstTurn(fx, "scout", { [WORKER_SKILLS_ENV]: "1" });
    assert.match(scout.turn.system, /pe-operator/, "allowlisted role gets the skill");
    const impl = await legacyFirstTurn(fx, "implementer", { [WORKER_SKILLS_ENV]: "1" });
    assert.ok(!SKILL_SECTION.test(impl.turn.system), "other roles stay skill-less");
  });

  it("context budget ratchet: the pe-operator pack adds a bounded first-request cost for the granted role", async () => {
    const fx = repoGrantingPack(["scout"]);
    const on = await legacyFirstTurn(fx, "scout", { [WORKER_SKILLS_ENV]: "1" });
    const off = await legacyFirstTurn(fx, "scout", { [WORKER_SKILLS_ENV]: undefined });
    const delta = Buffer.byteLength(on.body) - Buffer.byteLength(off.body);
    console.log(
      `worker-skills legacy first-request bytes: off=${Buffer.byteLength(off.body)} on=${Buffer.byteLength(on.body)} delta=${delta}`,
    );
    assert.ok(delta > 0 && delta <= LEGACY_PACK_BYTE_CEILING, `pack grew the first request by ${delta} bytes`);
  });

  it("switch off: the allowlist alone changes nothing", async () => {
    const fx = repoGrantingPack(["scout"]);
    const scout = await legacyFirstTurn(fx, "scout", { [WORKER_SKILLS_ENV]: undefined });
    assert.ok(!SKILL_SECTION.test(scout.turn.system));
  });

  it("a tampered pack is refused: no skill, and a visible diagnostic", async () => {
    const fx = repoGrantingPack(["scout"]);
    appendFileSync(join(fx.repo, "skill-packs", "pe-operator", "skills", "pe-operator", "SKILL.md"), "\nevil\n");
    const scout = await legacyFirstTurn(fx, "scout", { [WORKER_SKILLS_ENV]: "1" });
    assert.ok(!SKILL_SECTION.test(scout.turn.system), "fail closed: the worker runs without the pack");
    assert.ok(
      scout.activity.some((s) => s.startsWith("worker skill pack refused (scout): pe-operator: digest mismatch")),
      `diagnostic missing: ${scout.activity.join(" | ")}`,
    );
  });
});

const MARKERS = {
  project: "ZZ-PROJECT-CLAUDE-SKILL-MARKER",
  agents: "ZZ-AGENTS-USER-SKILL-MARKER",
  managed: "ZZ-MANAGED-SKILL-MARKER",
};
const skillMd = (name: string, marker: string) =>
  `---\nname: ${name}\ndescription: ${marker} use for ${marker}\n---\n\nBody ${marker}.\n`;

async function ompFirstTurn(
  fx: { repo: string; state: string },
  role: string,
  env: NodeJS.ProcessEnv,
): Promise<{ turn: ScriptTurn; activity: string[]; body: string }> {
  const offline = await startOfflineOmp(finish);
  try {
    // Hostile surroundings: foreign and managed skills plus auto-learn switched on everywhere.
    mkdirSync(join(fx.repo, ".claude", "skills", "x"), { recursive: true });
    writeFileSync(join(fx.repo, ".claude", "skills", "x", "SKILL.md"), skillMd("x", MARKERS.project));
    mkdirSync(join(fx.repo, ".omp"), { recursive: true });
    writeFileSync(join(fx.repo, ".omp", "config.yml"), "autolearn:\n  enabled: true\n");
    mkdirSync(join(offline.home, ".agents", "skills", "z"), { recursive: true });
    writeFileSync(join(offline.home, ".agents", "skills", "z", "SKILL.md"), skillMd("z", MARKERS.agents));
    mkdirSync(join(offline.home, ".omp", "agent", "managed-skills", "y"), { recursive: true });
    writeFileSync(
      join(offline.home, ".omp", "agent", "managed-skills", "y", "SKILL.md"),
      skillMd("y", MARKERS.managed),
    );
    writeFileSync(join(offline.home, ".omp", "agent", "config.yml"), "autolearn:\n  enabled: true\n");
    const exec = new OmpWorkerExecutor({
      launch: { command: real?.bin ?? "", args: (real?.args ?? "").split(/\s+/).filter(Boolean) },
      model: OFFLINE_MODEL,
      home: offline.home,
      env: { ...offline.env, PI_ENGINEERING_STATE_DIR: fx.state, ...env },
      startTimeoutMs: 60_000,
    });
    const activity: string[] = [];
    const run = await exec.run({
      role,
      task: "inspect",
      context: "",
      cwd: fx.repo,
      tools: ["read"],
      timeoutMs: 120_000,
      onActivity: (a: { summary: string }) => activity.push(a.summary),
    } as never);
    assert.equal(run.result.status, "completed", JSON.stringify(run.result));
    const turn = agentTurn(offline.server.turns);
    assert.ok(turn, "the model must have been called");
    return { turn, activity, body: offline.server.bodies[offline.server.turns.indexOf(turn)] ?? "" };
  } finally {
    await offline.close();
  }
}

describe("worker skill packs: omp path (real omp, offline)", { skip: ompSkip }, () => {
  it("allowlisted role sees only the pack's skill; no foreign, managed or manage_skill", async () => {
    const fx = repoGrantingPack(["scout"]);
    const { turn } = await ompFirstTurn(fx, "scout", { [WORKER_SKILLS_ENV]: "1" });
    assert.match(turn.system, /pe-operator/, "the pack's skill is offered");
    for (const marker of Object.values(MARKERS)) assert.ok(!turn.system.includes(marker), `leaked ${marker}`);
    for (const forbidden of ["manage_skill", "learn", "skill", "read_skill"]) {
      assert.ok(!turn.toolNames.includes(forbidden), `tool ${forbidden} must not be offered: ${turn.toolNames}`);
    }
    assert.ok(turn.toolNames.includes("worker_result"));
  });

  it("a role that is not allowlisted keeps the full firewall", async () => {
    const fx = repoGrantingPack(["scout"]);
    const { turn } = await ompFirstTurn(fx, "implementer", { [WORKER_SKILLS_ENV]: "1" });
    assert.ok(!SKILL_SECTION.test(turn.system));
    for (const marker of Object.values(MARKERS)) assert.ok(!turn.system.includes(marker));
  });

  it("context budget ratchet: the pe-operator pack adds a bounded first-request cost for the granted role", async () => {
    const fx = repoGrantingPack(["scout"]);
    const withPack = await ompFirstTurn(fx, "scout", { [WORKER_SKILLS_ENV]: "1" });
    const without = await ompFirstTurn(fx, "scout", { [WORKER_SKILLS_ENV]: undefined });
    const delta = Buffer.byteLength(withPack.body) - Buffer.byteLength(without.body);
    console.log(
      `worker-skills first-request bytes: off=${Buffer.byteLength(without.body)} on=${Buffer.byteLength(withPack.body)} delta=${delta}`,
    );
    assert.ok(delta > 0, "the pack costs something");
    assert.ok(delta <= OMP_PACK_BYTE_CEILING, `pack grew the first request by ${delta} bytes`);
  });

  it("a tampered pack is refused: no skill, visible diagnostic", async () => {
    const fx = repoGrantingPack(["scout"]);
    appendFileSync(join(fx.repo, "skill-packs", "pe-operator", "skills", "pe-operator", "SKILL.md"), "\nevil\n");
    const { turn, activity } = await ompFirstTurn(fx, "scout", { [WORKER_SKILLS_ENV]: "1" });
    assert.ok(!SKILL_SECTION.test(turn.system));
    assert.ok(activity.some((s) => s.startsWith("worker skill pack refused (scout): pe-operator: digest mismatch")));
  });
});
