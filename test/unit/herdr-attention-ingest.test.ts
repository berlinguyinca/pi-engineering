/**
 * T16: the attention emitter is configured by the global engineering.yaml `herdr:` block ONLY (operator rule: no
 * environment variables). The retired variables are reported loudly and never used.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  LEGACY_HERDR_ENV,
  legacyHerdrEnvSet,
  resetLegacyHerdrEnvWarning,
  resolveAttentionIngest,
} from "../../src/runtime/herdr/attentionIngest.ts";
import { type TelemetryNotice, setTelemetrySink } from "../../src/telemetry/sink.ts";

const FAKE_KEY = ["attn", "test", "value", "0001"].join("-");

async function agentDir(yaml?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-attn-"));
  if (yaml !== undefined) {
    const keyFile = join(dir, "key");
    await writeFile(keyFile, `${FAKE_KEY}\n`);
    await chmod(keyFile, 0o600);
    await writeFile(join(dir, "engineering.yaml"), yaml.replaceAll("$KEY", keyFile));
  }
  return dir;
}

function recorder() {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

afterEach(() => resetLegacyHerdrEnvWarning());

describe("attention ingest (YAML only)", () => {
  it("is null with no herdr block, even when the retired environment variables are set", async () => {
    const dir = await agentDir();
    const lines: string[] = [];
    const ingest = await resolveAttentionIngest(
      { HERDR_INGEST_URL: "https://herdr.example.org", HERDR_INGEST_API_KEY: FAKE_KEY },
      dir,
      { warn: (l) => lines.push(l) },
    );
    assert.equal(ingest, null, "no silent fallback to the environment");
    assert.equal(lines.length, 1, "one loud deprecation error");
    assert.match(lines[0] ?? "", /ERROR/);
    assert.match(lines[0] ?? "", /HERDR_INGEST_URL, HERDR_INGEST_API_KEY/);
    assert.match(lines[0] ?? "", /engineering\.yaml/);
    assert.ok(!(lines[0] ?? "").includes(FAKE_KEY), "the key value is never printed");
  });

  it("scrubs the retired variables from the environment it was given, and reports through telemetry, not stderr", async () => {
    const dir = await agentDir();
    const env: NodeJS.ProcessEnv = { HERDR_INGEST_API_KEY: FAKE_KEY, HERDR_INGEST_URL: "https://herdr.example.org" };
    const notices: TelemetryNotice[] = [];
    const undo = setTelemetrySink((n) => notices.push(n));
    try {
      await resolveAttentionIngest(env, dir);
    } finally {
      undo();
    }
    assert.deepEqual(env, {}, "nothing downstream (a worker's bash, the verifier, git) inherits the key");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.level, "error");
    assert.equal(notices[0]?.key, "herdr-legacy-env");
  });

  it("warns once per process, and says the variables are ignored when YAML is present", async () => {
    const dir = await agentDir("herdr:\n  url: http://127.0.0.1:9\n  api_key_file: $KEY\n");
    const lines: string[] = [];
    const env = { HERDR_HOST_ID: "bender" };
    const one = await resolveAttentionIngest(env, dir, { warn: (l) => lines.push(l) });
    const two = await resolveAttentionIngest(env, dir, { warn: (l) => lines.push(l) });
    assert.ok(one && two);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /unset the variable/);
  });

  it("uses only the YAML url, key file and instance id", async () => {
    const dir = await agentDir("herdr:\n  url: http://127.0.0.1:9\n  api_key_file: $KEY\n  instance_id: pi-laptop-1\n");
    const { calls, fetch } = recorder();
    const ingest = await resolveAttentionIngest(
      { HERDR_INGEST_URL: "http://127.0.0.1:1/", HERDR_HOST_ID: "other" },
      dir,
      { fetch, warn: () => {} },
    );
    assert.equal(ingest?.url, "http://127.0.0.1:9");
    assert.equal(ingest?.host.hostId, "pi-laptop-1");
    await ingest?.emit("mission", "m1", "mission.started", {});
    assert.equal(calls[0]?.url.startsWith("http://127.0.0.1:9"), true);
    assert.equal(calls[0]?.headers.get("x-api-key"), FAKE_KEY);
  });

  it("is null for an unsafe block (key file readable by others) and stays quiet about env when none is set", async () => {
    const dir = await agentDir("herdr:\n  url: http://127.0.0.1:9\n  api_key_file: $KEY\n");
    await chmod(join(dir, "key"), 0o644);
    const lines: string[] = [];
    assert.equal(await resolveAttentionIngest({}, dir, { warn: (l) => lines.push(l) }), null);
    assert.deepEqual(lines, []);
  });

  it("legacyHerdrEnvSet names exactly the retired variables", () => {
    assert.deepEqual(legacyHerdrEnvSet({}), []);
    assert.deepEqual(legacyHerdrEnvSet({ HERDR_INGEST_URL: "  ", HERDR_HOST_ID: "x" }), ["HERDR_HOST_ID"]);
    assert.deepEqual([...LEGACY_HERDR_ENV], ["HERDR_INGEST_URL", "HERDR_INGEST_API_KEY", "HERDR_HOST_ID"]);
  });
});
