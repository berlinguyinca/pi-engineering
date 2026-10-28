/** Real, opt-in Herdr/Pi engineering canary. Never runs in the ordinary test suite.
 * node scripts/validate-herdr-engineering-canary.mjs --profile /private/profile
 *   --provider PROVIDER --model MODEL --evidence /path/to/nonsecret-evidence.json
 * Add --bootstrap-only to check isolation and cleanup without any inference calls.
 * Requires Node 22, herdr, pi, Git and util-linux script. No packages are installed.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HerdrAgentRuntime } from "../src/runtime/herdr/HerdrAgentRuntime.ts";
import { RealHerdrCli } from "../src/runtime/herdr/HerdrCli.ts";
import { cleanupOwnedCanary, stopOwnedCanaryProcess, trackOwnedCanaryProcess } from "./support/ownedCanaryProcess.ts";

const exec = promisify(execFile);
const self = fileURLToPath(import.meta.url);
const repository = resolve(dirname(self), "..");
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );

function options() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bootstrap-only") {
      out.bootstrapOnly = true;
      continue;
    }
    assert.ok(["--profile", "--provider", "--model", "--evidence"].includes(args[i]), "Unknown canary option");
    const key = args[i].slice(2);
    assert.ok(args[i + 1], `Missing ${args[i]} value`);
    out[key] = args[++i];
  }
  for (const key of ["profile", "provider", "model", "evidence"]) assert.ok(out[key], `--${key} is required`);
  return out;
}

async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args], { timeout: 15_000 })).stdout.trim();
}

async function host() {
  const opts = options();
  const source = resolve(opts.profile);
  const models = JSON.parse(await readFile(join(source, "models.json"), "utf8"));
  const model = models.providers?.[opts.provider]?.models?.find((candidate) => candidate.id === opts.model);
  assert.ok(
    model && model.maxTokens > 0 && model.maxTokens <= 256,
    "Selected private model must cap output at 256 tokens",
  );
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-engineering-"));
  const session = root.split("/").at(-1).toLowerCase();
  const bin = join(homedir(), ".local/bin/herdr");
  const config = join(root, "config.toml");
  const sessionDirectory = join(homedir(), ".config/herdr/sessions", session);
  const socket = join(sessionDirectory, "herdr.sock");
  const env = {
    ...process.env,
    HERDR_CONFIG_PATH: config,
    HERDR_VALIDATION_DIR: root,
    HERDR_VALIDATION_SESSION: session,
    PI_CODING_AGENT_DIR: join(root, "profile"),
    PI_AGENT_DIR: join(root, "profile"),
    PI_ENGINEERING_HOME: join(root, "runtime"),
    PI_ENGINEERING_STATE_DIR: join(root, "state"),
  };
  let server;
  let client;
  let ownsSessionDirectory = false;
  try {
    await mkdir(dirname(sessionDirectory), { recursive: true, mode: 0o700 });
    // Exclusive creation prevents a rare name collision from attaching to or deleting an existing session.
    await mkdir(sessionDirectory, { mode: 0o700 });
    ownsSessionDirectory = true;
    await mkdir(env.PI_CODING_AGENT_DIR, { mode: 0o700 });
    for (const name of ["models.json", "auth.json"]) {
      await copyFile(join(source, name), join(env.PI_CODING_AGENT_DIR, name));
      await chmod(join(env.PI_CODING_AGENT_DIR, name), 0o600);
    }
    await writeFile(
      join(env.PI_CODING_AGENT_DIR, "settings.json"),
      JSON.stringify({
        defaultProvider: opts.provider,
        defaultModel: opts.model,
        defaultThinkingLevel: "off",
        packages: [],
      }),
      { mode: 0o600 },
    );
    const fixture = join(root, "repo");
    await mkdir(join(fixture, "test"), { recursive: true });
    await git(fixture, "init", "-q");
    await git(fixture, "config", "user.name", "Owned Canary");
    await git(fixture, "config", "user.email", "canary@localhost");
    await writeFile(
      join(fixture, "test/arithmetic.test.mjs"),
      `import assert from "node:assert/strict";
import { test } from "node:test";
import { add } from "../add.mjs";
import { subtract } from "../subtract.mjs";
test("add handles positive, negative and zero operands", () => {
  assert.equal(add(2, 3), 5); assert.equal(add(-2, 1), -1); assert.equal(add(0, 0), 0);
});
test("subtract handles positive, negative and zero operands", () => {
  assert.equal(subtract(7, 2), 5); assert.equal(subtract(-2, -3), 1); assert.equal(subtract(0, 0), 0);
});
`,
    );
    await git(fixture, "add", "test/arithmetic.test.mjs");
    await git(fixture, "commit", "-qm", "Lock arithmetic behavior before independent workers implement it");
    await writeFile(
      join(root, "options.json"),
      JSON.stringify({ ...opts, baseline: await git(fixture, "rev-parse", "HEAD"), session }),
    );
    const system =
      "You are an isolated validation worker. Use only your current disposable Git worktree. Never use the network or access secrets or other directories. Complete the assigned task in at most two tool calls, then a compact JSON final response with no Markdown. Each assistant response must stay below 256 tokens. Do not inspect unrelated files.";
    const flags = [
      "--provider",
      opts.provider,
      "--model",
      opts.model,
      "--thinking",
      "off",
      "--tools",
      "read,write,bash",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--system-prompt",
      system,
    ];
    await writeFile(
      join(root, "herdr-owned"),
      `#!/bin/bash
set -eu
test "\${HERDR_ENV:-}" = 1
test "$HERDR_VALIDATION_SESSION" = ${quote(session)}
${quote(bin)} --session ${quote(session)} status server | /usr/bin/grep -qFx ${quote(`socket: ${socket}`)}
if test "\${1:-}" = agent && test "\${2:-}" = start; then
  exec ${quote(bin)} --session ${quote(session)} "$@" -- ${flags.map(quote).join(" ")}
fi
exec ${quote(bin)} --session ${quote(session)} "$@"
`,
      { mode: 0o700 },
    );
    // Keep the initial pane alive even if discovery or the managed test fails.
    await writeFile(
      join(root, "bootstrap.sh"),
      `#!/bin/bash
if mkdir ${quote(join(root, "bootstrap-once"))} 2>/dev/null; then
  ${quote(process.execPath)} ${quote(self)} --managed >${quote(join(root, "managed.log"))} 2>&1
  printf '%s\\n' "$?" >${quote(join(root, "managed.exit"))}
  if test -f ${quote(join(root, "client-detached"))}; then
    ${quote(join(root, "herdr-owned"))} server stop >>${quote(join(root, "managed.log"))} 2>&1
  fi
fi
exec /bin/bash --noprofile --norc
`,
      { mode: 0o700 },
    );
    await writeFile(
      config,
      `onboarding = false\n[terminal]\ndefault_shell = ${JSON.stringify(join(root, "bootstrap.sh"))}\nshell_mode = "non_login"\nnew_cwd = ${JSON.stringify(root)}\n[worktrees]\ndirectory = ${JSON.stringify(join(root, "worktrees"))}\n`,
    );
    server = trackOwnedCanaryProcess(
      spawn(bin, ["--session", session, "server"], {
        env,
        cwd: root,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const serverLog = createWriteStream(join(root, "server.log"));
    server.child.stdout.pipe(serverLog);
    server.child.stderr.pipe(serverLog);
    for (let i = 0; i < 100 && !(await exists(socket)); i++) {
      assert.ok(!server.closed && !server.error, "Owned headless server failed before creating its socket");
      await pause(100);
    }
    assert.ok(await exists(socket), "Owned server did not create its named socket");
    // Socket ownership is checked again from inside the genuine managed pane.
    client = trackOwnedCanaryProcess(
      spawn(
        "script",
        [
          "-qefc",
          `stty rows 40 cols 120\nexec ${[bin, "--session", session].map(quote).join(" ")}`,
          join(root, "client.log"),
        ],
        {
          env,
          cwd: root,
          detached: true,
          stdio: "ignore",
        },
      ),
    );
    for (let i = 0; i < 200 && !(await exists(join(root, "ready"))); i++) {
      assert.ok(!client.closed && !client.error, "Owned TUI client failed before managed bootstrap readiness");
      await pause(100);
    }
    assert.ok(await exists(join(root, "ready")), "Genuine managed bootstrap did not become ready");
    await stopOwnedCanaryProcess(client);
    assert.ok(client.closed, "Owned TUI client must detach before test work or pane cleanup");
    await writeFile(join(root, "client-detached"), "ready");
    let printed = 0;
    for (let i = 0; i < 2000 && !(await exists(join(root, "result.json"))); i++) {
      if (await exists(join(root, "progress.jsonl"))) {
        const lines = (await readFile(join(root, "progress.jsonl"), "utf8")).trim().split("\n");
        for (const line of lines.slice(printed)) console.log(line);
        printed = lines.length;
      }
      await pause(500);
    }
    assert.ok(await exists(join(root, "result.json")), "Owned engineering canary did not finish");
    const result = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
    await writeFile(resolve(opts.evidence), `${JSON.stringify(result, null, 2)}\n`);
    assert.equal(
      result.status,
      "passed",
      `Engineering canary failed at ${result.stage}; error type ${result.errorType}`,
    );
    assert.equal(result.ownedAgentsRemaining, 0, "Every owned worker must terminate before server cleanup");
    for (let i = 0; i < 100 && !server.closed; i++) await pause(100);
    assert.ok(server.closed, "Owned server did not shut down from its managed pane");
    console.log(
      `${opts.bootstrapOnly ? "Bootstrap check" : "Engineering canary"} passed: ${result.assistantRequests} assistant responses; owned server stopped.`,
    );
  } catch (error) {
    if (!(await exists(join(root, "ready")))) {
      const diagnostics = await mkdtemp(join(tmpdir(), "pi-herdr-startup-diagnostics-"));
      for (const filename of ["managed.log", "server.log", "client.log", "bootstrap.sh"]) {
        if (await exists(join(root, filename))) await copyFile(join(root, filename), join(diagnostics, filename));
      }
      console.error(`Private startup diagnostics: ${diagnostics}`);
    }
    throw error;
  } finally {
    await cleanupOwnedCanary({ client, server, root, sessionDirectory, ownsSessionDirectory });
  }
}

async function managed() {
  const root = process.env.HERDR_VALIDATION_DIR;
  assert.equal(process.env.HERDR_ENV, "1", "Never fake Herdr's managed-pane environment");
  assert.equal(process.env.PI_CODING_AGENT_DIR, join(root, "profile"));
  assert.equal(process.env.PI_AGENT_DIR, join(root, "profile"));
  const opts = JSON.parse(await readFile(join(root, "options.json"), "utf8"));
  assert.equal(process.env.HERDR_VALIDATION_SESSION, opts.session);
  const cli = new RealHerdrCli({ bin: join(root, "herdr-owned"), timeoutMs: 40_000 });
  const health = await cli.status();
  assert.equal(health.ok, true);
  await writeFile(join(root, "ready"), "genuine managed pane and exact owned socket verified");
  while (!(await exists(join(root, "client-detached")))) await pause(100);
  if (opts.bootstrapOnly) {
    await writeFile(
      join(root, "result.json"),
      JSON.stringify({
        status: "passed",
        bootstrapOnly: true,
        assistantRequests: 0,
        ownedAgentsRemaining: (await cli.listAgents()).length,
        session: opts.session,
      }),
    );
    return;
  }
  const rt = new HerdrAgentRuntime({ cli });
  const fixture = join(root, "repo");
  const workers = [];
  let stage = "planner";
  let assistantRequests = 0;
  const evidence = {
    status: "running",
    serverVersion: health.serverVersion,
    protocol: health.protocol,
    session: opts.session,
    baseline: opts.baseline,
    workers,
  };
  async function messages(cwd) {
    for (const rel of await readdir(join(root, "profile/sessions"), { recursive: true })) {
      if (!rel.endsWith(".jsonl")) continue;
      const entries = (await readFile(join(root, "profile/sessions", rel), "utf8"))
        .trim()
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      if (entries[0]?.cwd === cwd)
        return entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
    }
    return [];
  }
  async function worker(name, role, objective) {
    const deadline = Date.now() + 180_000;
    const rid = await rt.create({ role, objective, isolation: "worktree", cwd: fixture });
    const record = { name, role, runtimeId: rid, messages: [] };
    workers.push(record);
    try {
      const started = await rt.start(rid);
      record.worktree = started.worktree;
      await rt.sendTask(rid, objective);
      let all = [];
      let assistants = [];
      while (Date.now() < deadline) {
        all = await messages(started.worktree);
        assistants = all.filter((message) => message.role === "assistant");
        record.messages = assistants.map((message) => ({
          provider: message.provider,
          model: message.model,
          stopReason: message.stopReason,
          inputTokens: message.usage?.input,
          outputTokens: message.usage?.output,
          content: message.content.filter((part) => part.type === "text" || part.type === "toolCall"),
        }));
        assert.ok(assistants.length <= 3, `${name} exceeded three assistant responses`);
        const total = workers.reduce((sum, item) => sum + item.messages.length, 0);
        assert.ok(total <= 15, "Combined follow-up response budget exceeded");
        const last = assistants.at(-1);
        if (last && last.stopReason !== "toolUse") break;
        assert.ok(assistants.length < 3, "Stop before an additional tool round exceeds the worker budget");
        await pause(200);
      }
      const last = assistants.at(-1);
      assert.ok(last && last.stopReason === "stop", `${name} did not finish successfully within its bounded deadline`);
      for (const message of assistants) {
        assert.equal(message.provider, opts.provider);
        assert.equal(message.model, opts.model);
        assert.ok(message.usage.output <= 256);
      }
      const text = last.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      record.response = JSON.parse(text);
      record.toolResults = all
        .filter((message) => message.role === "toolResult")
        .map((message) => ({
          toolName: message.toolName,
          isError: Boolean(message.isError),
          content: message.content.filter((part) => part.type === "text"),
        }));
      assert.ok(
        record.toolResults.every((result) => !result.isError),
        `${name} had a failed tool call`,
      );
      record.status = (await rt.waitFor(rid, Math.max(1, deadline - Date.now()))).status;
      assert.equal(record.status, "COMPLETED");
      record.head = await git(started.worktree, "rev-parse", "HEAD");
      await writeFile(
        join(root, "progress.jsonl"),
        `${JSON.stringify({ worker: name, status: record.status, assistantResponses: assistants.length })}\n`,
        { flag: "a" },
      );
      return record;
    } finally {
      await rt.terminate(rid);
    }
  }
  try {
    const plan = await worker(
      "planner",
      "planner",
      "No tools for this planning step. Return compact JSON with kind=plan and steps listing engineer-a, engineer-b, tester, reviewer. Engineers will implement add.mjs and subtract.mjs, tester will integrate commits and run seeded acceptance tests, reviewer will inspect the actual diff.",
    );
    assert.equal(plan.response.kind, "plan");
    stage = "engineers";
    const implement = (name, fn, behavior) =>
      worker(
        name,
        "implementer",
        `In this disposable worktree create ${fn}.mjs exporting a named function ${fn}(a,b) that ${behavior}. Do not change seeded tests or any other file. Use one bash tool call to write the file and git add/commit it. Commit intent explains why, with Confidence: high and Tested: inspection trailers. Then return compact JSON with kind=${name}, status=committed. No other tool calls needed.`,
      );
    const [a, b] = await Promise.all([
      implement("engineer-a", "add", "returns the numeric sum"),
      implement("engineer-b", "subtract", "returns a minus b"),
    ]);
    for (const [record, filename] of [
      [a, "add.mjs"],
      [b, "subtract.mjs"],
    ]) {
      assert.notEqual(record.head, opts.baseline);
      assert.equal(await git(record.worktree, "diff", "--name-only", opts.baseline, "HEAD"), filename);
      assert.equal(await git(record.worktree, "status", "--porcelain"), "");
      assert.ok(record.toolResults.length > 0, "Implementation must come from an actual model tool call");
    }
    stage = "tester";
    const testCommand = [
      process.execPath,
      "--test",
      "--import",
      join(repository, "test/support/isolatedState.ts"),
      "test/arithmetic.test.mjs",
    ];
    const tester = await worker(
      "tester",
      "test-generator",
      `Use one bash call: cherry-pick commits ${a.head} and ${b.head} into this owned worktree, then run ${testCommand.map(quote).join(" ")}. Do not edit any source or tests. Return compact JSON with kind=test, status=passed only if the command exits zero.`,
    );
    assert.equal(tester.response.status, "passed");
    assert.ok(
      tester.toolResults.some((result) => result.toolName === "bash"),
      "Tester must execute an actual command",
    );
    const tested = await exec(testCommand[0], testCommand.slice(1), { cwd: tester.worktree, timeout: 15_000 });
    evidence.verification = { command: testCommand, exitCode: 0, stdout: tested.stdout, stderr: tested.stderr };
    evidence.diff = await git(tester.worktree, "diff", opts.baseline, "HEAD", "--", "add.mjs", "subtract.mjs");
    evidence.files = {
      "add.mjs": await readFile(join(tester.worktree, "add.mjs"), "utf8"),
      "subtract.mjs": await readFile(join(tester.worktree, "subtract.mjs"), "utf8"),
    };
    stage = "reviewer";
    const reviewer = await worker(
      "reviewer",
      "reviewer",
      `Use one bash call to inspect the real Git diff: git diff ${opts.baseline} ${tester.head} -- add.mjs subtract.mjs. These changes passed the seeded node tests with exit 0. Independently review the actual diff for addition/subtraction correctness. Do not modify files. Return compact JSON with kind=review, verdict=approve or reject, and a short reason.`,
    );
    assert.equal(reviewer.response.verdict, "approve");
    assert.ok(
      reviewer.toolResults.some(
        (result) => result.toolName === "bash" && result.content.some((part) => part.text.includes("diff --git")),
      ),
      "Reviewer must inspect a real diff",
    );
    assert.equal(new Set(workers.map((record) => record.runtimeId)).size, 5);
    assert.equal(new Set(workers.map((record) => record.worktree)).size, 5);
    evidence.status = "passed";
    evidence.limitations = [
      "No durable server-restart recovery or full migration rollback was exercised.",
      "Structured result-tool extraction remains unproved; model evidence is read from owned persisted session messages.",
    ];
  } catch (error) {
    evidence.status = "failed";
    evidence.stage = stage;
    evidence.errorType = error.name;
    // Full errors stay in the private managed log; never copy provider errors or credentials into evidence.
    console.error(error);
  } finally {
    assistantRequests = workers.reduce((sum, record) => sum + record.messages.length, 0);
    evidence.assistantRequests = assistantRequests;
    evidence.ownedAgentsRemaining = (await cli.listAgents()).length;
    await writeFile(join(root, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}

if (process.argv[2] === "--managed") await managed();
else await host();
