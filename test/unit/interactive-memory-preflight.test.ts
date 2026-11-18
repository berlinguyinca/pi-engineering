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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { resetHindsightBackoff } from "../../src/blackhole/hindsight.ts";
import { registerInteractiveMemory } from "../../src/blackhole/interactiveMemory.ts";

/** The same contracts as `hindsight-preflight.test.ts`, plus the two read paths the hooks exercise. */
const SCRIPT = `#!/bin/sh
mode=\${FIXTURE_MODE:-healthy}
case "$1" in
  --version) echo '{"client":"0.1.8","contract":1,"harness":"pi"}'; exit 0 ;;
  validate-config) echo '{"valid":true,"contract":1,"client":"0.1.8"}'; exit 0 ;;
  doctor) echo '{"ok":true,"checks":[{"name":"credential:project","ok":true,"detail":"readable, private permissions"},{"name":"server","ok":true,"detail":"reachable and credential accepted"}]}'; exit 0 ;;
  recall)
    [ "$mode" = "read_slow" ] && sleep 2
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
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
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

/** The automatic path (session readiness), where there is no command answer to compose into. */
test("#717: a failing host explains itself once per episode, not once per turn", async () => {
  resetHindsightBackoff();
  const f = fixture();
  try {
    await withMode("missing_bank", async () => {
      const gap = /not provisioned on this host/;
      await f.emit("session_start");
      await waitNotices(f.notices, gap, 1);
      assert.match(f.notices.map((n) => n.text).join("\n"), /PUT \/v1\/default\/banks\//);
      await f.emit("session_start");
      // Give the second probe time to fail (and to explain, if it were going to) before counting.
      await waitNotices(f.notices, /exited unsuccessfully/, 2);
      assert.equal(
        f.notices.filter((n) => gap.test(n.text)).length,
        1,
        "a second failure inside the interval does not repeat the explanation",
      );
    });
  } finally {
    f.cleanup();
  }
});
