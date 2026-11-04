/**
 * FIX-3B: validateHandoffSchema against the REAL protocol schema (read from templates/, never stubbed) and the real
 * committed example record, plus the defect classes the handoff names (totality and the writer land in FIX-3B2).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateHandoffSchema } from "../../src/bootstrap/handoffWriter.ts";
import { canonicalHash } from "../../src/bootstrap/resultGate.ts";

const SCHEMA: unknown = JSON.parse(readFileSync(new URL("../../docs/specs/harness-reliability-bootstrap-20261103/templates/handoff.schema.json", import.meta.url), "utf8"));
const EXAMPLE: Record<string, unknown> = JSON.parse(readFileSync(new URL("../../docs/specs/harness-reliability-bootstrap-20261103/examples/handoff-example.json", import.meta.url), "utf8"));
const APPROVAL = { required: true, approved: true, approvedBy: null, approvedAt: null };
const COMMAND = { command: "npm run typecheck", exitCode: 0, outputArtifact: "logs/01.txt" };
// Every required field of the real schema, schema-legal — and no handoffHash: the writer stamps it after validation.
const RECORD: Record<string, unknown> = { specVersion: "1.2.0", taskId: "FIX-3B", status: "PASS", repo: "berlinguyinca/pi-engineering", baseSha: "2".repeat(40), resultSha: "3".repeat(40), taskAuthorityHash: `sha256:${"a".repeat(64)}`, changedFiles: ["src/bootstrap/handoffWriter.ts"], commands: [COMMAND], evidence: ["logs/01.txt"], nextTaskId: "FIX-3C", nextBaseSha: "4".repeat(40), blockedReasons: [], operatorApproval: APPROVAL };
const blocks = (record: Record<string, unknown>, schema: unknown = SCHEMA) => validateHandoffSchema(record, schema);
const noThrow = (record: unknown, schema: unknown = SCHEMA) => { let blockers: string[] = []; assert.doesNotThrow(() => { blockers = validateHandoffSchema(record as Record<string, unknown>, schema); }, `throwing on ${String(record)}`); assert.ok(blockers.length > 0, "hostile input is a blocker, never an exception"); };
const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });

test("the real schema accepts a real conforming record, with or without the stamped hash", () => {
  assert.deepEqual(blocks(RECORD), [], "a record without handoffHash conforms: the hash is injected after validation"); assert.deepEqual(blocks({ ...RECORD, handoffHash: `sha256:${"b".repeat(64)}` }), [], "an extra handoffHash is never a disallowed additional property");
  assert.deepEqual(blocks(EXAMPLE), [], "the committed protocol example record (handoffHash included) conforms");
});

test("every required field is required, at the top level and nested", () => {
  const noStatus = { ...RECORD }; delete noStatus.status;
  assert.deepEqual(blocks(noStatus), ["$.status: required property missing"]); assert.deepEqual(blocks({ ...RECORD, operatorApproval: { required: true } }), ["$.operatorApproval.approved: required property missing"]);
});

test("a value outside enum, or of the wrong scalar type, is blocked at its path", () => {
  assert.deepEqual(blocks({ ...RECORD, status: "DONE" }), ['$.status: "DONE" is not one of enum ["PASS","ALREADY_SATISFIED","BLOCKED"]']);
  assert.deepEqual(blocks({ ...RECORD, status: 7 }), ['$.status: 7 is not one of enum ["PASS","ALREADY_SATISFIED","BLOCKED"]'], "status carries enum, not type, so enum is what catches a number");
  assert.deepEqual(blocks({ ...RECORD, specVersion: "1.1.0" }), ['$.specVersion: "1.1.0" != const "1.2.0"']);
});

test("array items are validated recursively, and only integral numbers satisfy integer", () => {
  assert.deepEqual(blocks({ ...RECORD, commands: ["npm test"] }), ['$.commands[0]: "npm test" does not match type "object"', '$.commands[0]: object required by schema, got "npm test"']);
  assert.deepEqual(blocks({ ...RECORD, commands: [{ ...COMMAND, exitCode: 1.5 }] }), ['$.commands[0].exitCode: 1.5 does not match type "integer"']); assert.deepEqual(blocks({ ...RECORD, commands: [{ ...COMMAND, exitCode: 1 }] }), [], "an integral exitCode conforms");
});

test("additionalProperties: false blocks an unknown key, but never the hash the writer stamps", () => {
  assert.deepEqual(blocks({ ...RECORD, bogusKey: 1 }), ["$.bogusKey: disallowed additional property"]); assert.deepEqual(blocks({ ...RECORD, handoffHash: 7 }), ['$.handoffHash: 7 does not match type "string"'], "exempt from required and additionalProperties, still type-checked");
});

test("null is accepted exactly where the schema allows it, and nowhere else", () => {
  assert.deepEqual(blocks({ ...RECORD, nextTaskId: null, nextBaseSha: null, blockedReasons: [], operatorApproval: { ...APPROVAL, approvedBy: null, approvedAt: null } }), [], "nextTaskId/nextBaseSha/approvedBy/approvedAt are [string,null]");
  assert.deepEqual(blocks({ ...RECORD, nextTaskId: 7 }), ['$.nextTaskId: 7 does not match type ["string","null"]']);
  assert.deepEqual(blocks({ ...RECORD, parentHandoffHash: null }), ["$.parentHandoffHash: disallowed additional property"], "parentHandoffHash is a task-manifest field: the handoff schema declares no such property and forbids additional ones");
});

