import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  RESOURCE_SCHEMA_VERSION,
  type RegisterInput,
  ResourceRegistry,
  toProtocolResourceRecord,
} from "../../src/resources/ResourceRegistry.ts";

const owner = { missionId: "m-1", executionId: "e-1" };

function input(over: Partial<RegisterInput> = {}): RegisterInput {
  return {
    id: "res-1",
    kind: "worktree",
    ownerMissionId: "m-1",
    ownerExecutionId: "e-1",
    locator: "/tmp/does-not-matter",
    lease: "lease-1",
    ...over,
  };
}

describe("ResourceRegistry", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "res-registry-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const registry = (hostId = "host-a") => new ResourceRegistry(dir, hostId);
  const files = async () => (await readdir(join(dir, "resources"))).filter((f) => f.endsWith(".json"));

  it("registers a record stamped with schema version, host and active state", async () => {
    const rec = await registry().register(input());
    assert.equal(rec.schemaVersion, RESOURCE_SCHEMA_VERSION);
    assert.equal(rec.hostId, "host-a");
    assert.equal(rec.state, "active");
    assert.ok(!Number.isNaN(Date.parse(rec.createdAt)));
  });

  it("calling register twice with one id leaves 1 record file", async () => {
    const r = registry();
    const first = await r.register(input());
    const second = await r.register(input());
    assert.deepEqual(second, first);
    assert.equal((await files()).length, 1);
  });

  it("refuses to re-register an id under a different owner", async () => {
    const r = registry();
    await r.register(input());
    await assert.rejects(r.register(input({ ownerMissionId: "m-2" })), /owned by/);
    assert.equal((await r.listOwned("m-2")).length, 0);
  });

  it("rejects an unknown kind and an empty id before writing anything", async () => {
    const r = registry();
    await assert.rejects(r.register(input({ kind: "socket" as never })), /kind/);
    await assert.rejects(r.register(input({ id: "" })), /id/);
    assert.equal(existsSync(join(dir, "resources")) ? (await files()).length : 0, 0);
  });

  it("beginRelease with a different owner returns foreign and the record is unchanged", async () => {
    const r = registry();
    await r.register(input());
    const before = await readFile(join(dir, "resources", (await files())[0] as string), "utf8");
    const result = await r.beginRelease("res-1", { missionId: "m-2", executionId: "e-9" }, () => false);
    assert.equal(result.status, "foreign");
    const same = await r.beginRelease("res-1", { missionId: "m-1", executionId: "e-other" }, () => false);
    assert.equal(same.status, "foreign");
    const after = await readFile(join(dir, "resources", (await files())[0] as string), "utf8");
    assert.equal(after, before);
  });

  it("beginRelease refuses a record registered by another host", async () => {
    await registry("host-b").register(input());
    const result = await registry("host-a").beginRelease("res-1", owner, () => false);
    assert.equal(result.status, "foreign");
    assert.equal((await registry("host-b").listOwned("m-1"))[0]?.state, "active");
  });

  it("beginRelease for an active mission returns active and leaves the record active", async () => {
    const r = registry();
    await r.register(input());
    const result = await r.beginRelease("res-1", owner, (missionId) => missionId === "m-1");
    assert.equal(result.status, "active");
    assert.equal((await r.listOwned("m-1"))[0]?.state, "active");
  });

  it("an unknown id reports missing rather than throwing", async () => {
    const result = await registry().beginRelease("nope", owner, () => false);
    assert.equal(result.status, "missing");
  });

  it("release is idempotent: begin, complete, begin again and complete again", async () => {
    const r = registry();
    await r.register(input());
    const begun = await r.beginRelease("res-1", owner, () => false);
    assert.equal(begun.status, "ok");
    assert.equal((await r.listOwned("m-1"))[0]?.state, "releasing");
    await r.completeRelease("res-1");
    await r.completeRelease("res-1");
    assert.equal((await r.listOwned("m-1"))[0]?.state, "released");
    const again = await r.beginRelease("res-1", owner, () => false);
    assert.equal(again.status, "ok");
    assert.equal((await r.listOwned("m-1"))[0]?.state, "released");
  });

  it("completeRelease refuses a record whose release never began", async () => {
    const r = registry();
    await r.register(input());
    await assert.rejects(r.completeRelease("res-1"), /not releasing/);
  });

  it("reconcile resolves a record left in releasing (crash after the deletion)", async () => {
    const gone = join(dir, "already-deleted");
    const r = registry();
    await r.register(input({ locator: gone }));
    await r.beginRelease("res-1", owner, () => false);
    const diagnostics = await registry().reconcile();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.action, "completed");
    assert.equal((await r.listOwned("m-1"))[0]?.state, "released");
  });

  it("reconcile rolls back a releasing record whose resource still exists", async () => {
    const still = join(dir, "still-here");
    await mkdir(still);
    const r = registry();
    await r.register(input({ locator: still }));
    await r.beginRelease("res-1", owner, () => false);
    const diagnostics = await registry().reconcile();
    assert.equal(diagnostics[0]?.action, "rolled_back");
    assert.equal((await r.listOwned("m-1"))[0]?.state, "active");
  });

  it("reconcile ignores another host's releasing record", async () => {
    await registry("host-b").register(input({ locator: join(dir, "x") }));
    await registry("host-b").beginRelease("res-1", owner, () => false);
    const diagnostics = await registry("host-a").reconcile();
    assert.deepEqual(diagnostics, []);
    assert.equal((await registry("host-b").listOwned("m-1"))[0]?.state, "releasing");
  });

  it("reconcile quarantines a corrupt record file and reports it", async () => {
    const r = registry();
    await r.register(input());
    await writeFile(join(dir, "resources", "garbage.json"), "{not json", "utf8");
    const diagnostics = await r.reconcile();
    assert.equal(
      diagnostics.some((d) => d.action === "quarantined"),
      true,
    );
    assert.equal(existsSync(join(dir, "resources", "garbage.json")), false);
    assert.equal((await r.listOwned("m-1")).length, 1);
  });

  it("a stray temp file from a crashed write is never read as a record", async () => {
    const r = registry();
    await r.register(input());
    await mkdir(join(dir, "resources"), { recursive: true });
    await writeFile(join(dir, "resources", ".res-x.json.tmp-1"), "{half", "utf8");
    assert.equal((await r.listOwned("m-1")).length, 1);
    assert.deepEqual(await r.reconcile(), []);
  });

  it("listOwned filters by mission", async () => {
    const r = registry();
    await r.register(input());
    await r.register(input({ id: "res-2", ownerMissionId: "m-2" }));
    assert.deepEqual(
      (await r.listOwned("m-2")).map((x) => x.id),
      ["res-2"],
    );
  });

  it("concurrent registrations of one id leave a single file", async () => {
    const r = registry();
    await Promise.all(Array.from({ length: 8 }, () => r.register(input())));
    assert.equal((await files()).length, 1);
  });

  it("maps to the autospec resource-record.v1 field names", async () => {
    const rec = await registry().register(input({ locator: "/x/y", bytes: 10, inodes: 2 }));
    const wire = toProtocolResourceRecord(rec, { idempotencyKey: "k1", sequence: 1 });
    assert.deepEqual(Object.keys(wire).sort(), [
      "bytes",
      "created_at",
      "extensions",
      "idempotency_key",
      "inodes",
      "kind",
      "lease_id",
      "mission_id",
      "owner",
      "path",
      "protocol_version",
      "required_extensions",
      "resource_id",
      "schema",
      "sequence",
      "state",
    ]);
    assert.equal(wire.schema, "autospec.protocol.resource-record.v1");
    assert.deepEqual(wire.owner, { mission_id: "m-1", execution_id: "e-1" });
    assert.equal(wire.state, "active");
    assert.equal(wire.path, "/x/y");
    assert.deepEqual(wire.extensions, { host_id: "host-a" });
  });

  it("maps local releasing and retained states onto the protocol vocabulary", async () => {
    const r = registry();
    const rec = await r.register(input());
    const releasing = { ...rec, state: "releasing" as const };
    const retained = { ...rec, state: "retained" as const };
    const ctx = { idempotencyKey: "k", sequence: 1 };
    assert.equal(toProtocolResourceRecord(releasing, ctx).state, "releasable");
    assert.equal(toProtocolResourceRecord(retained, ctx).state, "retained_for_diagnostics");
  });
});
