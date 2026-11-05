import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BlackholeManager } from "../../src/blackhole/BlackholeManager.ts";
import { HindsightDurableMemory, resetHindsightBackoff } from "../../src/blackhole/hindsight.ts";
import { registerInteractiveMemory } from "../../src/blackhole/interactiveMemory.ts";
import { Ledger } from "../../src/ledger/Ledger.ts";

const SECRET = "sk-live-abcdefghijklmnopqrstuvwx1234";
const AWS = "AKIAIOSFODNN7EXAMPLE";

/** A real executable that records one argv line per call, then behaves per `body`. */
function fakeCli(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "hs-fake-"));
  const log = join(dir, "argv.log");
  const cli = join(dir, "herdr-memory");
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${body}\n`);
  chmodSync(cli, 0o755);
  const calls = () => {
    try {
      return readFileSync(log, "utf-8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { dir, cli, calls };
}
const OK = `echo '{"results":[],"degraded":false,"offline":false,"timing_ms":1}'`;

test("provider search never puts a secret-looking token in argv", async () => {
  resetHindsightBackoff();
  const f = fakeCli(OK);
  try {
    const p = new HindsightDurableMemory({ cli: f.cli });
    await p.search(`deploy ${SECRET} ${AWS} password: hunter2 now`);
    const argv = f.calls().join("\n");
    assert.equal(f.calls().length, 1);
    assert.doesNotMatch(argv, /sk-live|AKIA|hunter2/);
    assert.match(argv, /deploy/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a query that is only a secret makes no CLI call", async () => {
  resetHindsightBackoff();
  const f = fakeCli(OK);
  try {
    await new HindsightDurableMemory({ cli: f.cli }).search(SECRET);
    assert.equal(f.calls().length, 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("automatic recall redacts the prompt before the CLI runs", async () => {
  resetHindsightBackoff();
  const f = fakeCli(OK);
  const events = new Map<string, any>();
  const pi = { registerCommand: () => {}, on: (n: string, h: any) => events.set(n, h), sendMessage: () => {} };
  writeFileSync(join(f.dir, "engineering.yaml"), `memory:\n  hindsight:\n    cli: ${JSON.stringify(f.cli)}\n`);
  registerInteractiveMemory(pi as unknown as ExtensionAPI, {
    env: () => ({ PI_CODING_AGENT_DIR: f.dir, PI_ENGINEERING_STATE_DIR: f.dir }),
  });
  const ctx = { cwd: f.dir, hasUI: true, ui: { setStatus() {}, notify() {} } } as unknown as ExtensionCommandContext;
  try {
    await events.get("before_agent_start")({ prompt: `please use ${SECRET} and ${AWS} metric units` }, ctx);
    const recalls = f.calls().filter((c) => c.startsWith("recall"));
    assert.ok(recalls.length >= 1);
    assert.doesNotMatch(recalls.join("\n"), /sk-live|AKIA/);
    assert.match(recalls.join("\n"), /metric/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("worker hydrate redacts the task prefix", async () => {
  resetHindsightBackoff();
  const f = fakeCli(OK);
  try {
    const mgr = await BlackholeManager.open({
      ledger: Ledger.fromEvents([]),
      config: { enabled: true, durable: { kind: "hindsight", cli: f.cli, scopes: ["project"], timeoutMs: 1000 } },
    });
    await mgr.hydrate(`wi-1 implementer rotate key ${SECRET} in config`, 10);
    assert.equal(f.calls().length, 1);
    assert.doesNotMatch(f.calls().join("\n"), /sk-live/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("hung CLI: hydrate is capped, and a second run inside the backoff makes no CLI call", async () => {
  resetHindsightBackoff();
  const f = fakeCli("sleep 3");
  try {
    const mgr = await BlackholeManager.open({
      ledger: Ledger.fromEvents([]),
      config: { enabled: true, durable: { kind: "hindsight", cli: f.cli, scopes: ["project"], timeoutMs: 5000 } },
    });
    const t0 = Date.now();
    assert.deepEqual(await mgr.hydrate("wi-1 implementer task one", 10), []);
    assert.ok(Date.now() - t0 < 1000, `hydrate took ${Date.now() - t0} ms`);
    assert.equal(f.calls().length, 1);
    const t1 = Date.now();
    assert.deepEqual(await mgr.hydrate("wi-2 implementer task two", 10), []);
    assert.ok(Date.now() - t1 < 100);
    assert.equal(f.calls().length, 1, "no CLI call while backing off");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a failing CLI backs off too (exit status)", async () => {
  resetHindsightBackoff();
  const f = fakeCli("exit 3");
  try {
    const p = new HindsightDurableMemory({ cli: f.cli });
    await p.search("first query here");
    await p.search("second query here");
    assert.equal(f.calls().length, 1);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
