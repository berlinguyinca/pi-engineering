import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../../extensions/index.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

test("engineering commands use changed profile host and rotated key rather than cached credentials", async () => {
  const fixture = await makeFixtureRepo();
  const profile = join(fixture.root, "profile");
  const key = join(profile, "key");
  const oldEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  try {
    await mkdir(join(profile, "engineering-memory"), { recursive: true });
    await writeFile(key, "first-key");
    const settings = join(profile, "engineering-memory", "connection.json");
    await writeFile(
      settings,
      JSON.stringify({ baseUrl: "https://first.example", tokenFile: key, lastConfirmedRevision: "test" }),
    );
    process.env.PI_CODING_AGENT_DIR = profile;
    process.env.PI_OPENVIKING_ENABLED = "1";
    globalThis.fetch = async (input, options) => {
      seen.push({ url: String(input), auth: (options?.headers as Record<string, string> | undefined)?.authorization });
      return new Response("[]");
    };
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
    extension({
      registerCommand: (name: string, c: any) => commands.set(name, c),
      registerTool: () => {},
      on: () => {},
    } as unknown as ExtensionAPI);
    const ctx = { cwd: fixture.root, model: undefined, ui: { notify: () => {} } } as unknown as ExtensionCommandContext;
    await commands.get("blackhole")!.handler("--dashboard", ctx);
    assert.equal(seen.at(-1)!.auth, "Bearer first-key");
    await writeFile(key, "rotated-key");
    await writeFile(
      settings,
      JSON.stringify({ baseUrl: "https://second.example", tokenFile: key, lastConfirmedRevision: "test" }),
    );
    await commands.get("blackhole")!.handler("--dashboard", ctx);
    assert.equal(seen.at(-1)!.url, "https://second.example/memory");
    assert.equal(seen.at(-1)!.auth, "Bearer rotated-key");
  } finally {
    globalThis.fetch = oldFetch;
    for (const name of Object.keys(process.env)) if (!(name in oldEnv)) delete process.env[name];
    Object.assign(process.env, oldEnv);
    await fixture.cleanup();
  }
});
