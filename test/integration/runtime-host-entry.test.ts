/**
 * The stable entry shim (package.json `pi.extensions`): if the RuntimeHost
 * cannot be imported or fails while installing, Pi keeps Pi Engineering by
 * loading the legacy extension directly, and `/engineering` explains why.
 * Real Pi sessions, a real copy of the package with a broken Host module.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startPiSession } from "../support/piSession.ts";
import { bag, writeFixtureRuntime } from "../support/runtimeFixtures.ts";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

const ENV_KEYS = [
  "HOME",
  "PI_ENGINEERING_HOME",
  "PI_ENGINEERING_CONTROL_DIR",
  "PI_SELF_UPDATE",
  "PI_PANEL_AUTO_OPEN",
  "PI_PANEL_NARRATOR",
  "PI_ENGINEERING_UPDATE_CHECK",
] as const;
const saved: Record<string, string | undefined> = {};
let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "rt-host-entry-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.HOME = join(root, "home");
  process.env.PI_ENGINEERING_HOME = join(root, "install");
  process.env.PI_ENGINEERING_CONTROL_DIR = join(root, "control");
  process.env.PI_SELF_UPDATE = "0";
  process.env.PI_PANEL_AUTO_OPEN = "0";
  process.env.PI_PANEL_NARRATOR = "0";
  process.env.PI_ENGINEERING_UPDATE_CHECK = "0";
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(root, { recursive: true, force: true });
});

test("package.json points Pi at the entry shim", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { pi: { extensions: string[] } };
  assert.deepEqual(pkg.pi.extensions, ["./src/runtime/host/entry.ts"]);
});

test("a Host that throws at import: Pi still gets Pi Engineering (legacy), and /engineering says why", async () => {
  const copy = join(root, "package-broken-import");
  await cp(join(repoRoot, "src"), join(copy, "src"), { recursive: true });
  await cp(join(repoRoot, "extensions"), join(copy, "extensions"), { recursive: true });
  await cp(join(repoRoot, "package.json"), join(copy, "package.json"));
  await symlink(join(repoRoot, "node_modules"), join(copy, "node_modules"), "dir");
  await writeFile(
    join(copy, "src", "runtime", "host", "extension.ts"),
    'throw new Error("host module is broken");\nexport default function () {}\n',
  );
  const pi = await startPiSession({ extensionPaths: [join(copy, "src", "runtime", "host", "entry.ts")] });
  try {
    const commands = pi.piCommands();
    for (const name of ["engineer", "mission", "plan", "engineering"]) {
      assert.equal(commands.filter((c) => c === name).length, 1, `/${name} registered once`);
    }
    const { hostFallbackReason } = await import("../../src/runtime/host/entry.ts");
    assert.match(hostFallbackReason() ?? "", /import failed: host module is broken/);
  } finally {
    await pi.close();
  }
});

test("a Host that fails while installing: its handlers are undone, then the legacy extension loads", async () => {
  const dir = join(root, "modules");
  await cp(join(repoRoot, "package.json"), join(dir, "package.json"));
  await writeFile(
    join(dir, "host.ts"),
    `export default async function (pi: any) {
       pi.on("agent_settled", () => {});
       pi.registerCommand("engineering", { description: "half-installed host", handler: async () => {} });
       throw new Error("host install exploded");
     }\n`,
  );
  await writeFile(
    join(dir, "legacy.ts"),
    `export default function (pi: any) {
       pi.registerCommand("engineer", { description: "legacy", handler: async () => {} });
     }\n`,
  );
  const { installPiEngineering } = await import("../../src/runtime/host/entry.ts");
  const modules = {
    host: () => import(pathToFileURL(join(dir, "host.ts")).href),
    legacy: () => import(pathToFileURL(join(dir, "legacy.ts")).href),
  };
  const pi = await startPiSession({ factories: [(api: never) => installPiEngineering(api, modules)] });
  try {
    assert.equal(pi.piHandlerCount("agent_settled"), 0, "the failed Host's handlers were removed");
    assert.ok(pi.piCommands().includes("engineer"), "legacy extension loaded");
    assert.ok(pi.piCommands().includes("engineering"), "/engineering explains the fallback");
    const { hostFallbackReason } = await import("../../src/runtime/host/entry.ts");
    assert.match(hostFallbackReason() ?? "", /initialization failed: host install exploded/);
  } finally {
    await pi.close();
  }
});

/** A real EngineeringHostExtension over a fixture runtime that fails after its generation started. */
async function failingAfterStart(name: string, opts: { stopFails?: boolean } = {}) {
  const dir = join(root, name);
  const key = `__rt_entry_${name}_${process.pid}`;
  writeFixtureRuntime(join(dir, "runtime"), key, { value: "HOST-GEN" });
  if (opts.stopFails) {
    const runtime = join(dir, "runtime", "runtime.ts");
    const source = readFileSync(runtime, "utf8");
    const patched = source.replace("b.stops++;", 'b.stops++;\n      throw new Error("stop failed");');
    assert.notEqual(patched, source, "fixture stop() patched");
    await writeFile(runtime, patched);
  }
  // ESM like the real package (host.ts must not load as CommonJS).
  await cp(join(repoRoot, "package.json"), join(dir, "package.json"));
  const extensionUrl = pathToFileURL(join(repoRoot, "src", "runtime", "host", "extension.ts")).href;
  await writeFile(
    join(dir, "host.ts"),
    `import { EngineeringHostExtension } from ${JSON.stringify(extensionUrl)};
     class FailsAfterStart extends EngineeringHostExtension {
       protected override async repairPointersAfterStart(): Promise<void> {
         throw new Error("host failed after start");
       }
     }
     export default (pi: any) => new FailsAfterStart({
       installRoot: ${JSON.stringify(join(dir, "install"))},
       packageRoot: ${JSON.stringify(join(dir, "runtime"))},
       entry: "runtime.ts",
       baseline: false,
       autoUpdateCheck: false,
     }).install(pi);\n`,
  );
  await writeFile(
    join(dir, "legacy.ts"),
    `export default function (pi: any) {
       pi.registerCommand("engineer", { description: "legacy", handler: async () => {} });
     }\n`,
  );
  const modules = {
    host: () => import(pathToFileURL(join(dir, "host.ts")).href),
    legacy: () => import(pathToFileURL(join(dir, "legacy.ts")).href),
  };
  return { b: bag(key), modules };
}

