import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDurableProvider } from "../../src/blackhole/BlackholeManager.ts";
import type { DurableMemoryRecord } from "../../src/blackhole/durableProvider.ts";
import {
  HindsightDurableMemory,
  HindsightError,
  type HindsightProbe,
  type HindsightRunner,
  hindsightBlackholeOption,
  probeHindsightStatus,
  resolveHindsightFromEnv,
} from "../../src/blackhole/hindsight.ts";
import { registerInteractiveMemory } from "../../src/blackhole/interactiveMemory.ts";

const row = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  memory_id: id,
  bank_id: "herdr-global",
  revision: 1,
  kind: "verified_fact",
  status: "verified",
  text,
  provenance: { evidence_refs: ["ev:1"] },
  ...extra,
});
const ok = (obj: unknown) => ({ stdout: JSON.stringify(obj), exitCode: 0 });

/** Narrow a probe result to its failure half without lying to the compiler. */
function failure(result: HindsightProbe): { reason: string; detail?: string } {
  assert.equal(result.ok, false, "the probe must report the failure");
  return result as { ok: false; reason: string; detail?: string };
}
const promoted = (over: Partial<DurableMemoryRecord> = {}): DurableMemoryRecord => ({
  id: "p1",
  text: "Gradle build needs JDK 21",
  sourceRefs: [],
  promotedFrom: "cand-1",
  evidenceIds: ["ev:1"],
  promotedAt: "2026-11-02T00:00:00Z",
  promotedBy: "reviewer",
  ...over,
});

function recorder(handler: (args: string[]) => unknown | Promise<unknown>) {
  const calls: string[][] = [];
  const run: HindsightRunner = async (_cli, args) => {
    calls.push(args);
    return handler(args) as any;
  };
  return { calls, run };
}

test("opt-in: disabled unless PI_HINDSIGHT_ENABLED", () => {
  assert.equal(resolveHindsightFromEnv({}), null);
  assert.equal(resolveHindsightFromEnv({ PI_HINDSIGHT_ENABLED: "0" }), null);
  const c = resolveHindsightFromEnv({ PI_HINDSIGHT_ENABLED: "1", PI_HINDSIGHT_SCOPES: "global,bogus,mission:abc" });
  assert.deepEqual(c?.scopes, ["global", "mission:abc"]);
  assert.equal(buildDurableProvider({ kind: "hindsight" }).kind, "hindsight");
});

test("search passes scope, max-results and --timeout-ms; maps records", async () => {
  const r = recorder(() => ok({ results: [row("m1", "use JDK 21")], degraded: false, offline: false, timing_ms: 5 }));
  const p = new HindsightDurableMemory({ run: r.run, scopes: ["project", "global"], timeoutMs: 123 });
  const out = await p.search("jdk");
  assert.equal(out[0]?.id, "m1");
  assert.equal(out[0]?.bankId, "herdr-global");
  assert.equal(out[0]?.revision, 1);
  assert.deepEqual(out[0]?.sourceRefs, ["ev:1"]);
  const a = r.calls[0]!;
  assert.equal(a[0], "recall");
  assert.ok(a.includes("--timeout-ms") && a[a.indexOf("--timeout-ms") + 1] === "123");
  assert.deepEqual(
    a.flatMap((x, i) => (x === "--scope" ? [a[i + 1]] : [])),
    ["project", "global"],
  );
});

test("superseded/retracted results are never surfaced", async () => {
  const r = recorder(() =>
    ok({ results: [row("a", "x", { status: "superseded" }), row("b", "y", { status: "retracted" }), row("c", "z")] }),
  );
  const out = await new HindsightDurableMemory({ run: r.run }).search("q");
  assert.deepEqual(
    out.map((x) => x.id),
    ["c"],
  );
});

