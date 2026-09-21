import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { writeHarness } from "../../src/cav/browser.ts";
import { verifyUiInteractions } from "../../src/cav/ui.ts";

const REPO = resolve(import.meta.dirname, "../..");

const APP = `<!doctype html><html><head><title>ui</title></head><body>
<input id="name" placeholder="name">
<button id="go">Go</button>
<button id="counter">0</button>
<table id="t"><tr><td>a</td></tr></table>
<script>
  const btn = document.getElementById("go");
  btn.addEventListener("click", () => { document.body.dataset.clicked = "yes"; });
  const c = document.getElementById("counter");
  c.addEventListener("click", () => { c.textContent = String(Number(c.textContent)+1); });
  const input = document.getElementById("name");
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") document.body.dataset.enter = input.value; });
</script></body></html>`;

test("UI interaction verification: click, input, counter, table and keyboard checks pass", async () => {
  const dir = `${REPO}/.pi-eng/cav/ui-test`;
  const url = await writeHarness(dir, APP);
  const result = await verifyUiInteractions({
    url,
    artifactsDir: `${dir}/out`,
    checks: [
      {
        id: "click-go",
        description: "clicking Go sets a data attribute",
        act: async (p) => p.click("#go"),
        assert: async (p) => (await p.getAttribute("body", "data-clicked")) === "yes",
      },
      {
        id: "counter",
        description: "clicking counter increments its text",
        act: async (p) => p.click("#counter"),
        assert: async (p) => (await p.textContent("#counter")) === "1",
      },
      {
        id: "table",
        description: "table contains expected cell",
        act: async () => {},
        assert: async (p) => (await p.textContent("#t"))?.includes("a") === true,
      },
      {
        id: "keyboard-enter",
        description: "pressing Enter records input value",
        act: async (p) => {
          await p.fill("#name", "cav");
          await p.press("#name", "Enter");
        },
        assert: async (p) => (await p.getAttribute("body", "data-enter")) === "cav",
      },
    ],
  });
  assert.equal(result.passed, true, JSON.stringify(result.blockers));
  assert.equal(result.checks.length, 4);
  assert.ok(result.checks.every((c) => c.passed));
});

test("UI interaction verification fails closed on a wrong post-state", async () => {
  const dir = `${REPO}/.pi-eng/cav/ui-test-fail`;
  const url = await writeHarness(dir, APP);
  const result = await verifyUiInteractions({
    url,
    artifactsDir: `${dir}/out`,
    checks: [
      {
        id: "wrong-state",
        description: "counter should be 99 (deliberately wrong)",
        act: async (p) => p.click("#counter"),
        assert: async (p) => (await p.textContent("#counter")) === "99",
      },
    ],
  });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.some((b) => b.includes("wrong-state")));
});
