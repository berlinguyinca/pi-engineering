/**
 * #717 — the operator sees *why* memory failed, not just that it failed.
 *
 * Before this, every memory failure produced one of seven canned sentences, and the two states an operator
 * acts on differently — "this host was never provisioned" and "the read was slow this turn" — both read as
 * `herdr-memory timed out` / `herdr-memory is unavailable`. The preflight (`memoryPreflight.ts`) decides which
 * one it is from the CLI's own contracts; these tests drive the real extension hooks against a real fixture
 * executable and assert the notice that reaches the operator.
 *
 * No stubbed CLI: `memory.hindsight.cli` points at a spawned script that prints the contracts recorded from
 * the pinned client, so the notice is produced from real subprocess output through the production parser.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { resetHindsightBackoff } from "../../src/blackhole/hindsight.ts";
import { registerInteractiveMemory } from "../../src/blackhole/interactiveMemory.ts";

/** The same contracts as `hindsight-preflight.test.ts`, plus the two read paths the hooks exercise. */
const SCRIPT = `#!/bin/sh
mode=\${FIXTURE_MODE:-healthy}
if [ -n "\${FIXTURE_LOG:-}" ]; then echo "$1" >> "$FIXTURE_LOG"; fi
case "$1" in
  --version)
    [ "$mode" = "wedged" ] && sleep 2
    echo '{"client":"0.1.8","contract":1,"harness":"pi"}'; exit 0 ;;
  validate-config) echo '{"valid":true,"contract":1,"client":"0.1.8"}'; exit 0 ;;
  doctor) echo '{"ok":true,"checks":[{"name":"credential:project","ok":true,"detail":"readable, private permissions"},{"name":"server","ok":true,"detail":"reachable and credential accepted"}]}'; exit 0 ;;
  recall)
    [ "$mode" = "read_slow" ] && sleep 2
    [ "$mode" = "wedged" ] && sleep 2
    echo '{"results":[]}'
    exit 0
    ;;
  documents)
    case "$mode" in
      read_slow) sleep 2 ;;
      missing_bank) echo '{"error":"Memory service rejected request (HTTP 404)"}'; exit 1 ;;
    esac
    echo '{"bank_id":"pi-engineering-facts","scope":"project","documents":[],"total":3,"total_is_estimate":false,"offset":0}'
    exit 0
    ;;
esac
echo '{}'
exit 0
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "im-preflight-"));
  const cli = join(dir, "herdr-memory");
  writeFileSync(cli, SCRIPT, { mode: 0o755 });
  chmodSync(cli, 0o755);
  const callLog = join(dir, "calls.log");
  const previousLog = process.env.FIXTURE_LOG;
  process.env.FIXTURE_LOG = callLog;
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  writeFileSync(
    join(agentDir, "engineering.yaml"),
    `memory:\n  hindsight:\n    enabled: true\n    cli: ${JSON.stringify(cli)}\n    scopes: ["project"]\n    timeout_ms: 300\n    failure_backoff_ms: 1000\n`,
  );
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const notices: Array<{ text: string; type: string }> = [];
  const statuses: string[] = [];
  const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<void>>();
  const pi = {
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ) => commands.set(name, command),
    on: (event: string, handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<void>) =>
      events.set(event, handler),
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: dir,
    hasUI: true,
    ui: {
      setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? ""),
      notify: (text: string, type: string) => notices.push({ text, type }),
    },
  } as unknown as ExtensionCommandContext;
  registerInteractiveMemory(pi, { env: () => ({ PI_CODING_AGENT_DIR: agentDir }) });
  return {
    notices,
    statuses,
    run: async (args: string) => {
      const command = commands.get("memory");
      assert.ok(command, "/memory is registered");
      await command.handler(args, ctx);
    },
    /** Fire a lifecycle hook the way the harness does, so the automatic path is exercised too. */
    emit: async (event: string, payload: unknown = {}) => {
      const handler = events.get(event);
      assert.ok(handler, `${event} is registered`);
      await handler(payload, ctx);
    },
    /** Every action the CLI was asked for, in order — so "it did not re-probe" is a fact, not a reading. */
    calls: (): string[] => {
      try {
        return readFileSync(callLog, "utf8")
          .split("\n")
          .filter((line) => line.length > 0);
      } catch {
        return [];
      }
    },
    cleanup: () => {
      if (previousLog === undefined) delete process.env.FIXTURE_LOG;
      else process.env.FIXTURE_LOG = previousLog;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Wait for a notice the code produces asynchronously. The explanation is deliberately fire-and-forget — a
 * failed readiness probe must not hold the session open — so the test waits for the fact rather than for a
 * fixed wall-clock nap.
 */
async function waitNotices(
  notices: Array<{ text: string; type: string }>,
  pattern: RegExp,
  want: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (notices.filter((n) => pattern.test(n.text)).length >= want) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(
    `expected ${want} notice(s) matching ${pattern} within ${timeoutMs} ms; got:\n${notices.map((n) => n.text).join("\n")}`,
  );
}

/** The mode has to stay set until the last spawn, because the runner reads the environment per call. */
function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FIXTURE_MODE;
  process.env.FIXTURE_MODE = mode;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.FIXTURE_MODE;
    else process.env.FIXTURE_MODE = previous;
  });
}

test("#717: /memory status prints one preflight line per check", async () => {
  resetHindsightBackoff();
  const f = fixture();
  try {
    await withMode("healthy", () => f.run("status"));
    const text = f.notices.map((n) => n.text).join("\n");
    assert.match(text, /Memory connection verified/);
    // The checks are the CLI's own answers quoted back, not a generic "memory is fine".
    assert.match(text, /client\s+ok\s+client 0\.1\.8 \(contract 1\)/);
    assert.match(text, /config\s+ok\s+configuration valid/);
    assert.match(text, /credentials:project\s+ok\s+readable, private permissions/);
    assert.match(text, /server\s+ok\s+reachable and credential accepted/);
    assert.match(text, /bank:project\s+ok\s+pi-engineering-facts resolves \(3 record\(s\)\)/);
  } finally {
    f.cleanup();
  }
});

test("#717: a slow read says slow, and never claims the host is unprovisioned", async () => {
  resetHindsightBackoff();
  const f = fixture();
  try {
    await withMode("read_slow", () => f.run("status"));
    const text = f.notices.map((n) => n.text).join("\n");
    assert.match(text, /timed out/, text);
    // The verdict line is the half of the answer that tells the operator to wait rather than install.
    assert.match(text, /Every check answered \u2014 nothing to install or configure on this host\./, text);
    assert.doesNotMatch(text, /not installed|does not exist|not provisioned/, text);
    // The slow bank read is still reported, as a warning with what it cost.
    assert.match(text, /bank:project\s+warn/);
  } finally {
    f.cleanup();
  }
});

test("#717: a never-written bank says the bank is missing and names the remedy", async () => {
  resetHindsightBackoff();
  const f = fixture();
  try {
    await withMode("missing_bank", () => f.run("status"));
    const text = f.notices.map((n) => n.text).join("\n");
    assert.match(text, /Failing checks: bank:project/, text);
    assert.match(text, /bank for scope project does not exist/);
    assert.match(text, /PUT \/v1\/default\/banks\//);
  } finally {
    f.cleanup();
  }
});

/**
 * The state a report with no failures is most likely to get wrong: a client that answers nothing would print
 * "nothing to install or configure", which is the opposite of useful.
 */
test("#717: /memory status on a wedged client claims neither healthy nor unprovisioned", async () => {
  resetHindsightBackoff();
  const f = fixture();
  try {
    await withMode("wedged", () => f.run("status"));
    const text = f.notices.map((n) => n.text).join("\n");
    assert.match(text, /nothing answered either/, text);
    assert.doesNotMatch(text, /nothing to install or configure/, text);
    assert.doesNotMatch(text, /not provisioned/, text);
    // The client check itself is still printed, with what it cost, so the operator sees which call hung.
    assert.match(text, /client\s+warn/);
  } finally {
    f.cleanup();
  }
});

/** The automatic path (session readiness), where there is no command answer to compose into. */
test("#717: a failing host explains itself once per episode, not once per turn", async () => {
  resetHindsightBackoff();
  const f = fixture();
  try {
    await withMode("missing_bank", async () => {
      // The standalone explanation is its own notice; a failure notice merely quotes the verdict it produced.
      const explanation = (text: string) => text.startsWith("Memory is not provisioned on this host:");
      await f.emit("session_start");
      await waitNotices(f.notices, /not provisioned on this host/, 1);
      assert.match(f.notices.map((n) => n.text).join("\n"), /PUT \/v1\/default\/banks\//);
      assert.equal(f.notices.filter((n) => explanation(n.text)).length, 1, "the episode is explained once");
      await f.emit("session_start");
      // Give the second probe time to fail (and to explain, if it were going to) before counting.
      await waitNotices(f.notices, /exited unsuccessfully/, 2);
      assert.equal(
        f.notices.filter((n) => explanation(n.text)).length,
        1,
        "a second failure inside the interval does not repeat the explanation",
      );
      // It does not go quiet either: the second notice carries the verdict the first one produced.
      const second = f.notices.filter((n) => /exited unsuccessfully/.test(n.text)).at(-1)!;
      assert.match(second.text, /not provisioned on this host/, "the notice says install, not retry");
    });
  } finally {
    f.cleanup();
  }
});

/**
 * The invariant #673 pinned, restated for the preflight: a client that just failed to answer is not asked
 * again. Four spawns after a timeout would be four more calls to the thing that is not answering.
 */
test("#717: a client that timed out is not re-probed", async () => {
  resetHindsightBackoff();
  const f = fixture();
  try {
    // Readiness first, in a healthy mode, so the turn below pays the in-turn budget (300 ms) not the startup one.
    await withMode("healthy", () => f.emit("session_start"));
    await withMode("read_slow", async () => {
      await f.emit("before_agent_start", { prompt: "metric units", systemPrompt: "" });
      await waitNotices(f.notices, /timed out/, 1);
      const calls = f.calls();
      assert.ok(calls.includes("recall"), "the read itself was attempted");
      assert.ok(
        !calls.includes("--version") && !calls.includes("doctor") && !calls.includes("validate-config"),
        `a timed-out client was re-probed: ${calls.join(" ")}`,
      );
    });
  } finally {
    f.cleanup();
  }
});
