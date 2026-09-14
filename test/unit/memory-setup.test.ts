import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ensureMemorySetup,
  memorySetupRevision,
  resolveMemoryEnvironment,
} from "../../src/blackhole/connectionSetup.ts";

function fixture(t: test.TestContext) {
  const profileDir = mkdtempSync(join(tmpdir(), "viking setup "));
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));
  const notices: string[] = [];
  const prompts: string[] = [];
  const selections: (string | undefined)[] = ["Set up connection"];
  const hosts: (string | undefined)[] = ["https://memory.example.test"];
  let key = "personal-test-key";
  let cancelled = false;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      select: async (title: string) => {
        prompts.push(title);
        return selections.shift();
      },
      input: async (title: string) => {
        prompts.push(title);
        return hosts.shift();
      },
      notify: (message: string) => notices.push(message),
      custom: async (factory: any) => {
        let answer: string | undefined;
        const widget = await factory({ requestRender() {} }, {}, {}, (value: string | undefined) => {
          answer = value;
        });
        widget.handleInput(`\x1b[200~${key}\x1b[201~`);
        for (const width of [1, 10, 80]) {
          const rendered = widget.render(width).join("\n");
          assert.equal(rendered.includes(key), false, "secret must never be rendered");
        }
        widget.handleInput(cancelled ? "\x1b" : "\r");
        widget.dispose?.();
        return answer;
      },
    },
  } as unknown as ExtensionContext;
  const fetchFn = async (_url: any, init: any) => {
    assert.equal(init.headers.authorization, `Bearer ${key}`);
    return new Response("[]", { status: 200 });
  };
  const options = { profileDir, env: {}, revision: "v1", fetch: fetchFn as typeof fetch };
  return {
    ctx,
    options,
    notices,
    prompts,
    selections,
    hosts,
    profileDir,
    setKey: (v: string) => {
      key = v;
    },
    cancel: () => {
      cancelled = true;
    },
  };
}

test("onboarding stores verified connection privately, masks keys, and saved settings beat old shell defaults", async (t) => {
  const f = fixture(t);
  await ensureMemorySetup(f.ctx, f.options);
  const env = resolveMemoryEnvironment(
    { PI_OPENVIKING_TOKEN: "old", PI_OPENVIKING_BASE_URL: "https://old.test" },
    f.options,
  );
  assert.equal(env.PI_OPENVIKING_BASE_URL, "https://memory.example.test");
  assert.equal(env.PI_OPENVIKING_TOKEN, undefined);
  assert.equal(readFileSync(env.PI_OPENVIKING_TOKEN_FILE!, "utf8").trim(), "personal-test-key");
  assert.equal(statSync(env.PI_OPENVIKING_TOKEN_FILE!).mode & 0o777, 0o600);
  const configFile = join(f.profileDir, "engineering-memory", "connection.json");
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(configFile, "utf8").includes("personal-test-key"), false);
  assert.equal(resolveMemoryEnvironment({ PI_OPENVIKING_ENABLED: "false" }, f.options).PI_OPENVIKING_ENABLED, "false");
  const promptCount = f.prompts.length;
  await ensureMemorySetup(f.ctx, f.options);
  assert.equal(f.prompts.length, promptCount, "same update should not prompt again");
  f.selections.push("Keep current connection");
  await ensureMemorySetup(f.ctx, { ...f.options, revision: "v2" });
  assert.ok(f.prompts.length > promptCount, "updated package prompts once");
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).lastConfirmedRevision, "v2");
});

test("keep current reuses external key file and does not rewrite it", async (t) => {
  const f = fixture(t);
  const external = join(f.profileDir, "external key");
  writeFileSync(external, "external-key\n", { mode: 0o640 });
  f.setKey("external-key");
  f.selections.splice(0, 1, "Keep current connection");
  await ensureMemorySetup(f.ctx, {
    ...f.options,
    env: { PI_OPENVIKING_BASE_URL: "https://old.test", PI_OPENVIKING_TOKEN_FILE: external },
  });
  assert.equal(resolveMemoryEnvironment({}, f.options).PI_OPENVIKING_TOKEN_FILE, external);
  assert.equal(statSync(external).mode & 0o777, 0o640);
  assert.equal(readFileSync(external, "utf8"), "external-key\n");
});

for (const scenario of ["headless", "disabled", "later", "cancel-key", "invalid-host", "authentication-fails"]) {
  test(`${scenario} does not persist a connection or leak credentials`, async (t) => {
    const f = fixture(t);
    const opts = { ...f.options };
    if (scenario === "headless") f.ctx.hasUI = false;
    if (scenario === "disabled") opts.env = { PI_OPENVIKING_ENABLED: "0" };
    if (scenario === "later") f.selections.splice(0, 1, "Later");
    if (scenario === "cancel-key") f.cancel();
    if (scenario === "invalid-host") f.hosts.splice(0, 1, "http://insecure.test");
    if (scenario === "authentication-fails")
      opts.fetch = async () => new Response("personal-test-key", { status: 401 });
    await ensureMemorySetup(f.ctx, opts);
    assert.deepEqual(readdirSync(f.profileDir), []);
    assert.equal(f.notices.join(" ").includes("personal-test-key"), false);
  });
}

