/**
 * The fifth trail gate, AUDIT/manifest-binding-scan.mjs, runs in CI BEFORE `npm install`
 * (.woodpecker/ci.yaml: trail-scans precedes install, so a red install cannot hide a red trail), so it
 * cannot import parseTaskManifest -- it reimplements the manifest normalization that FIX-4A hashes
 * (src/bootstrap/resultGate.ts:47-51: the authority is the canonical hash of the PARSED manifest).
 *
 * A reimplementation that nothing checks is how a gate starts disagreeing with the protocol quietly,
 * so this file is the other half of that gate: it pins normalizeManifest() and canon() against the
 * REAL parser and the REAL taskAuthorityHash(), on every manifest the repository tracks and on the
 * hostile inputs where drift would actually hide. Both halves run on every pipeline -- this one under
 * tsx after install, the gate under plain node before it.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canon,
  normalizeManifest,
} from "../../docs/specs/harness-reliability-bootstrap-20261103/AUDIT/manifest-binding-scan.mjs";
import { taskAuthorityHash } from "../../src/bootstrap/resultGate.ts";
import { parseTaskManifest } from "../../src/bootstrap/taskManifest.ts";

const SPEC = "docs/specs/harness-reliability-bootstrap-20261103";
const trackedManifests = execSync(`git ls-files ${SPEC}`, { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((f) => /\/fixtures\/manifest[^/]*\.json$/.test(f));

const gateNormalize = (input: unknown) => normalizeManifest(input) as { manifest?: unknown; errors?: string[] };

/** Canonical-content equality: the parser builds its object in a different key ORDER than the gate
 * does, and canonicalHash sorts keys at every level, so key order is not a difference. Compared the
 * way the protocol compares, not by JSON.stringify. */
const sameContent = (a: unknown, b: unknown) => canon({ v: a } as never) === canon({ v: b } as never);

test("the trail tracks the manifests this pin is meant to cover", () => {
  // A filter that matches nothing would make every test below pass vacuously.
  assert.ok(trackedManifests.length > 70, `expected the trail's manifests, found ${trackedManifests.length}`);
});

test("gate normalization and parseTaskManifest agree on every tracked manifest", () => {
  for (const file of trackedManifests) {
    const input = JSON.parse(readFileSync(file, "utf8"));
    const real = parseTaskManifest(input);
    const mine = gateNormalize(input);
    assert.equal(
      real.ok,
      mine.manifest !== undefined,
      `${file}: parser accepts=${real.ok}, gate accepts=${mine.manifest !== undefined}`,
    );
    if (real.ok !== true) continue;
    assert.ok(
      sameContent((real as { manifest: unknown }).manifest, mine.manifest),
      `${file}: the gate's normalized manifest differs from parseTaskManifest's`,
    );
  }
});

test("the gate's authority hash IS taskAuthorityHash for every tracked manifest", () => {
  // This is the edge the gate certifies: record.taskAuthorityHash must equal canonicalHash(parsed
  // manifest). If canon(normalizeManifest(x)) ever diverged from taskAuthorityHash(parseTaskManifest(x)),
  // the gate would be certifying a different quantity than the protocol defines.
  for (const file of trackedManifests) {
    const input = JSON.parse(readFileSync(file, "utf8"));
    const real = parseTaskManifest(input);
    assert.equal(real.ok, true, `${file}: tracked manifest no longer parses -- the gate would report UNPARSEABLE`);
    if (real.ok !== true) continue;
    const mine = gateNormalize(input);
    assert.equal(
      canon(mine.manifest as never),
      taskAuthorityHash(real.manifest),
      `${file}: the gate's authority hash differs from the protocol's taskAuthorityHash`,
    );
  }
});

test("raw and parsed never hash alike, so the FIX-4A distinction is never vacuous", () => {
  // The X15 deviation (AUDIT/manifest-binding-declared.json, kind authority_raw) rests on the fact
  // that hashing the raw manifest is a DIFFERENT quantity from hashing the parsed one -- the parser
  // rebuilds each command as {argv, cwd} and applies three defaults. If some manifest ever hashed the
  // same both ways, "raw vs parsed" would stop being a meaningful distinction for it, and this test
  // says so out loud rather than letting the declaration quietly overstate itself.
  for (const file of trackedManifests) {
    const input = JSON.parse(readFileSync(file, "utf8"));
    const real = parseTaskManifest(input);
    if (real.ok !== true) continue;
    assert.notEqual(
      canon(input as never),
      taskAuthorityHash(real.manifest),
      `${file}: raw and parsed hash alike, so authority_raw would not be a detectable deviation here`,
    );
  }
});

/** Mutations of a real manifest, each with the verdict the protocol gives it. The happy path cannot
 * catch drift in a rejection rule, and every rule below is one the gate reimplements by hand. */
