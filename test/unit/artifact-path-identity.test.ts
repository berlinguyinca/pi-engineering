/**
 * #731: a pinned directory seen by name must be judged by the same doctrine the
 * lock domain uses — inode is identity, `st_dev` is a mount-generation stamp.
 *
 * On hosts without descriptor-relative projection (the darwin fallback in
 * `ArtifactStore.securePath`), the store verifies an open directory descriptor
 * by stating the *name* it was opened through and comparing. Before #731 that
 * comparison required `st_dev` equality, so a mount generation — the APFS
 * rollover an OS update or a `/pie update` leaves behind — made a healthy store
 * refuse with `artifact lock root identity changed`, thrown from the pinning
 * assertion, before `validateLockDomain` could call the same difference a mount
 * generation and re-stamp it. The store's own doctrine file says in words that
 * `device` is NOT identity; these tests pin the doctrine to the assertion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPathIdentity } from "../../src/artifacts/lockDomain.ts";

const dev = (n: number) => BigInt(n);

test("a name that resolves to the pinned inode on the same device matches", () => {
  assert.deepEqual(classifyPathIdentity({ dev: dev(1), ino: dev(9) }, { dev: dev(1), ino: dev(9) }), {
    kind: "match",
  });
});

test("a name that resolves to the pinned inode on another device is a mount generation, not a substitution", () => {
  // The APFS case: the volume generation moves by a small delta while the
  // directory itself stays put.
  assert.deepEqual(
    classifyPathIdentity(
      { dev: dev(16777231), ino: dev(1487270852) },
      {
        dev: dev(16777233),
        ino: dev(1487270852),
      },
    ),
    { kind: "mount_generation", from: dev(16777231), to: dev(16777233) },
  );
});

test("a name that resolves to another inode is substituted even when the device is unchanged", () => {
  const drift = classifyPathIdentity({ dev: dev(7), ino: dev(1) }, { dev: dev(7), ino: dev(2) });
  assert.equal(drift.kind, "substituted");
  if (drift.kind !== "substituted") return;
  assert.equal(drift.expected.ino, dev(1));
  assert.equal(drift.actual.ino, dev(2));
  assert.equal(drift.expected.dev, dev(7));
  assert.equal(drift.actual.dev, dev(7));
});

test("a name on another device carrying another inode is substituted, and reports both identities", () => {
  const drift = classifyPathIdentity({ dev: dev(11), ino: dev(5) }, { dev: dev(12), ino: dev(6) });
  assert.equal(drift.kind, "substituted");
  if (drift.kind !== "substituted") return;
  assert.deepEqual(drift.expected, { dev: dev(11), ino: dev(5) });
  assert.deepEqual(drift.actual, { dev: dev(12), ino: dev(6) });
});
