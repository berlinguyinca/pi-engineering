/**
 * Context firewall, proved against a REAL omp (gated on OMP_BIN, offline: a
 * scripted local model and a temp HOME). A repository that tries every way omp
 * has of pulling skills / auto-learn into a session must produce a worker session
 * that sees none of it. A control run WITHOUT the firewall proves the fixture
 * is not vacuous: omp does load these skills by default.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OmpWorkerExecutor } from "../../src/omp/OmpWorkerExecutor.ts";
import { OFFLINE_MODEL, realOmpEnv, startOfflineOmp } from "../support/ompOffline.ts";
import type { ScriptReply, ScriptTurn } from "../support/scriptedModelServer.ts";

const real = realOmpEnv();
const skip = real ? false : "UNVERIFIED: OMP_BIN not set; no real omp available to prove the firewall";

const MARKERS = {
  project: "ZZ-PROJECT-CLAUDE-SKILL-MARKER",
  agents: "ZZ-AGENTS-USER-SKILL-MARKER",
  managed: "ZZ-MANAGED-SKILL-MARKER",
};

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: ${marker} use this when asked about ${marker}\n---\n\nBody of ${marker}.\n`;
}

/** A repo plus HOME that turn every skill source and auto-learn switch ON. */
function hostileFixture(): { repo: string; cleanup: () => void; home: string } {
  const repo = mkdtempSync(join(tmpdir(), "pe-fw-repo-"));
  mkdirSync(join(repo, ".claude", "skills", "x"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skills", "x", "SKILL.md"), skillMd("x", MARKERS.project));
  mkdirSync(join(repo, ".omp"), { recursive: true });
  writeFileSync(join(repo, ".omp", "config.yml"), "autolearn:\n  enabled: true\n");
  return { repo, home: "", cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

function plantHome(home: string): void {
  mkdirSync(join(home, ".agents", "skills", "z"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "z", "SKILL.md"), skillMd("z", MARKERS.agents));
  mkdirSync(join(home, ".omp", "agent", "managed-skills", "y"), { recursive: true });
  writeFileSync(join(home, ".omp", "agent", "managed-skills", "y", "SKILL.md"), skillMd("y", MARKERS.managed));
  writeFileSync(join(home, ".omp", "agent", "config.yml"), "autolearn:\n  enabled: true\n");
}

/** The agent's turn: omp may also make tool-less side requests (title generation) that are not the session. */
const agentTurn = (turns: ScriptTurn[]): ScriptTurn | undefined => turns.find((t) => t.toolNames.length > 0);

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

/** Control: a bare `omp --mode rpc` with the SAME model and HOME but no firewall; resolves with the first turn the model saw. */
async function bareFirstTurn(
  repo: string,
  env: NodeJS.ProcessEnv,
  bin: string,
  binArgs: string[],
  firstTurn: () => ScriptTurn | undefined,
): Promise<ScriptTurn | undefined> {
  const child: ChildProcess = spawn(
    bin,
    [...binArgs, "--mode", "rpc", "--no-session", "--model", OFFLINE_MODEL, "--tools", "read"],
    { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let buf = "";
  child.stdout?.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.includes('"type":"ready"'))
        child.stdin?.write(`${JSON.stringify({ id: "p", type: "prompt", message: "hi" })}\n`);
    }
  });
  const deadline = Date.now() + 60_000;
  while (!firstTurn() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  child.kill("SIGKILL");
  return firstTurn();
}

describe("omp context firewall (real omp, offline)", { skip }, () => {
  it("a worker session sees no skills, no manage_skill and no learn tool", async (t) => {
    const fx = hostileFixture();
    const offline = await startOfflineOmp(finish);
    t.after(async () => {
      await offline.close();
      fx.cleanup();
    });
    plantHome(offline.home);
    const exec = new OmpWorkerExecutor({
      launch: { command: real?.bin ?? "", args: (real?.args ?? "").split(/\s+/).filter(Boolean) },
      model: OFFLINE_MODEL,
      home: offline.home,
      env: offline.env,
      startTimeoutMs: 60_000,
    });
    const run = await exec.run({
      role: "scout",
      task: "inspect",
      context: "",
      cwd: fx.repo,
      tools: ["read"],
      timeoutMs: 120_000,
    } as never);
    assert.equal(run.result.status, "completed", JSON.stringify(run.result));
    const turn = agentTurn(offline.server.turns);
    assert.ok(turn, "the model must have been called");
    for (const marker of Object.values(MARKERS)) {
      assert.ok(!turn.system.includes(marker), `system prompt leaked ${marker}`);
      assert.ok(!turn.user.includes(marker), `user message leaked ${marker}`);
    }
    assert.ok(!/<skills|available_skills|## Skills/i.test(turn.system), "no skills section in the system prompt");
    for (const forbidden of ["manage_skill", "learn", "skill", "read_skill"]) {
      assert.ok(!turn.toolNames.includes(forbidden), `tool ${forbidden} must not be offered: ${turn.toolNames}`);
    }
    assert.ok(turn.toolNames.includes("worker_result"), "the host result tool is offered");
  });

  it("control: without the firewall the same repo and HOME DO load a skill (the fixture is not vacuous)", async (t) => {
    const fx = hostileFixture();
    const offline = await startOfflineOmp(finish);
    t.after(async () => {
      await offline.close();
      fx.cleanup();
    });
    plantHome(offline.home);
    const turn = await bareFirstTurn(
      fx.repo,
      offline.env,
      real?.bin ?? "",
      (real?.args ?? "").split(/\s+/).filter(Boolean),
      () => agentTurn(offline.server.turns),
    );
    assert.ok(turn, "the bare omp must have called the model");
    // Observed with omp 18.20.0: the project .claude skill and the managed skill are in the system prompt
    // and manage_skill is offered (auto-learn from the repo's .omp/config.yml).
    assert.ok(turn.system.includes(MARKERS.project), "control: project .claude skill is loaded by default");
    assert.ok(turn.system.includes(MARKERS.managed), "control: managed skill is loaded by default");
    assert.ok(turn.toolNames.includes("manage_skill"), `control: manage_skill offered; tools=${turn.toolNames}`);
  });
});