test("a Host that fails AFTER its generation started stops that generation before the legacy fallback runs", async () => {
  const { installPiEngineering, hostFallbackReason } = await import("../../src/runtime/host/entry.ts");
  const { b, modules } = await failingAfterStart("after-start");
  const pi = await startPiSession({ factories: [(api: never) => installPiEngineering(api, modules)] });
  try {
    assert.equal(b.starts, 1, "the Host's generation had started");
    assert.equal(b.stops, 1, "and was stopped before falling back: never two runtimes");
    assert.match(hostFallbackReason() ?? "", /initialization failed: host failed after start/);
    assert.ok(pi.piCommands().includes("engineer"), "legacy extension loaded");
    assert.equal(pi.piHandlerCount("agent_settled"), 0, "the Host's handlers were removed");
    await pi.emit({ type: "agent_settled" });
    assert.equal(b.reactions, 0, "the stopped generation no longer reacts");
  } finally {
    await pi.close();
  }
});

test("a Host whose started generation cannot be stopped keeps its handlers and gets no legacy twin", async () => {
  const { installPiEngineering, hostFallbackReason } = await import("../../src/runtime/host/entry.ts");
  const { b, modules } = await failingAfterStart("stop-fails", { stopFails: true });
  const pi = await startPiSession({ factories: [(api: never) => installPiEngineering(api, modules)] });
  try {
    assert.equal(b.starts, 1);
    assert.equal(b.stops, 1, "stopping was attempted and failed");
    assert.match(hostFallbackReason() ?? "", /host failed after start/);
    assert.equal(pi.piCommands().includes("engineer"), false, "no second (legacy) runtime");
    assert.ok(pi.piHandlerCount("session_shutdown") > 0, "the surviving runtime keeps its shutdown handler");
    assert.ok(pi.piHandlerCount("agent_settled") > 0, "and its other event handlers");
  } finally {
    await pi.close();
  }
});
