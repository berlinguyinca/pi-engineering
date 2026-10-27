/**
 * Vendored upstream split-view (extensions/split-view, Hugo-W/pi-split-view @ 6b6b98a).
 *
 * Loaded through Pi's REAL extension loader (jiti), so this also proves the vendored
 * code loads, registers only what VENDORED.md documents, claims no shortcuts and is
 * inert until the operator runs `/split`. Provenance headers and the documented
 * local reliability patches remain explicit when the upstream snapshot changes.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const vendorDir = join(repoRoot, "extensions/split-view");

const DOCUMENTED_COMMANDS = [
  "files",
  "split",
  "split-height",
  "split-save",
  "split-thinking",
  "split-tools",
  "split-tools-view",
  "split-tools-width",
  "split-trim-response",
];

let home = "";
let savedHome: string | undefined;
before(() => {
  // ui-panels-config.ts reads ~/.pi/agent/ui-panels.json: point HOME at an empty dir.
  home = mkdtempSync(join(tmpdir(), "split-view-home-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
});
after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

async function loadVendored() {
  const agentDir = join(home, "agent");
  const result = await discoverAndLoadExtensions([join(vendorDir, "split-view.ts")], home, agentDir);
  assert.deepEqual(result.errors, [], "vendored extension must load without errors");
  assert.equal(result.extensions.length, 1);
  return result.extensions[0]!;
}

test("package.json pi.extensions lists the main entry and split-view, but not the shared config module", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { pi: { extensions: string[] } };
  assert.deepEqual(pkg.pi.extensions, ["./src/runtime/host/entry.ts", "./extensions/split-view/split-view.ts"]);
  assert.ok(!pkg.pi.extensions.some((e) => e.includes("ui-panels-config") || e.includes("layout-manager")));
});

test("vendored files preserve provenance and document local reliability patches", () => {
  for (const f of ["split-view.ts", "layout-manager.ts", "ui-panels-config.ts"]) {
    const head = readFileSync(join(vendorDir, f), "utf8").split("\n", 2).join("\n");
    assert.match(head, /github\.com\/Hugo-W\/pi-split-view @ commit 6b6b98a \(MIT/);
    assert.match(head, f === "split-view.ts" ? /Locally patched/ : /Vendored unmodified/);
  }
  assert.match(readFileSync(join(vendorDir, "LICENSE"), "utf8"), /MIT License/);
  assert.match(readFileSync(join(vendorDir, "VENDORED.md"), "utf8"), /6b6b98a/);
});

test("split-view registers only the documented commands, one flag, and no shortcuts", async () => {
  const ext = await loadVendored();
  assert.deepEqual([...ext.commands.keys()].sort(), DOCUMENTED_COMMANDS);
  assert.equal(ext.shortcuts.size, 0, "must not claim any keyboard shortcut");
  assert.deepEqual([...ext.flags.keys()], ["no-split"]);
  assert.equal(ext.tools.size, 0, "must not register tools");
});

test("split-view does not collide with commands registered by pi-engineering", async () => {
  const ext = await loadVendored();
  const sources = ["extensions/index.ts", "src/blackhole/interactiveMemory.ts", "src/runtime/host/entry.ts"];
  const ours = new Set<string>();
  for (const f of sources) {
    for (const m of readFileSync(join(repoRoot, f), "utf8").matchAll(/registerCommand\(\s*"([^"]+)"/g)) ours.add(m[1]!);
  }
  assert.ok(ours.size > 5, "sanity: found pi-engineering commands");
  for (const name of ext.commands.keys()) assert.ok(!ours.has(name), `/${name} collides with a pi-engineering command`);
});

test("with default config nothing is activated: no panel widget, no layout layer, no file writes", async () => {
  const ext = await loadVendored();
  const calls: string[] = [];
  const ui = new Proxy(
    {},
    {
      get:
        (_t, prop) =>
        (..._a: unknown[]) => {
          calls.push(String(prop));
          return undefined;
        },
    },
  );
  const ctx = {
    mode: "print",
    hasUI: false,
    cwd: home,
    ui,
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  };
  for (const handler of ext.handlers.get("session_start") ?? [])
    await handler({ type: "session_start", reason: "startup" }, ctx);
  // Default split=false: no overlay/dock composed. Only the inert (data-only) widget bookkeeping may happen.
  assert.ok(!calls.includes("custom"), `no overlay expected, saw: ${calls.join(",")}`);
  assert.ok(!calls.includes("setFooter"), "split-view must never touch the footer");
  assert.ok(!calls.includes("setHeader"));
  assert.ok(!calls.includes("notify"), "no 'Split view on' notice by default");
  for (const handler of ext.handlers.get("session_shutdown") ?? [])
    await handler({ type: "session_shutdown", reason: "quit" }, ctx);
  // Nothing was persisted: only /split-save writes ui-panels.json.
  assert.throws(() => readFileSync(join(home, ".pi/agent/ui-panels.json"), "utf8"), /ENOENT/);
});

test("split-view status/widget keys do not collide with pi-engineering's", () => {
  const src = readFileSync(join(vendorDir, "split-view.ts"), "utf8");
  assert.match(src, /const WIDGET_KEY = "split-view"/);
  assert.ok(!/setStatus\(/.test(src), "split-view must not use setStatus");
  assert.ok(!/setFooter\(/.test(src), "split-view must not use setFooter");
  const ours = [
    "extensions/index.ts",
    "src/inference/admissionStatus.ts",
    "src/lifecycle/harness.ts",
    "src/status/footer.ts",
  ]
    .map((f) => readFileSync(join(repoRoot, f), "utf8"))
    .join("\n");
  assert.ok(!/["'`]split-view["'`]/.test(ours));
});
