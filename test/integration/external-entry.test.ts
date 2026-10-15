/**
 * The external JSON entry point (`pi-engineering mission submit|observe|cancel`).
 * The real CLI runs as a child process against a real JSONL store in a mkdtemp
 * directory; nothing is mocked.
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

describe("pi-engineering mission (external entry)", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function store(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pi-ext-entry-"));
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

  const request = (over: Record<string, unknown> = {}) => ({
    ownerId: "autospec-1",
    idempotencyKey: "key-1",
    title: "Add isEven",
    goal: "Implement isEven with tests",
    repository: "/repo/example",
    baseRef: "abc123",
    ...over,
  });

  it("exits 2 with a message unless PI_AUTOSPEC_ENABLED is on", async () => {
    const dir = await store();
    for (const env of [{}, { PI_AUTOSPEC_ENABLED: "0" }]) {
      const result = run("submit", dir, request(), env);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /PI_AUTOSPEC_ENABLED/);
    }
  });

  it("submit creates a mission in CREATED and returns missionId, ownerId and fencingToken", async () => {
    const dir = await store();
    const result = run("submit", dir, request());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.result, "created");
    assert.match(result.json.missionId, /^MSN-/);
    assert.equal(result.json.ownerId, "autospec-1");
    assert.ok(Number.isInteger(result.json.fencingToken) && result.json.fencingToken >= 1);
    assert.equal(result.json.status, "NEW");
    assert.equal(result.json.canonicalState, "CREATED");
  });

  it("a duplicate submit with the same idempotencyKey returns the same missionId", async () => {
    const dir = await store();
    const first = run("submit", dir, request());
    const second = run("submit", dir, request());
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json.result, "existing");
    assert.equal(second.json.missionId, first.json.missionId);
    assert.equal(second.json.fencingToken, first.json.fencingToken);
    // another key is another mission
    const other = run("submit", dir, request({ idempotencyKey: "key-2" }));
    assert.notEqual(other.json.missionId, first.json.missionId);
    // the same key from another owner is a conflict, not a second mission and not a takeover
    const thief = run("submit", dir, request({ ownerId: "someone-else" }));
    assert.equal(thief.code, 1);
    assert.equal(thief.json.result, "conflict");
  });

  it("refuses a request without owner identity or a key", async () => {
    const dir = await store();
    for (const bad of [
      request({ ownerId: undefined }),
      request({ ownerId: "  " }),
      request({ idempotencyKey: undefined }),
      request({ title: undefined }),
    ]) {
      const result = run("submit", dir, bad);
      assert.equal(result.code, 2, JSON.stringify(bad));
      assert.match(result.stderr, /ownerId|idempotencyKey|title/);
    }
    assert.equal(run("submit", dir, "not json").code, 2);
  });

  it("observe returns the mission snapshot entry for the current owner", async () => {
    const dir = await store();
    const sub = run("submit", dir, request());
    const seen = run("observe", dir, {
      missionId: sub.json.missionId,
      ownerId: "autospec-1",
      fencingToken: sub.json.fencingToken,
    });
    assert.equal(seen.code, 0, seen.stderr);
    assert.equal(seen.json.result, "ok");
    assert.equal(seen.json.mission.id, sub.json.missionId);
    assert.equal(seen.json.mission.title, "Add isEven");
    assert.equal(seen.json.mission.canonicalState, "CREATED");
  });

  it("a stale fencing token cannot observe or cancel, and the mission is unchanged", async () => {
    const dir = await store();
    const sub = run("submit", dir, request());
    const id = sub.json.missionId;
    const token = sub.json.fencingToken;
    for (const wrong of [
      { ownerId: "autospec-1", fencingToken: token - 1 },
      { ownerId: "autospec-1", fencingToken: token + 1 },
      { ownerId: "intruder", fencingToken: token },
    ]) {
      const cancel = run("cancel", dir, { missionId: id, reason: "x", ...wrong });
      assert.equal(cancel.code, 1, JSON.stringify(wrong));
      assert.equal(cancel.json.result, "stale");
      const observe = run("observe", dir, { missionId: id, ...wrong });
      assert.equal(observe.code, 1);
      assert.equal(observe.json.result, "stale");
    }
    const after = run("observe", dir, { missionId: id, ownerId: "autospec-1", fencingToken: token });
    assert.equal(after.json.mission.status, "NEW");
    assert.equal(after.json.mission.canonicalState, "CREATED");
  });

  it("cancel with the current token cancels the mission, and cancelling again is a no-op", async () => {
    const dir = await store();
    const sub = run("submit", dir, request());
    const owner = { missionId: sub.json.missionId, ownerId: "autospec-1", fencingToken: sub.json.fencingToken };
    const cancel = run("cancel", dir, { ...owner, reason: "operator stop" });
    assert.equal(cancel.code, 0, cancel.stderr);
    assert.equal(cancel.json.result, "cancelled");
    const seen = run("observe", dir, owner);
    assert.equal(seen.json.mission.status, "CANCELED");
    assert.equal(seen.json.mission.canonicalState, "CANCELLED");
    const again = run("cancel", dir, { ...owner, reason: "again" });
    assert.equal(again.code, 0);
    assert.equal(again.json.result, "cancelled");
  });

  it("an unknown mission is not_found; a missing store is an error", async () => {
    const dir = await store();
    run("submit", dir, request());
    const missing = run("observe", dir, { missionId: "MSN-nope", ownerId: "autospec-1", fencingToken: 1 });
    assert.equal(missing.code, 1);
    assert.equal(missing.json.result, "not_found");
    const noStore = run("observe", join(dir, "absent"), { missionId: "MSN-nope", ownerId: "a", fencingToken: 1 });
    assert.equal(noStore.code, 3);
  });

  it("refuses to create a mission from inside a mission worker (nested missions)", async () => {
    const dir = await store();
    const result = run("submit", dir, request(), { PI_AUTOSPEC_ENABLED: "1", PI_MISSION_DEPTH: "1" });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /nested missions/);
  });
});
