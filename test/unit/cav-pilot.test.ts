import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { writeHarness } from "../../src/cav/browser.ts";
import { calibratePilot } from "../../src/cav/pilot.ts";

const REPO = resolve(import.meta.dirname, "../..");

const PILOT_APP = `<!doctype html><html lang="en"><head><title>pilot</title><style>body{margin:0;font-family:sans-serif}</style></head><body>
<nav><a id="nav-home" href="#">Home</a><a id="nav-projects" href="#">Projects</a></nav>
<main><h1>Pilot Console</h1><button id="action-new">New</button><label for="search">Search</label><input id="search" placeholder="search"></main>
</body></html>`;

test("pilot calibration passes on a healthy console surface (deterministic gates)", async () => {
  const dir = `${REPO}/.pi-eng/cav/pilot-test`;
  const url = await writeHarness(dir, PILOT_APP);
  const result = await calibratePilot({
    name: "standin",
    url,
    artifactsDir: `${dir}/out`,
    expectedSelectors: ["#nav-home", "#action-new", "#search"],
    maxExploreSteps: 6,
  });
  assert.equal(result.passed, true, JSON.stringify(result.blockers));
  assert.equal(result.overrideHardGate, false);
  const gateNames = result.gates.map((g) => g.gate);
  assert.ok(gateNames.includes("ui"));
  assert.ok(gateNames.includes("explore"));
  assert.ok(gateNames.includes("a11y"));
  assert.ok(gateNames.includes("visual"));
});

test("pilot calibration fails closed when an expected selector is missing", async () => {
  const dir = `${REPO}/.pi-eng/cav/pilot-test-broken`;
  const url = await writeHarness(
    dir,
    `<!doctype html><html><head><title>pilot</title></head><body><main><h1>Broken</h1></main></body></html>`,
  );
  const result = await calibratePilot({
    name: "broken",
    url,
    artifactsDir: `${dir}/out`,
    expectedSelectors: ["#action-new"],
    maxExploreSteps: 4,
  });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((b) => b.includes("missing expected selector")));
});
