#!/usr/bin/env node
/**
 * Narrator dogfood: make the panel's session-summary tab produce a real
 * narrative from a real model, once.
 *
 * This is the one part of the panel that has never been observed working. Its
 * logic is covered by tests against an injected fake, and `Narrator` swallows a
 * `summarize` failure by design (the specified behaviour is "keep the previous
 * narrative"), which means the model path could be completely dead and every
 * test would still pass. Only a live call settles it.
 *
 * Costs one small model call. The narrator is off by default in sessions
 * (PI_PANEL_NARRATOR), so this is the intended way to exercise it.
 *
 *   node scripts/dogfood-narrator.ts [--verbose]
 */
import { PanelState } from "../src/panel/PanelState.ts";
import { Narrator } from "../src/panel/narrator/Narrator.ts";
import { buildNarrativePrompt, computeDeltas, sanitizeNarrative } from "../src/panel/narrator/deltas.ts";
import { createSummarize } from "../src/panel/narrator/summarize.ts";

const verbose = process.argv.includes("--verbose");
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

/** A session arc resembling this repo's actual recent work. */
const OBSERVATION = {
  workItemId: "wi-gateway-wait",
  goal: "stop a saturated model gateway from killing the interactive turn",
  phase: "verifying",
  files: [
    "src/gateway/streamRetry.ts",
    "src/gateway/installStreamRetry.ts",
    "src/gateway/AdmissionController.ts",
    "extensions/index.ts",
    "test/integration/gateway-stream-retry-registry.test.ts",
  ],
};

async function main(): Promise<void> {
  console.log("narrator dogfood");

  // ── The prompt the model would actually receive ───────────────────────────
  const deltas = computeDeltas(undefined, OBSERVATION);
  const prompt = buildNarrativePrompt(deltas, undefined);
  check(deltas.length > 0, `${deltas.length} deltas observed from a fresh session`);
  check(prompt.length > 0, "a prompt was built");
  if (verbose) console.log(`\n--- prompt ---\n${prompt}\n---\n`);

  // ── The live call ─────────────────────────────────────────────────────────
  const summarize = createSummarize({});
  let narrative: string | undefined;
  let liveError: unknown;
  try {
    narrative = await summarize(prompt);
  } catch (err) {
    liveError = err;
  }

  if (liveError) {
    check(false, `live model call failed: ${liveError instanceof Error ? liveError.message : String(liveError)}`);
  } else {
    check(typeof narrative === "string" && narrative.trim().length > 0, "the model returned a non-empty narrative");
    const clean = sanitizeNarrative(narrative ?? "");
    check(clean !== undefined, "the narrative survives sanitisation");
    check((clean ?? "").length <= 400, `the narrative respects the 400-char ceiling (${(clean ?? "").length})`);
    console.log(`\n  narrative: ${clean}\n`);
  }

  // ── The Narrator's own gating, with the real summarize ────────────────────
  const state = new PanelState();
  const narrator = new Narrator({
    state,
    summarize,
    cooldownRemainingMs: () => 0,
    acquire: async () => ({ release: () => {} }),
    minIntervalMs: 0,
  });

  const called = await narrator.observe(OBSERVATION);
  check(called, "the Narrator made a model call for a changed session");

  // No change: the gate that keeps an idle session from spending anything.
  const again = await narrator.observe(OBSERVATION);
  check(!again, "an unchanged session costs nothing");

  console.log("");
  if (failures.length > 0) {
    console.log(`NARRATOR DOGFOOD FAILED: ${failures.length} check(s)`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("NARRATOR DOGFOOD OK");
}

main().catch((err) => {
  console.error("dogfood-narrator:", err);
  process.exit(1);
});
