import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DurableMemoryRecord } from "../../src/blackhole/durableProvider.ts";
import { HindsightDurableMemory, HindsightError } from "../../src/blackhole/hindsight.ts";
import { registerInteractiveMemory } from "../../src/blackhole/interactiveMemory.ts";
import { legacyOpenVikingPresent, warnLegacyOpenViking } from "../../src/blackhole/legacyOpenViking.ts";
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
  const env = { PI_HINDSIGHT_ENABLED: "1", PI_HINDSIGHT_CLI: CLI, PI_ENGINEERING_STATE_DIR: dir };
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
    assert.match(viaEnv[0]!.text, /PI_HINDSIGHT_ENABLED=1/);
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
