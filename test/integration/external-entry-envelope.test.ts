/**
 * The external JSON entry point's autospec-protocol submit path: when the
 * request body carries a `schema` field of the form `autospec.protocol.<entity>.v<N>`,
 * the body is validated as an envelope and the Pi submit fields are read from
 * `extensions.pi`, with the mission id and idempotency key taken from the
 * envelope. Requests without `schema` keep the legacy behaviour unchanged.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = resolve(fileURLToPath(new URL("../../scripts/pi-engineering.ts", import.meta.url)));

interface Run {
  code: number | null;
  json: Record<string, any>;
  stderr: string;
}

describe("pi-engineering mission (autospec-protocol envelope submit)", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function store(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pi-ext-envelope-"));
    cleanup.push(dir);
    return dir;
  }

  function run(
    sub: string,
    dir: string,
    body: unknown,
    env: Record<string, string | undefined> = { PI_AUTOSPEC_ENABLED: "1" },
  ): Run {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PI_AUTOSPEC_ENABLED: undefined, PI_MISSION_DEPTH: undefined };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }
    for (const key of ["PI_AUTOSPEC_ENABLED", "PI_MISSION_DEPTH"])
      if (childEnv[key] === undefined) delete childEnv[key];
    const child = spawnSync(process.execPath, [CLI, "mission", sub, "--store", dir], {
      input: typeof body === "string" ? body : JSON.stringify(body),
      env: childEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(child.stdout || "{}");
    } catch {
      // leave empty; the assertion on stdout below reports it
    }
    return { code: child.status, json, stderr: child.stderr };
  }

  function envelopeSubmit(over: { pi?: Record<string, unknown>; envelope?: Record<string, unknown> } = {}) {
    return {
      schema: "autospec.protocol.mission.v1",
      protocol_version: 1,
      idempotency_key: "env-key-1",
      mission_id: "MSN-ext-envelope-1",
      sequence: 1,
      required_extensions: [],
      ...over.envelope,
      extensions: {
        pi: {
          ownerId: "autospec-1",
          title: "Add isEven",
          goal: "Implement isEven with tests",
          repository: "/repo/example",
          baseRef: "abc123",
          ...over.pi,
        },
      },
    };
  }

  it("a valid enveloped submit creates the mission with the given mission_id", async () => {
    const dir = await store();
    const result = run("submit", dir, envelopeSubmit());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.result, "created");
    assert.equal(result.json.missionId, "MSN-ext-envelope-1");
    assert.equal(result.json.ownerId, "autospec-1");
    assert.ok(Number.isInteger(result.json.fencingToken) && result.json.fencingToken >= 1);
    assert.equal(result.json.status, "NEW");
    assert.equal(result.json.canonicalState, "CREATED");

    // the same envelope idempotency_key is a duplicate, returning the same mission
    const again = run("submit", dir, envelopeSubmit());
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.result, "existing");
    assert.equal(again.json.missionId, "MSN-ext-envelope-1");

    // observe confirms the Pi submit fields were applied
    const seen = run("observe", dir, {
      missionId: "MSN-ext-envelope-1",
      ownerId: "autospec-1",
      fencingToken: result.json.fencingToken,
    });
    assert.equal(seen.code, 0, seen.stderr);
    assert.equal(seen.json.result, "ok");
    assert.equal(seen.json.mission.title, "Add isEven");
  });

  it("an unsupported protocol_version is a protocol_error PROTOCOL_VERSION_UNSUPPORTED (exit 2)", async () => {
    const dir = await store();
    const result = run("submit", dir, envelopeSubmit({ envelope: { protocol_version: 99 } }));
    assert.equal(result.code, 2);
    assert.equal(result.json.result, "protocol_error");
    assert.equal(result.json.code, "PROTOCOL_VERSION_UNSUPPORTED");
    assert.match(result.json.message, /protocol_version/);
  });

  it("a legacy body without a schema still works unchanged", async () => {
    const dir = await store();
    const result = run("submit", dir, {
      ownerId: "autospec-1",
      idempotencyKey: "legacy-key-1",
      title: "Add isEven",
      goal: "Implement isEven with tests",
      repository: "/repo/example",
      baseRef: "abc123",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.result, "created");
    assert.match(result.json.missionId, /^MSN-/);
    assert.notEqual(result.json.missionId, "MSN-ext-envelope-1");
    assert.equal(result.json.ownerId, "autospec-1");
  });

  it("an invalid envelope field is a protocol_error with its code (exit 2)", async () => {
    const dir = await store();
    // missing required envelope field -> MISSING_FIELD
    const noMissionId = envelopeSubmit({ envelope: { mission_id: undefined as unknown as string } });
    delete (noMissionId as Record<string, unknown>).mission_id;
    const result = run("submit", dir, noMissionId);
    assert.equal(result.code, 2);
    assert.equal(result.json.result, "protocol_error");
    assert.equal(result.json.code, "MISSING_FIELD");
  });
});
