import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { EngineeringHostExtension, resolveHostConfig } from "../../src/runtime/host/extension.ts";
import { RuntimeHost } from "../../src/runtime/host/host.ts";
import { startPiSession } from "../support/piSession.ts";
import { bag, writeFixtureRuntime } from "../support/runtimeFixtures.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});
let sequence = 0;
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" })
    .toString()
    .trim();
}
interface Provider {
  describe(): Promise<{
    hostCommit: string | null;
    commit: string | null;
    generation: number | null;
    capabilities: string[];
    pending: boolean;
  }>;
  reload(request: { expectedCommit: string; sourceRoot?: string; timeoutMs?: number }): Promise<{
    ok: boolean;
    commit: string | null;
    generation: number | null;
    error?: string;
  }>;
}
function provider(): Provider {
  const found = (globalThis as unknown as Record<symbol, Provider | undefined>)[
    Symbol.for("pi-engineering.host-maintenance.v1")
  ];
  assert.ok(found, "successfully installed Host publishes maintenance provider");
  return found;
}
async function setup(options: { autoReload?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rt-maintenance-"));
  const source = join(root, "source");
  const key = `__maintenance_${process.pid}_${++sequence}`;
  const observed = bag(key);
  writeFixtureRuntime(source, key, { value: "A" });
  git(source, "init", "-q");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "A");
  const original = git(source, "rev-parse", "HEAD");
  const ext = new EngineeringHostExtension({
    installRoot: join(root, "install"),
    packageRoot: source,
    entry: "runtime.ts",
    baseline: true,
    autoUpdateCheck: false,
    autoReload: options.autoReload,
    autoReloadIntervalMs: 60_000,
  });
  const pi = await startPiSession({ factories: [(api: never) => ext.install(api)] });
  cleanups.push(async () => {
    await pi.close();
    rmSync(root, { recursive: true, force: true });
  });
  const commit = (mode: "ok" | "unhealthy" = "ok") => {
    writeFixtureRuntime(source, key, { value: "B", mode });
    git(source, "add", "-A");
    git(source, "commit", "-qm", "B");
    return git(source, "rev-parse", "HEAD");
  };
  return { root, source, key, observed, original, ext, pi, commit };
}

test("maintenance: default safe-point budget is finite, including invalid configuration", () => {
  assert.equal(resolveHostConfig({}).safePointTimeoutMs, 30_000);
  assert.equal(resolveHostConfig({ PI_ENGINEERING_SAFE_POINT_TIMEOUT_MS: "0" }).safePointTimeoutMs, 30_000);
});

test("maintenance: reports actual loaded code and preserves bootstrap identity after activation", async () => {
  const { original, commit, pi, observed } = await setup();
  const control = provider();
  assert.equal((await control.describe()).hostCommit, original);
  assert.deepEqual((await control.describe()).capabilities, ["runtime.describe", "runtime.reload"]);
  const target = commit();
  assert.equal((await control.describe()).commit, original, "disk changes are not loaded changes");
  const result = await control.reload({ expectedCommit: target });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.commit, target);
  assert.equal(result.generation, 2);
  assert.equal((await control.describe()).hostCommit, original);
  const notice = pi.session.messages.find(
    (message) => "customType" in message && message.customType === "pi-engineering-maintenance",
  );
  assert.ok(
    notice && "content" in notice && typeof notice.content === "string" && notice.content.includes(target),
    "the real Pi conversation receives the verified update notice without a model turn",
  );
  await pi.run("/probe");
  assert.equal(observed.values.at(-1), "cmd:B");
});

test("maintenance: mismatched target and dirty source never claim the requested release", async () => {
  const { original, source, ext } = await setup();
  const control = provider();
  const mismatch = await control.reload({ expectedCommit: "f".repeat(40) });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.commit, original);
  writeFileSync(join(source, "dep.ts"), 'export const VALUE = "dirty";\n');
  const dirty = await control.reload({ expectedCommit: original });
  assert.equal(dirty.ok, false);
  assert.equal(ext.host?.activeGeneration()?.generation, 1);
});

test("maintenance: safe-point timeout preserves old runtime and same commit can be retried", async () => {
  const { original, commit, ext } = await setup();
  const control = provider();
  const target = commit();
  const busy = ext.host!.operations.begin(1, "tool", "stalled tool");
  const result = await control.reload({ expectedCommit: target, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /safe point/);
  assert.equal(result.commit, original);
  assert.equal((await control.describe()).pending, false);
  busy.end();
  assert.equal((await control.reload({ expectedCommit: target })).ok, true);
});

test("maintenance: failed health rolls back and reports the restored commit", async () => {
  const { original, commit } = await setup();
  const result = await provider().reload({ expectedCommit: commit("unhealthy") });
  assert.equal(result.ok, false);
  assert.equal(result.commit, original);
  assert.match(result.error ?? "", /health/);
});

test("maintenance: can activate staged detached checkout without changing bootstrap identity", async () => {
  const { root, source, original, commit, pi, observed } = await setup();
  const target = commit();
  const staged = join(root, "release");
  git(root, "clone", "-q", source, staged);
  git(staged, "checkout", "--detach", target);
  git(source, "checkout", "--detach", original);
  const result = await provider().reload({ expectedCommit: target, sourceRoot: staged });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.commit, target);
  assert.equal((await provider().describe()).hostCommit, original);
  await pi.run("/probe");
  assert.equal(observed.values.at(-1), "cmd:B");
});

