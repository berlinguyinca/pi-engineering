import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DurableMemoryRecord } from "../../src/blackhole/durableProvider.ts";
import { HindsightDurableMemory, HindsightError } from "../../src/blackhole/hindsight.ts";
import { registerInteractiveMemory } from "../../src/blackhole/interactiveMemory.ts";
import {
  legacyMemoryEnvNames,
  legacyOpenVikingPresent,
  warnLegacyMemoryEnv,
  warnLegacyOpenViking,
} from "../../src/blackhole/legacyOpenViking.ts";
import { type TelemetryNotice, resetTelemetrySinks, setTelemetrySink } from "../../src/telemetry/sink.ts";

const CLI = "/nonexistent/herdr-memory";
const rec: DurableMemoryRecord = {
  id: "r1",
  text: "note",
  sourceRefs: [],
  promotedFrom: "user",
  evidenceIds: ["ev:1"],
  promotedAt: "2026-11-04T00:00:00Z",
  promotedBy: "user",
};

test("probe rethrows when the CLI is missing, while recallAll stays best-effort", async () => {
  const p = new HindsightDurableMemory({ cli: CLI });
  assert.deepEqual(await p.recallAll(), []);
  await assert.rejects(
    () => p.probe(),
    (e) => e instanceof HindsightError && e.code === "unavailable",
  );
});

test("retain keeps the failure class for a missing CLI", async () => {
  const p = new HindsightDurableMemory({ cli: CLI });
  const r = await p.retain(rec);
  assert.equal(r.outcome, "rejected");
  assert.equal(r.error, "unavailable");
  await assert.rejects(
    () => p.store(rec),
    (e) => e instanceof HindsightError && e.code === "unavailable",
  );
});

function harness(hasUI: boolean) {
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const statuses: string[] = [];
  const notices: string[] = [];
  const pi = {
    registerCommand: (n: string, c: any) => commands.set(n, c),
    on: (n: string, f: any) => events.set(n, f),
    sendMessage: (m: any) => notices.push(m.content),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp/p",
    hasUI,
    ui: { setStatus: (_k: string, t?: string) => statuses.push(t ?? ""), notify: (t: string) => notices.push(t) },
  } as unknown as ExtensionCommandContext;
  const dir = mkdtempSync(join(tmpdir(), "hs-missing-"));
  // Real provider, YAML config, a CLI path that does not exist: the degraded path.
  writeFileSync(
    join(dir, "engineering.yaml"),
    `memory:\n  hindsight:\n    enabled: true\n    cli: ${JSON.stringify(CLI)}\n`,
  );
  const env = { PI_CODING_AGENT_DIR: dir, PI_ENGINEERING_STATE_DIR: dir };
  registerInteractiveMemory(pi, { env: () => env, headlessNoticeDir: join(dir, "n") });
  return { commands, events, statuses, notices, ctx, dir };
}

test("/memory with a missing CLI reports failure, never 'verified'", async () => {
  const h = harness(true);
  await h.commands.get("memory").handler("", h.ctx);
  const all = h.notices.join("\n");
  assert.doesNotMatch(all, /verified/);
  assert.match(all, /unavailable/);
  assert.match(h.statuses.at(-1)!, /unavailable/);
  rmSync(h.dir, { recursive: true, force: true });
});

test("/remember with a missing CLI says unavailable, not refused", async () => {
  const h = harness(true);
  await h.commands.get("remember").handler("hello", h.ctx);
  const all = h.notices.join("\n");
  assert.match(all, /unavailable/);
  assert.doesNotMatch(all, /refused the write/);
  rmSync(h.dir, { recursive: true, force: true });
});

test("startup check with a missing CLI emits the unavailable warning headless", async () => {
  const h = harness(false);
  const seen: TelemetryNotice[] = [];
  setTelemetrySink((n) => seen.push(n));
  try {
    await h.events.get("session_start")({}, h.ctx);
  } finally {
    resetTelemetrySinks();
  }
  assert.ok(seen.some((n) => n.key === "memory:unavailable"));
  rmSync(h.dir, { recursive: true, force: true });
});

