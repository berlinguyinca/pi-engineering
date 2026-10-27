import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { setSharedAdmissionController, sharedAdmissionController } from "../../src/gateway/config.ts";
import { fetchGatewayModels, observedGatewayCapacity } from "../../src/models/gatewayCatalog.ts";
import { refreshConfiguredProviders, refreshProviderModels } from "../../src/models/refresh.ts";
import { advertisedRequestLimit } from "../../src/request/bodyBudget.ts";

async function gateway(capacity = 32) {
  let requested!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (_req, res) => {
    requested();
    await gate;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-inferweave-max-request-bytes", String(16 * 1024 * 1024));
    res.end(
      JSON.stringify({
        data: [{ id: "new", ctx_per_request: 8192, active_limit: capacity, x_max_request_bytes: 32 * 1024 * 1024 }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestStarted,
    release,
    async close() {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

for (const mode of ["single", "batch"] as const) {
  for (const change of ["edit", "delete", "create"] as const) {
    test(`refresh ${mode}: rejects a concurrent configuration ${change} without overwriting it`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "refresh-conflict-"));
      const path = join(dir, "models.json");
      const host = await gateway();
      const initial = {
        providers: { test: { baseUrl: host.baseUrl, apiKey: "old-placeholder", models: [{ id: "old" }] } },
      };
      if (change !== "create") writeFileSync(path, JSON.stringify(initial), { mode: 0o600 });
      const options = { modelsPath: path, baseUrl: host.baseUrl };
      const flight =
        mode === "single"
          ? refreshProviderModels({ ...options, providerId: "test" })
          : refreshConfiguredProviders({
              modelsPath: path,
              providerIds: ["test"],
              authForProvider: () => ({ baseUrl: host.baseUrl }),
            });
      try {
        await host.requestStarted;
        const concurrent = JSON.stringify({
          providers: {
            ...initial.providers,
            test: { ...initial.providers.test, apiKey: "rotated-placeholder" },
            extra: { baseUrl: "https://example.invalid/v1", models: [] },
          },
        });
        if (change === "delete") rmSync(path);
        else writeFileSync(path, concurrent);
        host.release();

        await assert.rejects(flight, /models\.json changed.*refresh/i);
        assert.equal(existsSync(path), change !== "delete");
        if (change !== "delete") assert.equal(readFileSync(path, "utf8"), concurrent);
        assert.deepEqual(readdirSync(dir), change === "delete" ? [] : ["models.json"]);
      } finally {
        host.release();
        await flight.catch(() => {});
        await host.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test(`refresh ${mode}: a dry run leaves admission capacity unchanged`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "refresh-dry-capacity-"));
    const path = join(dir, "models.json");
    const host = await gateway();
    setSharedAdmissionController(new AdmissionController({ maxConcurrency: 4, reservedSlots: 1 }));
    try {
      writeFileSync(path, JSON.stringify({ providers: { test: { baseUrl: host.baseUrl, models: [] } } }));
      const before = sharedAdmissionController().status();
      host.release();
      const result =
        mode === "single"
          ? await refreshProviderModels({ modelsPath: path, providerId: "test", dryRun: true })
          : await refreshConfiguredProviders({ modelsPath: path, providerIds: ["test"], dryRun: true });
      assert.equal(result.written, false);
      assert.deepEqual(sharedAdmissionController().status(), before);
    } finally {
      setSharedAdmissionController(undefined);
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`refresh ${mode}: a dry run leaves catalogue scheduling observations unchanged`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "refresh-dry-observations-"));
    const path = join(dir, "models.json");
    const host = await gateway();
    const baseline = await gateway(7);
    try {
      baseline.release();
      await fetchGatewayModels({ baseUrl: baseline.baseUrl });
      const capacity = observedGatewayCapacity("new");
      writeFileSync(path, JSON.stringify({ providers: { test: { baseUrl: host.baseUrl, models: [] } } }));
      host.release();
      if (mode === "single") await refreshProviderModels({ modelsPath: path, providerId: "test", dryRun: true });
      else await refreshConfiguredProviders({ modelsPath: path, providerIds: ["test"], dryRun: true });
      assert.equal(observedGatewayCapacity("new"), capacity);
      assert.equal(advertisedRequestLimit(host.baseUrl), undefined);
      assert.equal(advertisedRequestLimit(host.baseUrl, "new"), undefined);
    } finally {
      await host.close();
      await baseline.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
