import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type RefreshProgress, refreshConfiguredProviders, refreshProviderModels } from "../../src/models/refresh.ts";

async function fixture(
  delayMs: number,
  rows: Record<string, unknown>[] = [{ id: "flash-next", ctx_per_request: 131072 }],
  statusForModel: Record<string, number> = {},
  onProbe?: (model: string, respond: () => void) => void,
) {
  const probes: Array<{ model: string; max_tokens: number }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: rows }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const probe = JSON.parse(Buffer.concat(chunks).toString());
    probes.push(probe);
    const respond = () => {
      res.statusCode = statusForModel[probe.model] ?? 200;
      res.end(
        JSON.stringify(
          res.statusCode === 200
            ? { choices: [{ message: { content: "OK" } }] }
            : { error: { code: "capacity_unavailable" } },
        ),
      );
    };
    if (onProbe) onProbe(probe.model, respond);
    else {
      const timer = setTimeout(() => {
        timers.delete(timer);
        respond();
      }, delayMs);
      timers.add(timer);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const dir = mkdtempSync(join(tmpdir(), "refresh-progress-"));
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        metabolomics: { baseUrl, models: [] },
        development: { baseUrl, models: [] },
      },
    }),
  );
  return {
    modelsPath,
    probes,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("refresh: a newly advertised model answering after 15 seconds is discovered with the default deadline", async () => {
  const f = await fixture(15_200);
  try {
    const result = await refreshProviderModels({
      modelsPath: f.modelsPath,
      providerId: "metabolomics",
      probeModels: true,
    });
    assert.deepEqual(
      result.plan.next.map((m) => m.id),
      ["flash-next"],
    );
    assert.equal(f.probes.length, 1, "a slow healthy completion should not need a retry");
  } finally {
    await f.close();
  }
});

test(
  "refresh: progress names each provider and model, ticks during waits, and counts only completed models",
  { timeout: 20_000 },
  async () => {
    const pending = new Map<string, () => void>();
    const heartbeatWhilePending: string[] = [];
    let probeProvider = "";
    const f = await fixture(
      0,
      [
        { id: "flash-next", ctx_per_request: 131072 },
        { id: "qwen", ctx_per_request: 131072 },
      ],
      {},
      (model, respond) => pending.set(`${probeProvider}/${model}`, respond),
    );
    const controller = new AbortController();
    // Missing heartbeats must abort the real pending HTTP request, not hang the
    // test until the normal production probe deadline.
    const deadline = setTimeout(() => controller.abort(new Error("No probing heartbeat observed")), 15_000);
    const progress: RefreshProgress[] = [];
    try {
      await refreshConfiguredProviders({
        modelsPath: f.modelsPath,
        providerIds: ["metabolomics", "development"],
        probeModels: true,
        signal: controller.signal,
        onProgress: (event) => {
          progress.push(event);
          if (event.phase === "listing") probeProvider = event.providerId;
          if (event.phase !== "probing" || event.elapsedMs < 1000 || !event.modelId) return;
          const route = `${event.providerId}/${event.modelId}`;
          const respond = pending.get(route);
          if (!respond) return;
          assert.equal(event.completed, event.modelId === "flash-next" ? 0 : 1);
          assert.equal(event.total, 2);
          heartbeatWhilePending.push(route);
          pending.delete(route);
          // The response is held until a heartbeat has actually been observed
          // while this request is outstanding. A 1s interval is not guaranteed
          // to produce elapsedMs >= 1000 before a separately timed 1.1s reply.
          respond();
        },
      });
      assert.deepEqual(heartbeatWhilePending, [
        "metabolomics/flash-next",
        "metabolomics/qwen",
        "development/flash-next",
        "development/qwen",
      ]);
      assert.equal(pending.size, 0);
      for (const providerId of ["metabolomics", "development"]) {
        const events = progress.filter((event) => event.providerId === providerId);
        assert.equal(events[0]?.phase, "listing");
        const probes = events.filter((event) => event.phase === "probing");
        assert.ok(
          probes.some((event) => event.modelId === "flash-next" && event.completed === 0 && event.elapsedMs >= 1000),
        );
        assert.ok(probes.some((event) => event.modelId === "qwen" && event.completed === 1 && event.total === 2));
        assert.equal(events.at(-1)?.completed, 2);
        assert.equal(events.at(-1)?.phase, "complete");
      }
      const config = JSON.parse(readFileSync(f.modelsPath, "utf8"));
      assert.deepEqual(
        config.providers.metabolomics.models.map((m: { id: string }) => m.id),
        ["flash-next", "qwen"],
      );
      assert.deepEqual(
        config.providers.development.models.map((m: { id: string }) => m.id),
        ["flash-next", "qwen"],
      );
      const count = progress.length;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert.equal(progress.length, count, "heartbeat timers must stop on completion");
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await f.close();
    }
  },
);

test("refresh: cancellation stops the heartbeat and preserves the file", async () => {
  const f = await fixture(60_000);
  const controller = new AbortController();
  const progress: RefreshProgress[] = [];
  const before = readFileSync(f.modelsPath, "utf8");
  try {
    await assert.rejects(
      refreshProviderModels({
        modelsPath: f.modelsPath,
        providerId: "metabolomics",
        probeModels: true,
        signal: controller.signal,
        onProgress: (event) => {
          progress.push(event);
          if (event.elapsedMs >= 1000) controller.abort();
        },
      }),
      /abort/i,
    );
    assert.equal(readFileSync(f.modelsPath, "utf8"), before);
    const count = progress.length;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(progress.length, count);
  } finally {
    controller.abort();
    await f.close();
  }
});

test("refresh: aliases are probed as routes with backing reasoning budgets, and a broken alias is not added", async () => {
  const f = await fixture(
    0,
    [
      { id: "flash-next", x_alias: true, x_backing_model: "reasoning-backend" },
      { id: "broken-alias", x_alias: true, x_backing_model: "reasoning-backend" },
      { id: "reasoning-backend", ctx_per_request: 131072 },
    ],
    { "broken-alias": 503 },
  );
  const events: RefreshProgress[] = [];
  const config = JSON.parse(readFileSync(f.modelsPath, "utf8"));
  config.providers.metabolomics.models = [
    { id: "reasoning-backend", reasoning: true, input: ["text"], maxTokens: 4096 },
  ];
  writeFileSync(f.modelsPath, JSON.stringify(config));
  try {
    const result = await refreshProviderModels({
      modelsPath: f.modelsPath,
      providerId: "metabolomics",
      probeModels: true,
      onProgress: (event) => events.push(event),
    });
    assert.deepEqual(
      f.probes.map((p) => p.model),
      ["broken-alias", "flash-next", "reasoning-backend"],
    );
    assert.ok(
      f.probes.every((p) => p.max_tokens === 256),
      "routes backed by a configured reasoning model get room to answer",
    );
    assert.deepEqual(
      result.plan.next.map((m) => m.id),
      ["flash-next", "reasoning-backend"],
    );
    assert.ok(events.some((event) => event.modelId === "flash-next" && event.backingModel === "reasoning-backend"));
    assert.match(result.lines.join("\n"), /route: flash-next → reasoning-backend/);
    assert.match(result.lines.join("\n"), /inconclusive: broken-alias.*not added/);
  } finally {
    await f.close();
  }
});
