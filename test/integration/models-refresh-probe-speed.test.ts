/**
 * `/model-refresh` probe speed against a real local HTTP gateway: bounded
 * parallelism, a short deadline, and no retry after a timeout. A timeout is an
 * `inconclusive` verdict (the model is kept), so a retry only doubles the cost.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_PROBE_CONCURRENCY,
  DEFAULT_PROBE_TIMEOUT_MS,
  type RefreshProgress,
  refreshProviderModels,
} from "../../src/models/refresh.ts";

process.env.PI_MODEL_REFRESH_CONCRETE = "1";

interface Behavior {
  /** ms before answering; `never` holds the request open. */
  delayMs?: number;
  never?: boolean;
  /** Reject the full probe (one carrying `temperature`) with this status. */
  status?: number;
  /** Hold the minimal (no temperature) retry open. */
  retryHangs?: boolean;
}

async function gateway(behaviors: Record<string, Behavior>, configured: string[] = []) {
  const requests: Array<{ model: string; hasTemperature: boolean }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const load = { inFlight: 0, maxInFlight: 0 };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: Object.keys(behaviors).map((id) => ({ id, ctx_per_request: 131072 })) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; temperature?: number };
    requests.push({ model: body.model, hasTemperature: body.temperature !== undefined });
    load.inFlight += 1;
    load.maxInFlight = Math.max(load.maxInFlight, load.inFlight);
    res.on("close", () => {
      load.inFlight -= 1;
    });
    const behavior = behaviors[body.model] ?? {};
    if (behavior.never || (behavior.retryHangs && body.temperature === undefined)) return;
    const respond = () => {
      const fail = behavior.status !== undefined && body.temperature !== undefined;
      res.statusCode = fail ? behavior.status! : 200;
      res.end(JSON.stringify(fail ? { error: { code: "bad" } } : { choices: [{ message: { content: "OK" } }] }));
    };
    const timer = setTimeout(() => {
      timers.delete(timer);
      respond();
    }, behavior.delayMs ?? 0);
    timers.add(timer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const dir = mkdtempSync(join(tmpdir(), "refresh-speed-"));
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        p: {
          baseUrl,
          api: "openai-completions",
          apiKey: "k",
          models: configured.map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            contextWindow: 100000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
        },
      },
    }),
  );
  return {
    modelsPath,
    requests,
    load,
    configuredIds: () =>
      (JSON.parse(readFileSync(modelsPath, "utf8")).providers.p.models as Array<{ id: string }>).map((m) => m.id),
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("probe defaults are a 20 s deadline and 4 probes in flight", () => {
  assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 20_000);
  assert.equal(DEFAULT_PROBE_CONCURRENCY, 4);
});

test("8 models answering in 300 ms finish in about two waves, not serially", async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `m${i}`);
  const g = await gateway(Object.fromEntries(ids.map((id) => [id, { delayMs: 300 }])));
  try {
    const started = Date.now();
    const result = await refreshProviderModels({ modelsPath: g.modelsPath, providerId: "p", probeModels: true });
    const elapsed = Date.now() - started;
    assert.equal(result.gateway.length, 8);
    assert.ok(elapsed >= 580, `two waves of 300 ms, took ${elapsed} ms`);
    assert.ok(elapsed < 1500, `serial would be 2400 ms, took ${elapsed} ms`);
  } finally {
    await g.close();
  }
});

test("a model that never answers is abandoned at the deadline, kept, and probed exactly once", async () => {
  const g = await gateway({ ok: {}, hung: { never: true }, ok2: {}, ok3: {}, ok4: {} }, ["hung"]);
  try {
    const result = await refreshProviderModels({
      modelsPath: g.modelsPath,
      providerId: "p",
      probeModels: true,
      probeTimeoutMs: 400,
    });
    assert.equal(g.requests.filter((r) => r.model === "hung").length, 1, "no retry after a timeout");
    assert.ok(g.configuredIds().includes("hung"), "an inconclusive model is never pruned");
    assert.ok(result.plan.next.some((m) => m.id === "hung"));
    assert.match(result.lines.join("\n"), /inconclusive: hung.*probe timed out/);
  } finally {
    await g.close();
  }
});

