/**
 * Slash-command argument completions inside a REAL Pi session (issue #254):
 * Pi's matcher reads `item.value.startsWith(prefix)`, so every completion
 * must be an AutocompleteItem object, never a bare string.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { EngineeringHostExtension } from "../../src/runtime/host/extension.ts";
import { startPiSession } from "../support/piSession.ts";
import { writeFixtureRuntime } from "../support/runtimeFixtures.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

type Completer = { getArgumentCompletions?: (p: string) => unknown };

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "rt-completions-"));
  const source = join(root, "source");
  writeFixtureRuntime(source, `__rt_completions_${process.pid}`, { value: "A" });
  const g = (...a: string[]) =>
    execFileSync("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
  g("init", "-q");
  g("add", "-A");
  g("commit", "-qm", "A");
  const ext = new EngineeringHostExtension({
    installRoot: join(root, "install"),
    packageRoot: source,
    entry: "runtime.ts",
    baseline: true,
    autoUpdateCheck: false,
    autoReload: false,
  });
  const pi = await startPiSession({ factories: [(api: never) => ext.install(api)] });
  cleanups.push(async () => {
    await pi.close();
    rmSync(root, { recursive: true, force: true });
  });
  const runner = pi.session.extensionRunner as unknown as { getCommand(n: string): Completer | undefined };
  return (name: string) => runner.getCommand(name)?.getArgumentCompletions;
}

/** Mirrors Pi's getBestAutocompleteMatchIndex: reads item.value.startsWith(prefix). */
function pisMatcher(items: Array<{ value: string }>, prefix: string): number[] {
  return items.flatMap((it, i) => (it.value.startsWith(prefix) ? [i] : []));
}

test("/pie completions are items Pi's matcher can read, for every partial argument", async () => {
  const completer = await setup();
  const pie = completer("pie");
  assert.ok(pie, "/pie registers argument completions");
  for (const prefix of ["", "v", "ver", "pr", "u"]) {
    const items = pie(prefix) as Array<{ value: string; label: string }> | null;
    if (items === null) continue;
    assert.ok(items.length > 0);
    for (const it of items) {
      assert.equal(typeof it, "object");
      assert.equal(typeof it.value, "string");
    }
    assert.deepEqual(pisMatcher(items, prefix).length, items.length, `every item matches "${prefix}"`);
  }
  assert.ok((pie("ver") as Array<{ value: string }>).some((i) => i.value === "version"));
  assert.equal(pie("zzz-nothing"), null);
  assert.equal(pie("version x"), null);
});

test("a generation command's string[] completions are forwarded as items", async () => {
  const completer = await setup();
  const probe = completer("probe");
  assert.ok(probe, "the forwarder exposes completions");
  const items = (await probe("ver")) as Array<{ value: string; label: string }>;
  assert.deepEqual(items, [
    { value: "verbose", label: "verbose" },
    { value: "version", label: "version" },
  ]);
  assert.equal(pisMatcher(items, "ver").length, 2);
  assert.equal(await probe("q"), null);
});

test("an async completion provider's Promise is awaited and normalised to items", async () => {
  const completer = await setup();
  const aprobe = completer("aprobe");
  assert.ok(aprobe);
  const result = aprobe("al");
  assert.ok(result instanceof Promise, "Pi awaits the forwarder");
  const items = (await result) as Array<{ value: string; label: string }>;
  assert.deepEqual(items, [
    { value: "alpha", label: "alpha" },
    { value: "alpine", label: "alpine" },
  ]);
  assert.equal(await aprobe("zz"), null);
});
