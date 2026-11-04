import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type MemorySetupOptions,
  ensureMemorySetup,
  memorySetupRevision,
  resolveMemoryEnvironment,
} from "../../src/blackhole/connectionSetup.ts";
import type { HindsightProbe } from "../../src/blackhole/hindsight.ts";

/**
 * Setup asks the client one question — `herdr-memory status` — so the fixture
 * injects the answer instead of a service. Nothing here can hold a credential:
 * the client owns its own profile, and asserting that no file or notice contains a
 * secret is the point of several of these tests.
 */
function fixture(t: test.TestContext, options: { status?: HindsightProbe; answers?: string[] } = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), "memory setup "));
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));
  const notices: string[] = [];
  const prompts: string[] = [];
  const probes: Array<{ cli?: string }> = [];
  const answers = [...(options.answers ?? [])];
  let status: HindsightProbe = options.status ?? { ok: true, project: "canary", pending: 0 };
  let releaseProbe: (() => void) | undefined;
  let holdFirstProbe = false;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      select: async (title: string) => {
        prompts.push(title);
        return answers.shift();
      },
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionContext;
  const setup: MemorySetupOptions = {
    profileDir,
    env: { PI_HINDSIGHT_ENABLED: "1", PI_HINDSIGHT_CLI: "/opt/herdr/herdr-memory" },
    revision: "rev-1",
    probe: async (probeOptions) => {
      probes.push(probeOptions);
      if (holdFirstProbe)
        await new Promise<void>((resolve) => {
          releaseProbe = resolve;
        });
      return status;
    },
  };
  return {
    ctx,
    setup,
    notices,
    prompts,
    probes,
    profileDir,
    answers,
    setStatus: (next: HindsightProbe) => {
      status = next;
    },
    /** Make the next probe wait until release() is called. */
    hold: () => {
      holdFirstProbe = true;
    },
    release: () => releaseProbe?.(),
    state: () => JSON.parse(readFileSync(join(profileDir, "engineering-memory", "connection.json"), "utf8")),
  };
}

test("a working client is confirmed once per revision and disclosed to the operator", async (t) => {
  const f = fixture(t);
  assert.equal(await ensureMemorySetup(f.ctx, f.setup), "configured");
  assert.deepEqual(f.probes, [{ cli: "/opt/herdr/herdr-memory" }], "status is the only connection check");
  assert.equal(f.prompts.length, 0, "a working connection is not a question");
  assert.match(f.notices.join(" "), /untrusted/);
  const file = join(f.profileDir, "engineering-memory", "connection.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.profileDir, "engineering-memory")).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(f.state()).sort(), [
    "client",
    "lastAskedRevision",
    "lastConfirmedRevision",
    "updatedAt",
  ]);
  assert.equal(f.state().lastConfirmedRevision, "rev-1");
  assert.equal(f.state().client, "/opt/herdr/herdr-memory");

  // Next session on the same revision: quiet, no re-confirmation.
  const notices = f.notices.length;
  await ensureMemorySetup(f.ctx, f.setup);
  assert.equal(f.notices.length, notices);

  // A packaged update records the new revision without re-asking: a dialog the
  // operator can only dismiss teaches them to dismiss dialogs.
  await ensureMemorySetup(f.ctx, { ...f.setup, revision: "rev-2" });
  assert.equal(f.state().lastConfirmedRevision, "rev-2");
  assert.equal(f.prompts.length, 0);

  // An explicit /memory setup on a working client answers instead of asking: there
  // is no endpoint, bank, or token left to collect.
  await ensureMemorySetup(f.ctx, { ...f.setup, force: true });
  assert.equal(f.prompts.length, 0, "a working connection is not a question");
  assert.match(f.notices.at(-1)!, /already set up/);
  assert.match(f.notices.at(-1)!, /project canary/);
  assert.match(f.notices.at(-1)!, /herdr-memory/);
});

test("an unusable client explains the reported reason and never collects a secret", async (t) => {
  for (const scenario of [
    { status: { ok: false, reason: "not_installed", detail: "herdr-memory" } as HindsightProbe, want: /not installed/ },
    { status: { ok: false, reason: "unhealthy" } as HindsightProbe, want: /unhealthy/ },
    { status: { ok: false, reason: "exit" } as HindsightProbe, want: /missing or revoked/ },
    { status: { ok: false, reason: "timeout" } as HindsightProbe, want: /did not answer in time/ },
    { status: { ok: false, reason: "response" } as HindsightProbe, want: /readable status/ },
  ]) {
    const f = fixture(t, { status: scenario.status, answers: ["Set up now"] });
    assert.equal(await ensureMemorySetup(f.ctx, f.setup), "unconfigured");
    assert.match(f.notices.join(" "), scenario.want);
    assert.match(f.notices.join(" "), /herdr-memory doctor --json/);
    assert.match(f.notices.join(" "), /Never put a key/);
    assert.equal(f.prompts.length, 1, "the operator is asked once");
    assert.equal(f.state().lastConfirmedRevision, "", "an unusable connection is never marked confirmed");
    assert.equal(f.state().client, "");
    assert.deepEqual(readdirSync(f.profileDir), ["engineering-memory"]);
    assert.doesNotMatch(
      readFileSync(join(f.profileDir, "engineering-memory", "connection.json"), "utf8"),
      /token|secret|key|http/i,
    );
  }
});

