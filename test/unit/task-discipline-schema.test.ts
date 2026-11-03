import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CONTRACT_FIELDS,
  CONTRACT_REQUIRED,
  EXTERNAL_EFFECTS,
  TASK_MODES,
  parseContract,
} from "../../src/taskDiscipline/contract.ts";

/**
 * The wire shape published to operators must be the shape the parser accepts, in
 * both directions: a schema that allows a field the parser rejects produces a
 * contract that locks the session down at start, and a schema that omits a field
 * the parser honours hides authority the operator can actually grant.
 */
const SCHEMA = new URL("../../docs/specs/task-discipline-v1/task-contract.schema.json", import.meta.url);
const EXAMPLE = new URL(
  "../../docs/specs/task-discipline-v1/examples/peak-picking-investigation.json",
  import.meta.url,
);
const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as {
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, { enum?: string[]; items?: { enum?: string[]; const?: string }; maxItems?: number }>;
  allOf: { if: { properties: { mode: { enum: string[] } } }; then: { properties: Record<string, unknown> } }[];
};

test("the published schema's field set is the parser's field set", () => {
  assert.equal(schema.additionalProperties, false, "a contract must not be able to invent a field");
  assert.deepEqual(Object.keys(schema.properties).sort(), [...CONTRACT_FIELDS].sort());
  assert.deepEqual([...schema.required].sort(), [...CONTRACT_REQUIRED].sort());
  assert.deepEqual(schema.properties.mode?.enum, [...TASK_MODES]);
  assert.deepEqual(schema.properties.externalEffects?.items?.enum, [...EXTERNAL_EFFECTS]);
});

test("every field documented as required really is required, and nothing else is", () => {
  const base = {
    taskId: "t",
    objective: "o",
    mode: "investigation",
    policyRevision: 1,
    readRoots: ["/r"],
    writeRoots: [],
    allowedHosts: [],
    externalEffects: [],
    acceptanceCriteria: ["x"],
  };
  for (const field of CONTRACT_REQUIRED) {
    const missing = { ...base } as Record<string, unknown>;
    delete missing[field];
    assert.throws(() => parseContract(missing), new RegExp(field), `${field} was accepted without a value`);
  }
  assert.equal(parseContract(base).taskId, "t");
});

test("the schema states the mode/authority rule the parser enforces", () => {
  const rule = schema.allOf[0];
  assert.ok(rule, "the schema must state the mode/authority rule");
  assert.deepEqual(rule.if.properties.mode.enum, ["investigation", "review"]);
  assert.deepEqual(rule.then.properties.writeRoots, { maxItems: 0 });
  assert.deepEqual(rule.then.properties.externalEffects, { items: { const: "remote_read" } });
  const asReview = { ...JSON.parse(readFileSync(EXAMPLE, "utf8")), mode: "review" };
  assert.throws(() => parseContract({ ...asReview, writeRoots: ["/repo"] }), /cannot have writeRoots/);
  assert.throws(() => parseContract({ ...asReview, externalEffects: ["deploy"] }), /only allow remote_read/);
});

test("the spec's example contract parses and grants what it says it grants", () => {
  const c = parseContract(JSON.parse(readFileSync(EXAMPLE, "utf8")));
  assert.equal(c.mode, "investigation");
  assert.deepEqual(c.writeRoots, []);
  assert.deepEqual(c.externalEffects, []);
  assert.deepEqual(c.allowedHosts, []);
  assert.ok(c.scratchRoots?.length, "the investigation example needs somewhere to write diagnostics");
  assert.ok(c.readRoots.length > 1, "wide read spans the dependent repos");
  // Paths are literal: the parser does not expand placeholders, so an example
  // carrying ${REPO_ROOT} would resolve to a relative path and never match.
  for (const root of [...c.readRoots, ...c.scratchRoots!]) assert.match(root, /^\//);
});