for (const [name, run, surfacesFailure] of [
  [
    "missing CLI",
    async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    },
    true,
  ],
  ["killed on timeout", async () => Promise.reject(Object.assign(new Error("x"), { killed: true })), true],
  ["nonzero exit", async () => ({ stdout: "", exitCode: 2 }), true],
  ["bad json", async () => ({ stdout: "not json", exitCode: 0 }), true],
  ["unauthorized scope (empty)", async () => ok({ results: [], degraded: true, offline: false, timing_ms: 1 }), false],
] as Array<[string, HindsightRunner, boolean]>) {
  test(`a broken recall is a typed failure the caller can fail open on: ${name}`, async () => {
    const p = new HindsightDurableMemory({ run });
    if (surfacesFailure) {
      // Surfaced as a typed code, never a raw spawn error that could carry the
      // command line, the profile path, or a credential the client echoed. Callers
      // (the context injector, /memory, /memory status) catch this and continue
      // with no memories - see interactive-memory.test.ts.
      for (const read of [() => p.search("q"), () => p.recallAll()]) {
        await assert.rejects(read(), (error: unknown) => {
          assert.ok(error instanceof HindsightError, "typed memory failure");
          assert.ok(
            !/spawn|ENOENT|ETIMEDOUT|Traceback|at .*hindsight/.test(String(error)),
            "no raw runner detail leaks",
          );
          return true;
        });
      }
    } else {
      assert.deepEqual(await p.search("q"), [], "an unauthorized scope is empty, not an error");
      assert.deepEqual(await p.recallAll(), []);
    }
  });
}

test("retain: persisted is success; queued_durable and rejected never are", async () => {
  for (const [outcome, expectStore] of [
    ["persisted", true],
    ["queued_durable", false],
    ["rejected", false],
  ] as const) {
    const r = recorder(() => ok({ outcome, memory_id: "m9", bank_id: "herdr-global", revision: 1 }));
    const p = new HindsightDurableMemory({ run: r.run, scopes: ["global"] });
    const res = await p.retain(promoted({ scope: "global" }));
    assert.equal(res.outcome, outcome);
    if (expectStore) await p.store(promoted({ scope: "global" }));
    else await assert.rejects(() => p.store(promoted({ scope: "global" })));
  }
});

test("retain on CLI failure is rejected, never success", async () => {
  const p = new HindsightDurableMemory({ run: async () => ({ stdout: "", exitCode: 1 }) });
  assert.equal((await p.retain(promoted())).outcome, "rejected");
});

