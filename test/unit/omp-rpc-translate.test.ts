import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrameLine } from "../../src/omp/frames.ts";
import { RunCollector, buildOmpArgs, ompToolsFor, translateFrame } from "../../src/omp/rpcTranslate.ts";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/omp-frames/agent-turn-write-then-worker-result.jsonl", import.meta.url),
);
const frames = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .map((line) => parseFrameLine(line))
  .filter((f): f is Record<string, unknown> => f !== null);

describe("translateFrame over frames captured from omp 18.20.0", () => {
  const events = frames.map(translateFrame);

  it("reads the host tool call with its arguments", () => {
    const call = events.find((e) => e.kind === "host_tool_call");
    assert.ok(call && call.kind === "host_tool_call");
    assert.equal(call.toolName, "worker_result");
    assert.equal((call.args as { status: string }).status, "completed");
  });

  it("reads the prompt result", () => {
    const done = events.find((e) => e.kind === "prompt_result");
    assert.deepEqual(done, { kind: "prompt_result", status: "completed" });
  });

  it("reads responses and ignores streaming and lifecycle frames", () => {
    assert.ok(events.some((e) => e.kind === "response" && e.command === "set_host_tools" && e.success));
    assert.ok(events.some((e) => e.kind === "ignored"));
  });

  it("collects tool calls and usage across the three assistant turns", () => {
    const c = new RunCollector();
    for (const e of events) c.accept(e);
    assert.equal(c.toolCalls, 2);
    assert.equal(c.lastText, "all done");
    assert.deepEqual(c.usage(), {
      input: 1800,
      output: 120,
      total: 1920,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 740,
      turns: 3,
      model: "scripted",
    });
  });
});

describe("translateFrame edge cases", () => {
  it("maps aborted/error prompt results and keeps the error text", () => {
    assert.deepEqual(translateFrame({ type: "prompt_result", status: "error", error: "boom" }), {
      kind: "prompt_result",
      status: "error",
      error: "boom",
    });
    assert.deepEqual(translateFrame({ type: "prompt_result", status: "aborted" }), {
      kind: "prompt_result",
      status: "aborted",
    });
  });

  it("ignores a malformed host_tool_call and non-assistant message_end", () => {
    assert.equal(translateFrame({ type: "host_tool_call" }).kind, "ignored");
    assert.equal(translateFrame({ type: "message_end", message: { role: "user" } }).kind, "ignored");
  });

  it("decodes failed responses", () => {
    assert.deepEqual(translateFrame({ type: "response", id: "x", command: "prompt", success: false, error: "no" }), {
      kind: "response",
      id: "x",
      command: "prompt",
      success: false,
      error: "no",
      data: undefined,
    });
  });

  it("reports no usage when nothing was reported", () => {
    assert.equal(new RunCollector().usage(), null);
  });
});

describe("ompToolsFor / buildOmpArgs", () => {
  it("translates the PE allowlist and reports tools omp has no twin for", () => {
    const { builtin, dropped } = ompToolsFor([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "worker_result",
      "repo_search",
      "symbol",
    ]);
    assert.deepEqual(builtin, ["read", "grep", "glob", "bash"]);
    assert.deepEqual(dropped, ["repo_search", "symbol"]);
  });

  it("builds the firewall flags", () => {
    const args = buildOmpArgs({ model: "p/m", systemPrompt: "SYS", builtin: ["read"] });
    for (const flag of [
      "--no-session",
      "--no-skills",
      "--no-extensions",
      "--no-rules",
      "--no-context-files",
      "--no-lsp",
    ]) {
      assert.ok(args.includes(flag), flag);
    }
    assert.deepEqual(args.slice(args.indexOf("--tools")), ["--tools", "read", "--system-prompt", "SYS"]);
    assert.ok(buildOmpArgs({ systemPrompt: "S", builtin: [] }).includes("--no-tools"));
  });
});

describe("firewall overlay", () => {
  it("is passed to every worker launch and disables autolearn, memory, every skill root and managed skills", async () => {
    const { readFileSync } = await import("node:fs");
    const args = buildOmpArgs({ systemPrompt: "S", builtin: [] });
    const overlay = args[args.indexOf("--config") + 1] as string;
    const yml = readFileSync(overlay, "utf8");
    for (const key of [
      "autolearn:\n  enabled: false",
      'backend: "off"',
      "enableClaudeProject: false",
      "enableAgentsProject: false",
      "enablePiProject: false",
      "- omp-managed",
    ]) {
      assert.ok(yml.includes(key), key);
    }
    assert.equal(overlay, args[args.indexOf("--config") + 1]);
  });
});