const BASE = JSON.parse(readFileSync(`${SPEC}/B05/fixtures/manifest.json`, "utf8"));
const clone = () => JSON.parse(JSON.stringify(BASE));
const cases: Array<{ name: string; input: unknown; accepts: boolean }> = [
  { name: "the unmodified manifest", input: clone(), accepts: true },
  { name: "unknown top-level key", input: Object.assign(clone(), { surprise: 1 }), accepts: false },
  {
    name: "missing objective",
    input: (() => {
      const m = clone();
      delete m.objective;
      return m;
    })(),
    accepts: false,
  },
  { name: "baseSha too short to be a commit id", input: Object.assign(clone(), { baseSha: "abc" }), accepts: false },
  { name: "baseSha not hex", input: Object.assign(clone(), { baseSha: "z".repeat(40) }), accepts: false },
  { name: "allowPaths empty", input: Object.assign(clone(), { allowPaths: [] }), accepts: false },
  { name: "allowPaths non-string", input: Object.assign(clone(), { allowPaths: [1] }), accepts: false },
  { name: "commands empty", input: Object.assign(clone(), { commands: [] }), accepts: false },
  { name: "commands not an array", input: Object.assign(clone(), { commands: "nope" }), accepts: false },
  {
    name: "command missing cwd",
    input: (() => {
      const m = clone();
      delete m.commands[0].cwd;
      return m;
    })(),
    accepts: false,
  },
  {
    name: "command argv empty",
    input: (() => {
      const m = clone();
      m.commands[0].argv = [];
      return m;
    })(),
    accepts: false,
  },
  {
    name: "command with an extra key: accepted, and the key dropped",
    input: (() => {
      const m = clone();
      m.commands[0].extra = "x";
      return m;
    })(),
    accepts: true,
  },
  { name: "mode not one of the three", input: Object.assign(clone(), { mode: "yolo" }), accepts: false },
  {
    name: "mode missing",
    input: (() => {
      const m = clone();
      delete m.mode;
      return m;
    })(),
    accepts: false,
  },
  {
    name: "limits over the production-file ceiling",
    input: Object.assign(clone(), { limits: { maxProductionFiles: 9, maxTestFiles: 1, maxChangedLines: 10 } }),
    accepts: false,
  },
  {
    name: "101 changed lines under isolated-change",
    input: Object.assign(clone(), {
      mode: "isolated-change",
      limits: { maxProductionFiles: 1, maxTestFiles: 1, maxChangedLines: 101 },
    }),
    accepts: false,
  },
  {
    name: "120 changed lines under herdr-ui",
    input: Object.assign(clone(), {
      mode: "herdr-ui",
      limits: { maxProductionFiles: 1, maxTestFiles: 1, maxChangedLines: 120 },
    }),
    accepts: true,
  },
  {
    name: "limits with an unknown key",
    input: Object.assign(clone(), {
      limits: { maxProductionFiles: 1, maxTestFiles: 1, maxChangedLines: 10, bonus: 1 },
    }),
    accepts: false,
  },
  {
    name: "limits absent: the default applies",
    input: (() => {
      const m = clone();
      delete m.limits;
      return m;
    })(),
    accepts: true,
  },
  {
    name: "parentHandoffHash malformed",
    input: Object.assign(clone(), { parentHandoffHash: "sha256:deadbeef" }),
    accepts: false,
  },
  {
    name: "parentHandoffHash null: schema-legal, the chain starts here",
    input: Object.assign(clone(), { parentHandoffHash: null }),
    accepts: true,
  },
  {
    name: "denyPaths absent: the default applies",
    input: (() => {
      const m = clone();
      delete m.denyPaths;
      return m;
    })(),
    accepts: true,
  },
  {
    name: "expectedOutputs absent: the default applies",
    input: (() => {
      const m = clone();
      delete m.expectedOutputs;
      return m;
    })(),
    accepts: true,
  },
  { name: "denyPaths with a non-string element", input: Object.assign(clone(), { denyPaths: [2] }), accepts: false },
  { name: "taskId blank", input: Object.assign(clone(), { taskId: "  " }), accepts: false },
  {
    name: "__proto__ as an own key",
    input: Object.defineProperty(clone(), "__proto__", {
      value: { polluted: 1 },
      enumerable: true,
      configurable: true,
    }),
    accepts: false,
  },
  { name: "an array instead of an object", input: [], accepts: false },
  { name: "null", input: null, accepts: false },
];

test("gate normalization and parseTaskManifest reach the same verdict on hostile input", () => {
  for (const { name, input, accepts } of cases) {
    const real = parseTaskManifest(input);
    const mine = gateNormalize(input);
    assert.equal(real.ok, accepts, `${name}: fixture no longer shows the protocol the verdict this file records`);
    assert.equal(
      mine.manifest !== undefined,
      accepts,
      `${name}: the gate disagrees with parseTaskManifest -- parser drift`,
    );
  }
});

test("the agreement check itself is not vacuous", () => {
  // sameContent compares the way the protocol hashes, so prove it separates things it should
  // separate: a manifest and its own normalization differ from that manifest with a value changed.
  const input = clone();
  const a = gateNormalize(input).manifest;
  const b = gateNormalize(Object.assign(clone(), { objective: "different objective" })).manifest;
  assert.ok(sameContent(a, gateNormalize(clone()).manifest));
  assert.ok(
    !sameContent(a, b),
    "the comparison treats different manifests as equal -- every test above would pass vacuously",
  );
});
