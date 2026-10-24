/** The Pi-side harness itself: a real control plane process, YAML-configured, every optional feature live. */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Plane } from "./support/plane.ts";

describe("e2e harness (Pi side)", () => {
  let plane: Plane;
  before(async () => {
    plane = await Plane.start({ keys: { pi: "ingest" }, users: ["alice"] });
  });
  after(async () => {
    await plane?.stop();
  });

  it("serves our generated keys and refuses a wrong one", async () => {
    assert.ok(plane.alive());
    assert.equal((await plane.call("GET", "/api/v1/health", { key: "viewer" })).status, 200);
    assert.equal((await plane.call("GET", "/api/v1/ingest/sources", { key: "nope" })).status, 401);
  });

  it("HCN room creation works with a generated token", async () => {
    await plane.verifyFeatures("alice");
  });
});
