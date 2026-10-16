import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { validateEnvelope } from "../../src/orchestration/externalEntryProtocol.ts";

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/autospec-protocol/${name}.json`, import.meta.url), "utf8"));
}

describe("validateEnvelope", () => {
  it("accepts every object in every array of valid.json", () => {
    const valid = loadFixture("valid") as Record<string, unknown[]>;
    const arrays = Object.values(valid);
    assert.ok(arrays.length > 0, "valid.json should have at least one entity array");

    let count = 0;
    for (const records of arrays) {
      assert.ok(Array.isArray(records), "each valid.json value should be an array of records");
      for (const record of records) {
        const result = validateEnvelope(record);
        assert.ok(result.ok, `expected envelope to validate: ${JSON.stringify(record)}`);
        assert.equal(result.envelope.schema, (record as { schema: string }).schema);
        assert.equal(result.envelope.sequence, (record as { sequence: number }).sequence);
        count += 1;
      }
    }
    assert.ok(count >= 9, `expected at least one record per entity, found ${count}`);
  });

  it("rejects invalid.json case 'unsupported-version' with PROTOCOL_VERSION_UNSUPPORTED", () => {
    const invalid = loadFixture("invalid") as Array<{ name: string; record: unknown }>;
    const fixture = invalid.find((c) => c.name === "unsupported-version");
    assert.ok(fixture, "unsupported-version fixture should exist");
    const result = validateEnvelope(fixture.record);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "PROTOCOL_VERSION_UNSUPPORTED");
    }
  });

  it("rejects invalid.json case 'sequence-below-one' with INVALID_FIELD", () => {
    const invalid = loadFixture("invalid") as Array<{ name: string; record: unknown }>;
    const fixture = invalid.find((c) => c.name === "sequence-below-one");
    assert.ok(fixture, "sequence-below-one fixture should exist");
    const result = validateEnvelope(fixture.record);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "INVALID_FIELD");
    }
  });

  it("rejects invalid.json case 'missing-required-extensions-list' with MISSING_FIELD", () => {
    const invalid = loadFixture("invalid") as Array<{ name: string; record: unknown }>;
    const fixture = invalid.find((c) => c.name === "missing-required-extensions-list");
    assert.ok(fixture, "missing-required-extensions-list fixture should exist");
    const result = validateEnvelope(fixture.record);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "MISSING_FIELD");
    }
  });

  it("rejects non-object input with INVALID_FIELD", () => {
    for (const bad of [null, "envelope", 42, true, ["not", "an", "object"]]) {
      const result = validateEnvelope(bad);
      assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
      if (!result.ok) {
        assert.ok(
          result.code === "INVALID_FIELD" || result.code === "MISSING_FIELD",
          `non-object should map to INVALID_FIELD or MISSING_FIELD, got ${result.code}`,
        );
      }
    }
  });

  it("rejects a schema of 'foo' with SCHEMA_VIOLATION", () => {
    const result = validateEnvelope({
      schema: "foo",
      protocol_version: 1,
      idempotency_key: "idem-1",
      mission_id: "m-1",
      sequence: 1,
      required_extensions: [],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "SCHEMA_VIOLATION");
    }
  });

  it("rejects protocol_version 2 with PROTOCOL_VERSION_UNSUPPORTED", () => {
    const result = validateEnvelope({
      schema: "autospec.protocol.event.v1",
      protocol_version: 2,
      idempotency_key: "idem-1",
      mission_id: "m-1",
      sequence: 1,
      required_extensions: [],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "PROTOCOL_VERSION_UNSUPPORTED");
    }
  });

  it("rejects an empty mission_id with INVALID_FIELD", () => {
    const result = validateEnvelope({
      schema: "autospec.protocol.event.v1",
      protocol_version: 1,
      idempotency_key: "idem-1",
      mission_id: "",
      sequence: 1,
      required_extensions: [],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "INVALID_FIELD");
    }
  });

  it("rejects a non-integer protocol_version with INVALID_FIELD", () => {
    for (const bad of [1.5, "1", true, null]) {
      const result = validateEnvelope({
        schema: "autospec.protocol.event.v1",
        protocol_version: bad as never,
        idempotency_key: "idem-1",
        mission_id: "m-1",
        sequence: 1,
        required_extensions: [],
      });
      assert.equal(result.ok, false, `expected protocol_version ${String(bad)} to be rejected`);
      if (!result.ok) {
        assert.equal(result.code, "INVALID_FIELD");
      }
    }
  });

  it("rejects integer protocol_version other than 1 with PROTOCOL_VERSION_UNSUPPORTED", () => {
    for (const bad of [2, 0]) {
      const result = validateEnvelope({
        schema: "autospec.protocol.event.v1",
        protocol_version: bad,
        idempotency_key: "idem-1",
        mission_id: "m-1",
        sequence: 1,
        required_extensions: [],
      });
      assert.equal(result.ok, false, `expected protocol_version ${String(bad)} to be rejected`);
      if (!result.ok) {
        assert.equal(result.code, "PROTOCOL_VERSION_UNSUPPORTED");
      }
    }
  });

  it("rejects a missing protocol_version with MISSING_FIELD", () => {
    const result = validateEnvelope({
      schema: "autospec.protocol.event.v1",
      idempotency_key: "idem-1",
      mission_id: "m-1",
      sequence: 1,
      required_extensions: [],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "MISSING_FIELD");
    }
  });

  it("rejects schema versions other than v1 with SCHEMA_VIOLATION", () => {
    const result = validateEnvelope({
      schema: "autospec.protocol.event.v2",
      protocol_version: 1,
      idempotency_key: "idem-1",
      mission_id: "m-1",
      sequence: 1,
      required_extensions: [],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "SCHEMA_VIOLATION");
    }
  });

  it("rejects schema identifiers with uppercase letters or underscores with SCHEMA_VIOLATION", () => {
    const result = validateEnvelope({
      schema: "autospec.protocol.Event_1.v1",
      protocol_version: 1,
      idempotency_key: "idem-1",
      mission_id: "m-1",
      sequence: 1,
      required_extensions: [],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "SCHEMA_VIOLATION");
    }
  });

  it("accepts a schema identifier with a hyphen in the entity name", () => {
    const result = validateEnvelope({
      schema: "autospec.protocol.resource-record.v1",
      protocol_version: 1,
      idempotency_key: "idem-1",
      mission_id: "m-1",
      sequence: 1,
      required_extensions: [],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.envelope.schema, "autospec.protocol.resource-record.v1");
    }
  });
});