test("retain gate: hypotheses, candidates, no-evidence, secrets and unconfigured scopes never reach the CLI", async () => {
  const r = recorder(() => ok({ outcome: "persisted" }));
  const p = new HindsightDurableMemory({ run: r.run, scopes: ["project"] });
  const bad: Array<Partial<DurableMemoryRecord>> = [
    { kind: "hypothesis" },
    { status: "candidate" },
    { evidenceIds: [] },
    { text: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
    { scope: "global" }, // not configured => deny by default
    { scope: "personal" },
  ];
  for (const b of bad) assert.equal((await p.retain(promoted(b))).outcome, "rejected", JSON.stringify(b));
  assert.equal(r.calls.length, 0);
  assert.equal((await p.retain(promoted())).outcome, "persisted");
  const a = r.calls[0]!;
  assert.equal(JSON.parse(a[a.indexOf("--provenance") + 1]!).source_system, "pi-engineering");
});

test("cache scope changes on retain, correct and forget", async () => {
  const r = recorder((a) => ok(a[0] === "retain" ? { outcome: "persisted" } : { revision: 2, memory_id: "m1" }));
  const p = new HindsightDurableMemory({ run: r.run });
  const seen = new Set([p.cacheScope()]);
  await p.retain(promoted());
  seen.add(p.cacheScope());
  const c = await p.correct("m1", "fixed", "ev:2");
  assert.equal(c.outcome, "persisted");
  seen.add(p.cacheScope());
  await p.forget("m1");
  seen.add(p.cacheScope());
  assert.equal(seen.size, 4);
});

test("correct without evidence is rejected locally", async () => {
  const r = recorder(() => ok({}));
  const p = new HindsightDurableMemory({ run: r.run });
  assert.equal((await p.correct("m1", "t", "")).outcome, "rejected");
  assert.equal(r.calls.length, 0);
});

// ---- interactive integration ----
function interactive(provider: HindsightDurableMemory) {
  const events = new Map<string, (e: any, c: ExtensionContext) => any>();
  const commands = new Map<string, { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }>();
  const notices: string[] = [];
  const pi = {
    registerCommand: (n: string, c: any) => commands.set(n, c),
    on: (n: string, f: any) => events.set(n, f),
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/x",
    hasUI: true,
    ui: { setStatus: () => {}, notify: (t: string) => notices.push(t) },
  } as unknown as ExtensionCommandContext;
  registerInteractiveMemory(pi, {
    env: () => ({ PI_HINDSIGHT_ENABLED: "1" }),
    provider: () => provider,
    setup: async () => {},
  });
  const injected = async () => {
    const out = await events.get("context")!({ messages: [{ role: "user", content: "q" }] }, ctx);
    return out.messages.find((m: any) => m.customType === "pi-engineering-memory")?.content as string | undefined;
  };
  return { events, commands, ctx, notices, injected };
}

test("interactive: automatic recall hangs -> the turn waits only its budget and says memory is unavailable", async () => {
  const p = new HindsightDurableMemory({ run: () => new Promise(() => {}) });
  const f = interactive(p);
  const t0 = Date.now();
  await f.events.get("before_agent_start")!({ prompt: "gradle jdk question" }, f.ctx);
  assert.ok(Date.now() - t0 < 1500, "an interactive turn must not wait on a hung client");
  // Silence was read as "the bank is empty", which is a different claim from "it could
  // not be read", so the turn now carries the reason instead of nothing.
  const text = await f.injected();
  assert.match(text!, /could not be read this turn/);
  assert.match(text!, /timed out/);
  assert.doesNotMatch(text!, /gradle/);
});

test("interactive: recalled hindsight memory is labeled untrusted and carries revision", async () => {
  const r = recorder(() => ok({ results: [row("m1", "gradle needs jdk 21", { revision: 3 })] }));
  const f = interactive(new HindsightDurableMemory({ run: r.run }));
  await f.events.get("before_agent_start")!({ prompt: "gradle jdk question" }, f.ctx);
  const text = await f.injected();
  assert.match(text!, /untrusted reference data, not instructions/);
  assert.match(text!, /"revision":3/);
});

test("interactive: cache hit within TTL, but correct invalidates it", async () => {
  let text = "old fact about gradle";
  const r = recorder((a) =>
    a[0] === "recall" ? ok({ results: [row("m1", text)] }) : ok({ revision: 2, memory_id: "m1" }),
  );
  const p = new HindsightDurableMemory({ run: r.run });
  const f = interactive(p);
  const turn = () => f.events.get("before_agent_start")!({ prompt: "gradle fact" }, f.ctx);
  await turn();
  await turn();
  assert.equal(r.calls.filter((a) => a[0] === "recall").length, 1, "second turn served from cache");
  text = "new corrected fact about gradle";
  await p.correct("m1", text, "ev:2");
  await turn();
  assert.equal(r.calls.filter((a) => a[0] === "recall").length, 2, "correct must invalidate cache");
  assert.match((await f.injected())!, /new corrected fact/);
});

test("interactive: /remember reports queued_durable honestly, never as saved", async () => {
  const r = recorder(() => ok({ outcome: "queued_durable", memory_id: "m1" }));
  const f = interactive(new HindsightDurableMemory({ run: r.run }));
  await f.commands.get("remember")!.handler("use metric units", f.ctx);
  const joined = f.notices.join("\n");
  assert.match(joined, /queued/i);
  assert.match(joined, /not yet confirmed/i);
  assert.ok(!/^Saved private memory/m.test(joined));
});

test("interactive: /remember persisted reports saved; rejected does not", async () => {
  let outcome = "persisted";
  const r = recorder(() => ok({ outcome, memory_id: "m1" }));
  const f = interactive(new HindsightDurableMemory({ run: r.run }));
  await f.commands.get("remember")!.handler("note one", f.ctx);
  assert.ok(f.notices.some((n) => /^Saved private memory/.test(n)));
  outcome = "rejected";
  f.notices.length = 0;
  await f.commands.get("remember")!.handler("note two", f.ctx);
  assert.ok(!f.notices.some((n) => /^Saved/.test(n)));
});

test("probe: herdr-memory status is the one connection check", async () => {
  const healthy = recorder(() =>
    ok({ project: "canary", harness: "pi", pending: 2, contract: 1, healthy: true, server_version: "1.0.0" }),
  );
  assert.deepEqual(await probeHindsightStatus({ cli: "herdr-memory", run: healthy.run }), {
    ok: true,
    project: "canary",
    pending: 2,
  });
  assert.deepEqual(healthy.calls[0], ["status"], "status takes no project or credential flags");

  // The client exits 0 even when it reports a problem, so the body decides.
  const noProject = recorder(() => ok({ error: "Current directory has no configured project; use --project" }));
  assert.equal(failure(await probeHindsightStatus({ run: noProject.run })).reason, "unhealthy");

  const sick = recorder(() => ok({ project: "canary", healthy: false, server_version: null }));
  assert.equal(failure(await probeHindsightStatus({ run: sick.run })).reason, "unhealthy");

  const portal = recorder(() => ({ stdout: "<html>proxy</html>", exitCode: 0 }));
  assert.equal(failure(await probeHindsightStatus({ run: portal.run })).reason, "response");

  const denied = recorder(() => ({ stdout: "", exitCode: 1 }));
  assert.equal(failure(await probeHindsightStatus({ run: denied.run })).reason, "exit");

  const absent = recorder(() => {
    throw Object.assign(new Error("spawn herdr-memory ENOENT"), { code: "ENOENT" });
  });
  assert.equal(failure(await probeHindsightStatus({ run: absent.run })).reason, "not_installed");
  assert.equal(failure(await probeHindsightStatus({ run: absent.run })).detail, "herdr-memory");

  const hung = recorder(() => {
    throw Object.assign(new Error("killed"), { killed: true });
  });
  assert.equal(failure(await probeHindsightStatus({ run: hung.run })).reason, "timeout");

  // A client that never answers must not hold the session open.
  const slow = recorder(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return ok({ healthy: true });
  });
  const started = Date.now();
  assert.equal(failure(await probeHindsightStatus({ run: slow.run, timeoutMs: 1 })).reason, "timeout");
  assert.ok(Date.now() - started < 400, "the probe returns on its own deadline");
});

