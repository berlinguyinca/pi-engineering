/**
 * FIX-3B + FIX-3B2: validateHandoffSchema against the REAL protocol schema (read from templates/, never stubbed)
 * and the real committed example record, every defect class the handoff names, totality under hostile input,
 * and writeHandoff into a missing directory (FIX-3B2).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateHandoffSchema, writeHandoff } from "../../src/bootstrap/handoffWriter.ts";
import { canonicalHash } from "../../src/bootstrap/resultGate.ts";

const SCHEMA: unknown = JSON.parse(
  readFileSync(
    new URL("../../docs/specs/harness-reliability-bootstrap-20261103/templates/handoff.schema.json", import.meta.url),
    "utf8",
  ),
);
const EXAMPLE: Record<string, unknown> = JSON.parse(
  readFileSync(
    new URL("../../docs/specs/harness-reliability-bootstrap-20261103/examples/handoff-example.json", import.meta.url),
    "utf8",
  ),
);
const APPROVAL = { required: true, approved: true, approvedBy: null, approvedAt: null };
const COMMAND = { command: "npm run typecheck", exitCode: 0, outputArtifact: "logs/01.txt" };
// Every required field of the real schema, schema-legal — and no handoffHash: the writer stamps it after validation.
const RECORD: Record<string, unknown> = {
  specVersion: "1.2.0",
  taskId: "FIX-3B",
  status: "PASS",
  repo: "berlinguyinca/pi-engineering",
  baseSha: "2".repeat(40),
  resultSha: "3".repeat(40),
  taskAuthorityHash: `sha256:${"a".repeat(64)}`,
  changedFiles: ["src/bootstrap/handoffWriter.ts"],
  commands: [COMMAND],
  evidence: ["logs/01.txt"],
  nextTaskId: "FIX-3C",
  nextBaseSha: "4".repeat(40),
  blockedReasons: [],
  operatorApproval: APPROVAL,
};
const blocks = (record: Record<string, unknown>, schema: unknown = SCHEMA) => validateHandoffSchema(record, schema);
const noThrow = (record: unknown, schema: unknown = SCHEMA) => {
  let blockers: string[] = [];
  assert.doesNotThrow(
    () => {
      blockers = validateHandoffSchema(record as Record<string, unknown>, schema);
    },
    `throwing on ${String(record)}`,
  );
  assert.ok(blockers.length > 0, "hostile input is a blocker, never an exception");
};
const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });

test("the real schema accepts a real conforming record, with or without the stamped hash", () => {
  assert.deepEqual(blocks(RECORD), [], "a record without handoffHash conforms: the hash is injected after validation");
  assert.deepEqual(
    blocks({ ...RECORD, handoffHash: `sha256:${"b".repeat(64)}` }),
    [],
    "an extra handoffHash is never a disallowed additional property",
  );
  assert.deepEqual(blocks(EXAMPLE), [], "the committed protocol example record (handoffHash included) conforms");
});

test("every required field is required, at the top level and nested", () => {
  const noStatus = { ...RECORD };
  delete noStatus.status;
  assert.deepEqual(blocks(noStatus), ["$.status: required property missing"]);
  assert.deepEqual(blocks({ ...RECORD, operatorApproval: { required: true } }), [
    "$.operatorApproval.approved: required property missing",
  ]);
});

test("a value outside enum, or of the wrong scalar type, is blocked at its path", () => {
  assert.deepEqual(blocks({ ...RECORD, status: "DONE" }), [
    '$.status: "DONE" is not one of enum ["PASS","ALREADY_SATISFIED","BLOCKED"]',
  ]);
  assert.deepEqual(
    blocks({ ...RECORD, status: 7 }),
    ['$.status: 7 is not one of enum ["PASS","ALREADY_SATISFIED","BLOCKED"]'],
    "status carries enum, not type, so enum is what catches a number",
  );
  assert.deepEqual(blocks({ ...RECORD, specVersion: "1.1.0" }), ['$.specVersion: "1.1.0" != const "1.2.0"']);
});

test("array items are validated recursively, and only integral numbers satisfy integer", () => {
  assert.deepEqual(blocks({ ...RECORD, commands: ["npm test"] }), [
    '$.commands[0]: "npm test" does not match type "object"',
    '$.commands[0]: object required by schema, got "npm test"',
  ]);
  assert.deepEqual(blocks({ ...RECORD, commands: [{ ...COMMAND, exitCode: 1.5 }] }), [
    '$.commands[0].exitCode: 1.5 does not match type "integer"',
  ]);
  assert.deepEqual(blocks({ ...RECORD, commands: [{ ...COMMAND, exitCode: 1 }] }), [], "an integral exitCode conforms");
});

test("additionalProperties: false blocks an unknown key, but never the hash the writer stamps", () => {
  assert.deepEqual(blocks({ ...RECORD, bogusKey: 1 }), ["$.bogusKey: disallowed additional property"]);
  assert.deepEqual(
    blocks({ ...RECORD, handoffHash: 7 }),
    ['$.handoffHash: 7 does not match type "string"'],
    "exempt from required and additionalProperties, still type-checked",
  );
});

test("null is accepted exactly where the schema allows it, and nowhere else", () => {
  assert.deepEqual(
    blocks({
      ...RECORD,
      nextTaskId: null,
      nextBaseSha: null,
      blockedReasons: [],
      operatorApproval: { ...APPROVAL, approvedBy: null, approvedAt: null },
    }),
    [],
    "nextTaskId/nextBaseSha/approvedBy/approvedAt are [string,null]",
  );
  assert.deepEqual(blocks({ ...RECORD, nextTaskId: 7 }), ['$.nextTaskId: 7 does not match type ["string","null"]']);
  assert.deepEqual(
    blocks({ ...RECORD, parentHandoffHash: null }),
    ["$.parentHandoffHash: disallowed additional property"],
    "parentHandoffHash is a task-manifest field: the handoff schema declares no such property and forbids additional ones",
  );
});

test("hostile schema or record input yields blockers and never an exception", () => {
  assert.deepEqual(blocks(RECORD, null), ["$: schema is not an object: null"]);
  assert.deepEqual(blocks(RECORD, "x"), ['$: schema is not an object: "x"']);
  assert.deepEqual(blocks({ a: "x" }, objectSchema({ a: { items: { type: "string" } } })), [
    '$.a: items declared but value is "x", not an array',
  ]);
  assert.deepEqual(blocks({ a: [1] }, objectSchema({ a: { type: "array", items: "nope" } })), [
    '$.a.items: schema is not an object: "nope"',
  ]);
  assert.deepEqual(blocks({ a: 1 }, { type: "object", required: [null] }), [
    "$.null: schema required entry is not a string",
  ]);
  noThrow(RECORD, []);
  noThrow(null);
  noThrow([]);
  noThrow({ ...RECORD, commands: { ...COMMAND } });
});

test("writeHandoff creates a missing nested directory and leaves exactly one immutable handoff", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "fix3b-write-")), "deep", "nested");
  const written = writeHandoff(dir, "FIX-3B", RECORD);
  assert.deepEqual(written, { path: join(dir, "FIX-3B.handoff.json"), handoffHash: canonicalHash(RECORD) });
  assert.deepEqual(readdirSync(dir), ["FIX-3B.handoff.json"], "exactly one handoff, no .tmp left behind");
  const stamped = JSON.parse(readFileSync(written.path, "utf8")) as Record<string, unknown>;
  const unsigned = { ...stamped };
  delete unsigned.handoffHash;
  assert.equal(stamped.handoffHash, canonicalHash(unsigned), "handoffHash == canonicalHash(parsed minus handoffHash)");
  assert.deepEqual(blocks(stamped), [], "the stamped file itself still conforms");
});