test("maintenance: older Host shutdown cannot unpublish a newer provider", async () => {
  const first = await setup();
  const old = provider();
  const second = await setup();
  const current = provider();
  assert.notEqual(old, current);
  await first.pi.close();
  assert.equal(provider(), current);
  await second.pi.close();
  assert.equal(
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-engineering.host-maintenance.v1")],
    undefined,
  );
});

test("maintenance: rollback after a successful pinned activation uses its immutable snapshot", async () => {
  const { source, key, commit, pi, observed } = await setup();
  const control = provider();
  const good = commit();
  assert.equal((await control.reload({ expectedCommit: good })).ok, true);
  writeFixtureRuntime(source, key, { value: "BAD", mode: "unhealthy" });
  git(source, "add", "-A");
  git(source, "commit", "-qm", "unhealthy next version");
  const result = await control.reload({ expectedCommit: git(source, "rev-parse", "HEAD") });
  assert.equal(result.ok, false);
  assert.equal(result.commit, good, "rollback restores the already-pinned generation");
  await pi.run("/probe");
  assert.equal(observed.values.at(-1), "cmd:B");
});

test("maintenance: manually loaded dirty code does not attest the checkout commit", async () => {
  const { source, pi } = await setup();
  writeFileSync(join(source, "dep.ts"), 'export const VALUE = "edited";\n');
  await pi.run("/pie reload");
  assert.equal((await provider().describe()).commit, null);
});

test("maintenance: default safe-point timeout really expires without caller configuration", async (t) => {
  const { ext } = await setup();
  const busy = ext.host!.operations.begin(1, "tool", "never finishes");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const wait = ext.host!.operations.waitForSafePoint();
    t.mock.timers.tick(30_000);
    const result = await wait;
    assert.equal(result.reached, false);
    if (!result.reached) assert.equal(result.reason, "timeout");
  } finally {
    t.mock.timers.reset();
    busy.end();
  }
});

test("maintenance: copied generations discover the same process-local provider", async () => {
  const { root } = await setup();
  const copied = join(root, "maintenance-copy.ts");
  copyFileSync(new URL("../../src/runtime/host/maintenance.ts", import.meta.url), copied);
  const accessor = await import(pathToFileURL(copied).href);
  assert.equal(accessor.getHostMaintenance(), provider());
});

test("maintenance: checkout mutation after validation cannot change the selected Git tree", async () => {
  const { source, commit, ext, pi, observed } = await setup();
  const expectedCommit = commit();
  const acquire = ext.lock.acquire.bind(ext.lock);
  ext.lock.acquire = (operation) => {
    const lock = acquire(operation);
    writeFileSync(join(source, "dep.ts"), 'export const VALUE = "racing edit";\n');
    return lock;
  };
  try {
    const result = await provider().reload({ expectedCommit });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.commit, expectedCommit);
    await pi.run("/probe");
    assert.equal(observed.values.at(-1), "cmd:B", "executes committed bytes despite source mutation");
  } finally {
    ext.lock.acquire = acquire;
  }
});

test("maintenance: source watching follows the staged checkout after activation", async () => {
  const { root, source, key, commit, ext } = await setup({ autoReload: true });
  const target = commit();
  const staged = join(root, "release");
  git(root, "clone", "-q", source, staged);
  assert.equal((await provider().reload({ expectedCommit: target, sourceRoot: staged })).ok, true);
  writeFixtureRuntime(staged, key, { value: "C" });
  git(staged, "add", "-A");
  git(staged, "commit", "-qm", "C");
  const next = git(staged, "rev-parse", "HEAD");
  await ext.sourceWatcher!.poll();
  assert.equal(ext.host?.activeGeneration()?.source.commit, next);
});

test("maintenance: a hung health check fails within the lifecycle budget", { timeout: 2000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rt-health-timeout-"));
  const source = join(root, "source");
  const key = `__health_timeout_${process.pid}_${++sequence}`;
  bag(key);
  writeFixtureRuntime(source, key, { value: "A" });
  const entry = join(source, "runtime.ts");
  writeFileSync(
    entry,
    readFileSync(entry, "utf8").replace("async health() {", "async health() { await new Promise(() => {});"),
  );
  cleanups.push(async () => {
    rmSync(root, { recursive: true, force: true });
  });
  let ok: boolean | undefined;
  let failure: string | undefined;
  const pi = await startPiSession({
    factories: [
      async (api: never) => {
        const host = new RuntimeHost({ pi: api, generationsDir: join(root, "generations"), lifecycleTimeoutMs: 20 });
        const result = await host.start({
          root: source,
          entry: "runtime.ts",
          version: "1",
          commit: null,
          label: "test",
        });
        ok = result.ok;
        failure = result.failure;
      },
    ],
  });
  cleanups.push(() => pi.close());
  assert.equal(ok, false);
  assert.match(failure ?? "", /health.*did not finish/);
});
