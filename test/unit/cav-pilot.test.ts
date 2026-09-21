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

test("pilot calibration detects every seeded failure scenario (fail-closed topology)", async () => {
  const dir = `${REPO}/.pi-eng/cav/pilot-test-failures`;
  const url = await writeHarness(dir, PILOT_APP);
  // Seeded scenarios: missing action button (topology break) and a page that
  // throws (JS failure). The verifier must detect BOTH — never pass on broken.
  const brokenApp = `<!doctype html><html lang="en"><head><title>pilot</title></head><body><main><h1>Broken</h1></main></body></html>`;
  const result = await calibratePilot({
    name: "inferweave",
    url,
    artifactsDir: `${dir}/out`,
    expectedSelectors: ["#action-new"],
    maxExploreSteps: 4,
    writeScenarioHtml: async () => url, // reuse healthy url; scenario HTML is the broken surface
    failureScenarios: [{ id: "missing-action", html: brokenApp, mustFailSelector: "#action-new" }],
  });
  // Failure scenario must be DETECTED (gate passes means detection succeeded).
  const failureGate = result.gates.find((g) => g.gate === "failure");
  assert.ok(failureGate, "failure gate missing");
  assert.equal(failureGate.passed, true, JSON.stringify(result.blockers));
});

// A broken pilot surface that the verifier FAILS to flag is a real finding.
test("failure scenario that is NOT detected blocks the calibration", async () => {
  const dir = `${REPO}/.pi-eng/cav/pilot-test-undetected`;
  const url = await writeHarness(dir, PILOT_APP);
  // Scenario HTML is NOT actually served (writeScenarioHtml returns the healthy
  // url), so the verifier sees a healthy surface and passes => not detected.
  const result = await calibratePilot({
    name: "inferweave",
    url,
    artifactsDir: `${dir}/out`,
    expectedSelectors: ["#action-new"],
    maxExploreSteps: 2,
    writeScenarioHtml: async () => url,
    failureScenarios: [{ id: "phantom", html: "ignored", mustFailSelector: "#does-not-exist-in-healthy" }],
  });
  assert.equal(result.passed, false);
  assert.ok(
    result.blockers.some((b) => b.toLowerCase().includes("not detected")),
    JSON.stringify(result.blockers),
  );
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