test("failed replacement keeps the previous working profile and key intact", async (t) => {
  const f = fixture(t);
  await ensureMemorySetup(f.ctx, f.options);
  const before = resolveMemoryEnvironment({}, f.options);
  f.setKey("bad-new-key");
  f.selections.push("Change connection");
  f.hosts.push("https://replacement.test");
  await ensureMemorySetup(f.ctx, {
    ...f.options,
    force: true,
    fetch: async () => new Response("bad-new-key", { status: 403 }),
  });
  assert.deepEqual(resolveMemoryEnvironment({}, f.options), before);
  assert.equal(readFileSync(before.PI_OPENVIKING_TOKEN_FILE!, "utf8").trim(), "personal-test-key");
});

test("revision remains stable across sessions and changes on packaged source updates", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.profileDir, "package.json"), '{"version":"1.0.0"}');
  mkdirSync(join(f.profileDir, "src"));
  const source = join(f.profileDir, "src", "index.ts");
  writeFileSync(source, "export const version = 1;");
  const before = memorySetupRevision(f.profileDir);
  assert.equal(memorySetupRevision(f.profileDir), before);
  writeFileSync(source, "export const version = 2;");
  assert.notEqual(memorySetupRevision(f.profileDir), before);
});

test("successful replacement removes only the previous profile-owned secret", async (t) => {
  const f = fixture(t);
  await ensureMemorySetup(f.ctx, f.options);
  const previous = resolveMemoryEnvironment({}, f.options).PI_OPENVIKING_TOKEN_FILE!;
  f.setKey("new-good-key");
  f.selections.push("Change connection");
  f.hosts.push("https://replacement.test");
  await ensureMemorySetup(f.ctx, { ...f.options, force: true });
  assert.throws(() => readFileSync(previous), { code: "ENOENT" });
  const updated = resolveMemoryEnvironment({}, f.options);
  assert.equal(updated.PI_OPENVIKING_BASE_URL, "https://replacement.test");
  assert.equal(readFileSync(updated.PI_OPENVIKING_TOKEN_FILE!, "utf8").trim(), "new-good-key");
});

test("automatic RPC setup does not ask questions; manual setup explains using a terminal", async (t) => {
  const f = fixture(t);
  f.ctx.mode = "rpc";
  await ensureMemorySetup(f.ctx, f.options);
  assert.equal(f.prompts.length, 0);
  await ensureMemorySetup(f.ctx, { ...f.options, force: true });
  assert.equal(f.prompts.length, 0);
  assert.match(f.notices.join(" "), /interactive terminal/);
});

test("confirmation identifies the current host without exposing URL userinfo or query", async (t) => {
  const f = fixture(t);
  f.selections.splice(0, 1, "Later");
  await ensureMemorySetup(f.ctx, {
    ...f.options,
    env: {
      PI_OPENVIKING_BASE_URL: "https://user:secret@memory.test/path?q=secret",
      PI_OPENVIKING_TOKEN: "personal-test-key",
    },
  });
  assert.match(f.prompts[0]!, /https:\/\/memory.test/);
  assert.equal(f.prompts.join(" ").includes("secret"), false);
});

test("stale setup cannot overwrite a connection saved by another session during validation", async (t) => {
  const f = fixture(t);
  await ensureMemorySetup(f.ctx, f.options);
  f.selections.push("Change connection");
  f.hosts.push("https://stale.test");
  f.setKey("stale-key");
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stale = ensureMemorySetup(f.ctx, {
    ...f.options,
    force: true,
    fetch: async () => {
      started();
      await pending;
      return new Response("[]");
    },
  });
  await waiting;
  f.selections.push("Change connection");
  f.hosts.push("https://fresh.test");
  f.setKey("fresh-key");
  await ensureMemorySetup(f.ctx, { ...f.options, force: true });
  const directory = join(f.profileDir, "engineering-memory");
  const saved = readFileSync(join(directory, "connection.json"), "utf8");
  const files = readdirSync(directory);
  release();
  await stale;
  assert.equal(readFileSync(join(directory, "connection.json"), "utf8"), saved);
  assert.deepEqual(readdirSync(directory), files, "stale setup must not leave an orphan credential");
  assert.equal(resolveMemoryEnvironment({}, f.options).PI_OPENVIKING_BASE_URL, "https://fresh.test");
  assert.match(f.notices.at(-1)!, /changed.*setup.*retry/i);
});

test("external key rotation during validation aborts setup without storing stale credentials", async (t) => {
  const f = fixture(t);
  const external = join(f.profileDir, "external.key");
  writeFileSync(external, "original-key\n", { mode: 0o600 });
  f.selections.splice(0, 1, "Keep current connection");
  await ensureMemorySetup(f.ctx, {
    ...f.options,
    env: { PI_OPENVIKING_BASE_URL: "https://memory.test", PI_OPENVIKING_TOKEN_FILE: external },
    fetch: async () => {
      writeFileSync(external, "rotated-key\n");
      return new Response("[]");
    },
  });
  assert.deepEqual(readdirSync(f.profileDir), ["external.key"]);
  assert.equal(readFileSync(external, "utf8"), "rotated-key\n");
  assert.match(f.notices.at(-1)!, /changed.*setup.*retry/i);
});

test("environment changes during validation abort setup", async (t) => {
  const f = fixture(t);
  const env: NodeJS.ProcessEnv = {};
  await ensureMemorySetup(f.ctx, {
    ...f.options,
    env,
    fetch: async () => {
      env.PI_OPENVIKING_ENABLED = "0";
      return new Response("[]");
    },
  });
  assert.deepEqual(readdirSync(f.profileDir), []);
  assert.match(f.notices.at(-1)!, /changed.*setup.*retry/i);
});