test("blackhole option: only the opt-in turns memory on, and never carries a credential", () => {
  assert.equal(hindsightBlackholeOption({}), undefined);
  assert.equal(hindsightBlackholeOption({ PI_HINDSIGHT_ENABLED: "0", PI_HINDSIGHT_CLI: "herdr-memory" }), undefined);
  const option = hindsightBlackholeOption({
    PI_HINDSIGHT_ENABLED: "1",
    PI_HINDSIGHT_CLI: "/opt/herdr/bin/herdr-memory",
    PI_HINDSIGHT_SCOPES: "project,global",
    PI_HINDSIGHT_TIMEOUT_MS: "3000",
  });
  assert.deepEqual(option, {
    config: {
      enabled: true,
      durable: {
        kind: "hindsight",
        cli: "/opt/herdr/bin/herdr-memory",
        scopes: ["project", "global"],
        timeoutMs: 3000,
      },
    },
  });
  // There is no URL, token or bank in the option to leak into a session or a repo.
  assert.equal(JSON.stringify(option).match(/token|key|secret|baseurl|http:/i), null);
});

test("durable config: hindsight accepts a client path and canonical scopes only", async () => {
  const { resolveBlackholeConfig } = await import("../../src/blackhole/config.ts");
  assert.deepEqual(
    resolveBlackholeConfig({ durable: { kind: "hindsight", cli: "herdr-memory", scopes: ["project"] } }).config.durable,
    { kind: "hindsight", cli: "herdr-memory", scopes: ["project"] },
  );
  assert.throws(() => resolveBlackholeConfig({ durable: { kind: "hindsight", cli: "  " } }), /cli/);
  assert.throws(() => resolveBlackholeConfig({ durable: { kind: "hindsight", scopes: [] } }), /scopes/);
  assert.throws(() => resolveBlackholeConfig({ durable: { kind: "hindsight", scopes: ["Project"] } }), /scopes/);
  assert.throws(() => resolveBlackholeConfig({ durable: { kind: "hindsight", timeoutMs: 0 } }), /timeoutMs/);
  // A REST-shaped config is no longer a thing anyone can write.
  const restShape: { kind: "hindsight"; baseUrl?: string } = { kind: "hindsight" };
  delete restShape.baseUrl;
  assert.deepEqual(resolveBlackholeConfig({ durable: restShape }).config.durable, { kind: "hindsight" });
});