test("later leaves no state and is asked again next session", async (t) => {
  const f = fixture(t, { status: { ok: false, reason: "exit" }, answers: ["Later"] });
  assert.equal(await ensureMemorySetup(f.ctx, f.setup), "unconfigured");
  assert.deepEqual(readdirSync(f.profileDir), [], "nothing is written when the operator defers");
  assert.equal(f.notices.length, 0);
});

test("a declined question does not repeat every session", async (t) => {
  const f = fixture(t, { status: { ok: false, reason: "exit" }, answers: ["Set up now"] });
  await ensureMemorySetup(f.ctx, f.setup);
  const prompts = f.prompts.length;
  await ensureMemorySetup(f.ctx, f.setup);
  assert.equal(f.prompts.length, prompts, "the same broken client is not re-asked on the same revision");
  await ensureMemorySetup(f.ctx, { ...f.setup, revision: "rev-3" });
  assert.equal(f.prompts.length, prompts + 1, "a packaged update asks once again");
});

for (const scenario of ["headless", "rpc"]) {
  test(`${scenario} setup never asks questions and still states the reason`, async (t) => {
    const f = fixture(t, { status: { ok: false, reason: "exit" } });
    if (scenario === "headless") f.ctx.hasUI = false;
    else (f.ctx as { mode: string }).mode = "rpc";
    assert.equal(await ensureMemorySetup(f.ctx, f.setup), "headless");
    assert.equal(f.prompts.length, 0);
    assert.match(f.notices.join(" "), /terminal/);
    assert.match(f.notices.join(" "), /herdr-memory doctor --json/);
  });
}

test("headless setup with a working client stays silent", async (t) => {
  const f = fixture(t);
  f.ctx.hasUI = false;
  assert.equal(await ensureMemorySetup(f.ctx, f.setup), "configured");
  assert.equal(f.notices.length, 0, "a worker is not interrupted by a memory notice");
  assert.equal(f.state().lastConfirmedRevision, "rev-1");
});

test("disabled memory does not probe, prompt, or write", async (t) => {
  const f = fixture(t);
  assert.equal(await ensureMemorySetup(f.ctx, { ...f.setup, env: { PI_HINDSIGHT_ENABLED: "0" } }), "disabled");
  assert.equal(f.probes.length, 0);
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(readdirSync(f.profileDir), []);
});

test("a connection saved by another session during the probe wins", async (t) => {
  const f = fixture(t);
  f.hold();
  const stale = ensureMemorySetup(f.ctx, f.setup);
  while (f.probes.length === 0) await new Promise((resolve) => setImmediate(resolve));
  // Another session confirms a connection while this probe is in flight.
  mkdirSync(join(f.profileDir, "engineering-memory"), { mode: 0o700 });
  writeFileSync(
    join(f.profileDir, "engineering-memory", "connection.json"),
    JSON.stringify({
      lastConfirmedRevision: "rev-other",
      lastAskedRevision: "rev-other",
      client: "/opt/herdr/herdr-memory",
      updatedAt: "2026-11-09T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  f.release();
  assert.equal(await stale, "configured");
  assert.equal(f.state().lastConfirmedRevision, "rev-other", "the newer answer is preserved");
  assert.match(f.notices.join(" "), /changed during setup/i);
});

test("revision is stable across sessions and changes when packaged source changes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "memory-revision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileDir = join(root, "pi-engineering");
  writeFileSync(join(root, "package.json"), '{"version":"1.0.0"}');
  const before = memorySetupRevision(profileDir);
  assert.equal(memorySetupRevision(profileDir), before, "the same source is the same revision");
  writeFileSync(join(root, "package.json"), '{"version":"1.0.1"}');
  assert.notEqual(memorySetupRevision(profileDir), before, "an update is a new revision");
});

test("resolveMemoryEnvironment passes the opt-in through and carries no credential", () => {
  const env = resolveMemoryEnvironment({
    PI_HINDSIGHT_ENABLED: "1",
    PI_HINDSIGHT_CLI: "/opt/herdr/herdr-memory",
    PI_HINDSIGHT_SCOPES: "project",
    PI_HINDSIGHT_TIMEOUT_MS: "4000",
    SOME_OTHER_VAR: "keep",
  });
  assert.deepEqual(env, {
    PI_HINDSIGHT_ENABLED: "1",
    PI_HINDSIGHT_CLI: "/opt/herdr/herdr-memory",
    PI_HINDSIGHT_SCOPES: "project",
    PI_HINDSIGHT_TIMEOUT_MS: "4000",
    SOME_OTHER_VAR: "keep",
  });
  // Nothing to leak: no URL, bank, or key survives in the session environment.
  assert.equal(JSON.stringify(env).match(/token|baseurl|bank|secret/i), null);
});