test("a timed-out model stays configured with --prune and parallel probes", async () => {
  const g = await gateway({ ok: {}, ok2: {}, hung: { never: true }, slow: { delayMs: 100 } }, ["hung", "ok"]);
  try {
    await refreshProviderModels({
      modelsPath: g.modelsPath,
      providerId: "p",
      probeModels: true,
      pruneMissing: true,
      probeConcurrency: 3,
      probeTimeoutMs: 300,
    });
    const ids = g.configuredIds();
    assert.ok(ids.includes("hung"), "timeout never prunes");
    assert.ok(ids.includes("ok"));
  } finally {
    await g.close();
  }
});

test("a capacity-refused (503) configured model is kept under parallel probes", async () => {
  const g = await gateway({ ok: {}, busy: { status: 503 } }, ["busy"]);
  try {
    await refreshProviderModels({
      modelsPath: g.modelsPath,
      providerId: "p",
      probeModels: true,
      pruneMissing: true,
      probeConcurrency: 4,
    });
    assert.ok(g.configuredIds().includes("busy"));
  } finally {
    await g.close();
  }
});

test("a 400-rejected model still gets its minimal-parameter retry", async () => {
  const g = await gateway({ ok: {}, picky: { status: 400 } });
  try {
    const result = await refreshProviderModels({ modelsPath: g.modelsPath, providerId: "p", probeModels: true });
    const picky = g.requests.filter((r) => r.model === "picky");
    assert.equal(picky.length, 2);
    assert.deepEqual(
      picky.map((r) => r.hasTemperature),
      [true, false],
    );
    assert.ok(result.gateway.some((m) => m.id === "picky"));
  } finally {
    await g.close();
  }
});

test("progress reaches total exactly once with 4 probes in flight, and attempt 2 only appears on a real retry", async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `m${i}`);
  const g = await gateway({ ...Object.fromEntries(ids.map((id) => [id, { delayMs: 50 }])), picky: { status: 400 } });
  const events: RefreshProgress[] = [];
  try {
    await refreshProviderModels({
      modelsPath: g.modelsPath,
      providerId: "p",
      probeModels: true,
      onProgress: (event) => events.push(event),
    });
    const total = ids.length + 1;
    const completes = events.filter((e) => e.phase === "complete");
    assert.equal(completes.length, 1);
    assert.equal(completes[0]!.completed, total);
    assert.equal(events.filter((e) => e.completed === total).length, 1, "total is reached once");
    const counts = events.map((e) => e.completed);
    assert.deepEqual(
      counts,
      [...counts].sort((a, b) => a - b),
      "completed never goes backwards",
    );
    assert.ok(
      events.some((e) => e.phase === "probing" && (e.inFlight ?? 0) > 1),
      "progress reports concurrent probes",
    );
    const attempt2 = events.filter((e) => e.attempt === 2);
    assert.ok(
      attempt2.every((e) => e.modelId === "picky"),
      "attempt 2 only for the 400 retry",
    );
    assert.equal(g.requests.filter((r) => r.model === "picky").length, 2);
  } finally {
    await g.close();
  }
});

test("a timeout never produces an attempt 2 progress event", async () => {
  const g = await gateway({ hung: { never: true } }, ["hung"]);
  const events: RefreshProgress[] = [];
  try {
    await refreshProviderModels({
      modelsPath: g.modelsPath,
      providerId: "p",
      probeModels: true,
      probeTimeoutMs: 200,
      onProgress: (event) => events.push(event),
    });
    assert.ok(events.some((e) => e.attempt === 1));
    assert.ok(events.every((e) => e.attempt !== 2));
  } finally {
    await g.close();
  }
});

