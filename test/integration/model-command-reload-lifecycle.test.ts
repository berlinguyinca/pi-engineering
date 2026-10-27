import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../../extensions/index.ts";

for (const name of ["model-refresh", "refresh-models", "model-sync"]) {
  test(`${name} completes notifications and progress cleanup before reload invalidates its context`, async () => {
    await withCommand(name, false);
  });
}

for (const name of ["model-refresh", "refresh-models", "model-sync"]) {
  test(`${name} reports a rejected reload after saving, without reusing its invalid context`, async () => {
    await withCommand(name, true);
  });
}

async function withCommand(name: string, failReload: boolean): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-command-reload-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.method === "POST"
          ? { choices: [{ message: { content: "OK" } }] }
          : { data: [{ id: "new", ctx_per_request: 16_384 }] },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { local: { baseUrl, apiKey: "test", models: [] } } }));
    const canonical = join(dir, "canonical.json");
    writeFileSync(canonical, JSON.stringify({ providers: { local: { baseUrl, name: "Updated" } } }));
    writeFileSync(join(dir, "model-sync.json"), JSON.stringify({ source: canonical }));
    process.env.PI_AGENT_DIR = dir;
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
    extension({
      registerCommand: (id: string, command: any) => commands.set(id, command),
      registerTool: () => {},
      on: () => {},
    } as unknown as ExtensionAPI);
    const operations: string[] = [];
    let active = true;
    let staleAccesses = 0;
    const assertActive = () => {
      if (!active) {
        staleAccesses++;
        throw new Error("stale extension context");
      }
    };
    const ctx = {
      model: { provider: "local" },
      modelRegistry: {
        getProviderAuthStatus: () => ({ configured: true }),
        getProviderAuth: async () => ({ auth: { apiKey: "test" } }),
      },
      get ui() {
        assertActive();
        return {
          notify: (text: string) => operations.push(`notice:${text}`),
          setStatus: (_key: string, value: unknown) => operations.push(value === undefined ? "clear-status" : "status"),
          setWidget: (_key: string, value: unknown) => operations.push(value === undefined ? "clear-widget" : "widget"),
        };
      },
      reload: async () => {
        operations.push("reload");
        active = false;
        if (failReload) throw new Error("reload unavailable");
      },
    } as unknown as ExtensionCommandContext;
    const command = commands.get(name);
    assert.ok(command);
    if (failReload) await assert.rejects(() => command.handler("", ctx), /reload unavailable/);
    else await command.handler("", ctx);
    assert.equal(staleAccesses, 0, "reload must be the final use of the context, including error and finally paths");
    assert.equal(operations.at(-1), "reload");
    assert.ok(operations.includes("clear-status"));
    assert.ok(operations.includes("clear-widget"));
    assert.ok(operations.some((operation) => operation.startsWith("notice:")));
    assert.ok(
      JSON.parse(readFileSync(modelsPath, "utf8")).providers.local.models.some((model: any) => model.id === "new"),
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}
