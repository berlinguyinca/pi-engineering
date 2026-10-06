/**
 * Custody kept across a reload is handed back if the next generation does not
 * re-claim it in time (or the reload leaves no runtime running): retained
 * leases must not keep renewing forever and lock other sessions out.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { LeaseMissionCustody } from "../../src/runtime/isolation/MissionCustody.ts";
import { RuntimeRegistry } from "../../src/runtime/isolation/RuntimeRegistry.ts";
import { currentProcessIdentity } from "../../src/runtime/isolation/processIdentity.ts";
import { releaseRetainedCustody, retainedCustodyCount } from "../../src/runtime/isolation/reloadCustody.ts";

const root = mkdtempSync(join(tmpdir(), "rt-reload-handback-"));
after(() => rmSync(root, { recursive: true, force: true }));
const saved = process.env.PI_ENGINEERING_RELOAD_CUSTODY_MS;
afterEach(() => {
  releaseRetainedCustody();
  if (saved === undefined) delete process.env.PI_ENGINEERING_RELOAD_CUSTODY_MS;
  else process.env.PI_ENGINEERING_RELOAD_CUSTODY_MS = saved;
});

let n = 0;
function world() {
  const registry = RuntimeRegistry.open(join(root, `registry-${++n}.db`));
  const owner = { sessionId: `session-${n}`, process: currentProcessIdentity() };
  registry.register({ sessionId: owner.sessionId, process: owner.process, startedAt: new Date().toISOString() });
  const custody = () =>
    new LeaseMissionCustody(
      () => registry.leases,
      "ns",
      () => owner,
    );
  return { registry, custody };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("custody nobody re-claims is released after the handback window", async () => {
  process.env.PI_ENGINEERING_RELOAD_CUSTODY_MS = "150";
  const w = world();
  const old = w.custody();
  assert.equal((await old.claim("mission:M1")).ok, true);
  old.retainForReload();
  assert.ok(w.registry.leases.get("ns#mission:M1"), "kept during the reload");
  assert.equal(retainedCustodyCount(), 1);
  await sleep(400);
  assert.equal(w.registry.leases.get("ns#mission:M1"), undefined, "handed back: other sessions may admit it");
  assert.equal(retainedCustodyCount(), 0);
  w.registry.close();
});

test("custody the next generation re-claims stays with it after the window", async () => {
  process.env.PI_ENGINEERING_RELOAD_CUSTODY_MS = "150";
  const w = world();
  const old = w.custody();
  await old.claim("mission:M1");
  const generation = w.registry.leases.get("ns#mission:M1")?.generationId;
  old.retainForReload();
  const next = w.custody();
  assert.equal((await next.claim("mission:M1")).ok, true);
  await sleep(400);
  assert.equal(w.registry.leases.get("ns#mission:M1")?.generationId, generation, "still held by the session");
  assert.equal(next.holds("mission:M1"), true);
  w.registry.close();
});

test("a reload that leaves no runtime hands custody back at once", async () => {
  process.env.PI_ENGINEERING_RELOAD_CUSTODY_MS = "60000";
  const w = world();
  const old = w.custody();
  await old.claim("mission:M1");
  old.retainForReload();
  assert.equal(releaseRetainedCustody(), 1);
  assert.equal(w.registry.leases.get("ns#mission:M1"), undefined);
  w.registry.close();
});