test("default concurrency really overlaps 4 probes; probeConcurrency 1 never overlaps", async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `m${i}`);
  const g = await gateway(Object.fromEntries(ids.map((id) => [id, { delayMs: 150 }])));
  const h = await gateway(Object.fromEntries(ids.slice(0, 3).map((id) => [id, { delayMs: 50 }])));
  try {
    await refreshProviderModels({ modelsPath: g.modelsPath, providerId: "p", probeModels: true });
    assert.equal(g.load.maxInFlight, DEFAULT_PROBE_CONCURRENCY);
    await refreshProviderModels({ modelsPath: h.modelsPath, providerId: "p", probeModels: true, probeConcurrency: 1 });
    assert.equal(h.load.maxInFlight, 1);
  } finally {
    await g.close();
    await h.close();
  }
});

test("when every probe is inconclusive, refresh keeps the configuration and says how to proceed", async () => {
  const g = await gateway({ hung: { never: true }, hung2: { never: true }, fresh: { never: true } }, ["hung", "hung2"]);
  try {
    const before = readFileSync(g.modelsPath, "utf8");
    const result = await refreshProviderModels({
      modelsPath: g.modelsPath,
      providerId: "p",
      probeModels: true,
      pruneMissing: true,
      probeTimeoutMs: 1000,
    });
    const text = result.lines.join("\n");
    assert.match(
      text,
      /no model could be verified within 1s; configuration kept — raise --timeout \(e\.g\. --timeout 120\)/,
    );
    assert.match(text, /fresh: timed out after 1s, not added — rerun with --timeout 120/);
    assert.equal(result.written, false);
    assert.equal(readFileSync(g.modelsPath, "utf8"), before);
  } finally {
    await g.close();
  }
});

test("an unconfigured model that times out gets an explicit line and a summary hint", async () => {
  const g = await gateway({ ok: {}, fresh: { never: true } });
  try {
    const result = await refreshProviderModels({
      modelsPath: g.modelsPath,
      providerId: "p",
      probeModels: true,
      probeTimeoutMs: 300,
    });
    const text = result.lines.join("\n");
    assert.match(text, /fresh: timed out after 0\.3s, not added — rerun with --timeout 120/);
    assert.match(text, /1 new model\(s\) timed out and were not added/);
    assert.ok(!g.configuredIds().includes("fresh"));
  } finally {
    await g.close();
  }
});

test("finished events keep the displayed probe: oldest in flight, with attempt, and elapsed never goes backwards", async () => {
  const g = await gateway({ "a-slow": { delayMs: 900 }, a: { delayMs: 50 }, b: { delayMs: 50 }, c: { delayMs: 50 } });
  const events: RefreshProgress[] = [];
  try {
    await refreshProviderModels({
      modelsPath: g.modelsPath,
      providerId: "p",
      probeModels: true,
      onProgress: (event) => events.push(event),
    });
    const during = events.filter((e) => e.phase === "probing" && e.completed > 0 && e.completed < 4);
    assert.ok(during.length > 0);
    for (const event of during) {
      assert.equal(event.modelId, "a-slow", "finished model must not replace the displayed probe");
      assert.equal(event.attempt, 1);
      assert.ok((event.inFlight ?? 0) >= 1);
    }
    const slow = events.filter((e) => e.modelId === "a-slow" && e.attempt !== undefined).map((e) => e.elapsedMs);
    assert.deepEqual(
      slow,
      [...slow].sort((x, y) => x - y),
    );
  } finally {
    await g.close();
  }
});

test("a 400 retry is bounded by the remaining part of the original deadline", async () => {
  // Full probe is rejected after 700 ms; the retry would hang. With a 1 s
  // deadline the retry may only wait about 300 ms more.
  const g = await gateway({ picky: { status: 400, delayMs: 700, retryHangs: true } });
  try {
    const started = Date.now();
    await refreshProviderModels({
      modelsPath: g.modelsPath,
      providerId: "p",
      probeModels: true,
      probeTimeoutMs: 1000,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000 + 600, `retry must share the deadline, took ${elapsed} ms`);
  } finally {
    await g.close();
  }
});