test("legacy OpenViking config: warns once on presence, silent otherwise, never prints values", () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-legacy-"));
  try {
    assert.equal(legacyOpenVikingPresent({ PI_CODING_AGENT_DIR: dir }), false);
    const quiet: TelemetryNotice[] = [];
    warnLegacyOpenViking({ PI_CODING_AGENT_DIR: dir }, (n) => quiet.push(n));
    assert.deepEqual(quiet, []);

    const viaEnv: TelemetryNotice[] = [];
    warnLegacyOpenViking({ PI_CODING_AGENT_DIR: dir, PI_OPENVIKING_BASE_URL: "https://secret-host.example/tok" }, (n) =>
      viaEnv.push(n),
    );
    assert.equal(viaEnv.length, 1);
    assert.match(viaEnv[0]!.text, /Hindsight/);
    assert.match(viaEnv[0]!.text, /herdr-eng memory install/);
    assert.doesNotMatch(viaEnv[0]!.text, /PI_HINDSIGHT_ENABLED=1/);
    assert.doesNotMatch(JSON.stringify(viaEnv), /secret-host/);

    mkdirSync(join(dir, "engineering-memory"), { recursive: true });
    writeFileSync(join(dir, "engineering-memory", "connection.json"), '{"baseUrl":"https://secret-host.example"}');
    const viaFile: TelemetryNotice[] = [];
    warnLegacyOpenViking({ PI_CODING_AGENT_DIR: dir }, (n) => viaFile.push(n));
    assert.equal(viaFile.length, 1);
    assert.doesNotMatch(JSON.stringify(viaFile), /secret-host/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warnLegacyOpenViking never throws even if the sink does", () => {
  assert.doesNotThrow(() =>
    warnLegacyOpenViking({ PI_OPENVIKING_BASE_URL: "x" }, () => {
      throw new Error("boom");
    }),
  );
});

test("legacy PI_HINDSIGHT_* env vars: one warning naming the YAML key, never the value, never throws", () => {
  const quiet: TelemetryNotice[] = [];
  warnLegacyMemoryEnv({ HOME: "/h" }, (n) => quiet.push(n));
  assert.deepEqual(quiet, []);

  const seen: TelemetryNotice[] = [];
  warnLegacyMemoryEnv(
    {
      PI_HINDSIGHT_ENABLED: "1",
      PI_HINDSIGHT_CLI: "/secret/path/tok",
      PI_HINDSIGHT_TIMEOUT_MS: "9",
      PI_OPENVIKING_X: "y",
    },
    (n) => seen.push(n),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.level, "warning");
  assert.match(seen[0]!.text, /PI_HINDSIGHT_ENABLED -> memory\.hindsight\.enabled/);
  assert.match(seen[0]!.text, /PI_HINDSIGHT_CLI -> memory\.hindsight\.cli/);
  assert.match(seen[0]!.text, /PI_HINDSIGHT_TIMEOUT_MS -> memory\.hindsight\.timeout_ms/);
  assert.match(seen[0]!.text, /PI_OPENVIKING_X \(no longer used\)/);
  assert.doesNotMatch(JSON.stringify(seen), /secret|tok/);
  assert.deepEqual(legacyMemoryEnvNames({ PI_HINDSIGHT_SCOPES: "global" }), ["PI_HINDSIGHT_SCOPES"]);
  assert.doesNotThrow(() =>
    warnLegacyMemoryEnv({ PI_HINDSIGHT_ENABLED: "1" }, () => {
      throw new Error("sink down");
    }),
  );
});

test("set PI_HINDSIGHT_* env vars do not enable memory (YAML only)", async () => {
  const h = harness(true);
  const saved = { ...process.env };
  try {
    writeFileSync(join(h.dir, "engineering.yaml"), "memory:\n  hindsight:\n    enabled: false\n");
    process.env.PI_HINDSIGHT_ENABLED = "1";
    process.env.PI_HINDSIGHT_CLI = CLI;
    await h.commands.get("memory").handler("", h.ctx);
    assert.match(h.notices.join("\n"), /Memory is off/);
  } finally {
    process.env = saved;
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/** Default settings (no YAML at all) with the real provider pointed at a CLI path that does not exist. */
function defaultHarness(hasUI: boolean) {
  const events = new Map<string, any>();
  const statuses: string[] = [];
  const notices: string[] = [];
  const pi = {
    registerCommand: () => {},
    on: (n: string, f: any) => events.set(n, f),
    sendMessage: (m: any) => notices.push(m.content),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp/p",
    hasUI,
    ui: { setStatus: (_k: string, t?: string) => statuses.push(t ?? ""), notify: (t: string) => notices.push(t) },
  } as unknown as ExtensionCommandContext;
  const dir = mkdtempSync(join(tmpdir(), "hs-default-"));
  let clock = 1_000_000;
  const providers: string[] = [];
  registerInteractiveMemory(pi, {
    env: () => ({ PI_CODING_AGENT_DIR: dir, PI_ENGINEERING_STATE_DIR: dir }),
    headlessNoticeDir: join(dir, "n"),
    now: () => clock,
    // The only override: the default executable name is swapped for a path that cannot exist.
    provider: (config) => {
      providers.push(config.cli);
      return new HindsightDurableMemory({
        cli: CLI,
        scopes: config.scopes,
        timeoutMs: config.timeoutMs,
        harness: config.harness,
      });
    },
  });
  return {
    events,
    statuses,
    notices,
    ctx,
    dir,
    providers,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("default settings, CLI unreachable: starts, shows at most one notice, never spams per turn", async () => {
  const h = defaultHarness(true);
  try {
    const started = Date.now();
    await h.events.get("session_start")({}, h.ctx);
    for (let i = 0; i < 4; i++) {
      await h.events.get("before_agent_start")({ prompt: "metric units please" }, h.ctx);
    }
    // Past the unavailable backoff the retry fails again: same failure class, still no second notice.
    h.advance(400_000);
    await h.events.get("before_agent_start")({ prompt: "metric units again" }, h.ctx);
    assert.ok(Date.now() - started < 5000, "no hang beyond the automatic lookup cap");
    assert.equal(h.providers[0], "herdr-memory", "default settings (no YAML) enable memory with the default CLI name");
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0]!, /unavailable/);
    assert.match(h.notices[0]!, /enabled: false/);
    assert.ok(h.statuses.some((t) => /unavailable/.test(t)));
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("default settings, CLI unreachable, headless: one telemetry warning, no transcript message", async () => {
  const h = defaultHarness(false);
  const seen: TelemetryNotice[] = [];
  setTelemetrySink((n) => seen.push(n));
  try {
    await h.events.get("session_start")({}, h.ctx);
    await h.events.get("before_agent_start")({ prompt: "metric units please" }, h.ctx);
    await h.events.get("before_agent_start")({ prompt: "metric units again" }, h.ctx);
  } finally {
    resetTelemetrySinks();
    rmSync(h.dir, { recursive: true, force: true });
  }
  assert.equal(seen.filter((n) => n.key === "memory:unavailable").length, 1);
  assert.deepEqual(h.notices, []);
});

test("explicit enabled: false in YAML makes no provider call and reports off", async () => {
  const h = defaultHarness(true);
  try {
    writeFileSync(join(h.dir, "engineering.yaml"), "memory:\n  hindsight:\n    enabled: false\n");
    await h.events.get("session_start")({}, h.ctx);
    await h.events.get("before_agent_start")({ prompt: "metric units please" }, h.ctx);
    assert.deepEqual(h.providers, []);
    assert.deepEqual(h.notices, []);
    assert.equal(h.statuses.at(-1), "Memory: off");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
