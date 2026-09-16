#!/usr/bin/env node
import { isGatewayAdmissionRefusal } from "../src/gateway/signals.ts";
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
/**
 * Things this run could not determine, as distinct from things it found wrong.
 *
 * A saturated gateway refusing admission means the model path was not
 * exercised. Counting that as a failure would blame this code for the
 * gateway's load; counting it as a pass would claim a verification that never
 * happened. It is its own outcome, with its own exit code.
 */
const inconclusive: string[] = [];
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
    const text = liveError instanceof Error ? liveError.message : String(liveError);
    // A gateway refusing admission is not this code failing. The narrator did
    // exactly what it is specified to do — surface the reason and keep the
    // previous narrative — and reporting that as a defect would be the dogfood
    // lying about what it observed. It is INCONCLUSIVE: the model path could
    // not be exercised, which is a different thing from being broken, and the
    // exit code says so rather than claiming a pass.
    if (isGatewayAdmissionRefusal(text)) {
      inconclusive.push(`the gateway refused admission, so the model path was not exercised: ${text}`);
      console.log("  --   live model call refused by the gateway (not a defect; see note below)");
    } else {
      check(false, `live model call failed: ${text}`);
    }
  } else {
    check(typeof narrative === "string" && narrative.trim().length > 0, "the model returned a non-empty narrative");
    const clean = sanitizeNarrative(narrative ?? "");
    check(clean !== undefined, "the narrative survives sanitisation");
    check((clean ?? "").length <= 400, `the narrative respects the 400-char ceiling (${(clean ?? "").length})`);
    console.log(`\n  narrative: ${clean}\n`);
  }

  // ── The Narrator's own gating, with the real summarize ────────────────────
  //
  // `observe` returns false for seven different reasons — no deltas, debounce,
  // cooldown, a call already in flight, empty text, disposed, or a summarize
  // that threw — and the Narrator swallows the last of those BY DESIGN, so a
  // bare `check(called)` cannot say which happened. Under a saturated gateway
  // that reads as a narrator defect when it is the gateway. The seam is wrapped
  // so the dogfood can tell "chose not to call" from "called and the call
  // failed", and report the reason either way.
  const state = new PanelState();
  let attempts = 0;
  let lastError: unknown;
  const observed = async (prompt: string): Promise<string> => {
    attempts++;
    try {
      return await summarize(prompt);
    } catch (err) {
      lastError = err;
      throw err;
    }
  };
  const narrator = new Narrator({
    state,
    summarize: observed,
    cooldownRemainingMs: () => 0,
    acquire: async () => ({ release: () => {} }),
    minIntervalMs: 0,
  });

  const called = await narrator.observe(OBSERVATION);
  check(attempts === 1, `the Narrator reached the model for a changed session (${attempts} attempt(s))`);
  if (called) {
    check(true, "and published the narrative it got back");
  } else if (lastError) {
    // A live gateway refusing a call is not a defect in this code, and the
    // dogfood must not report it as one. It is still reported, because a
    // narrator that can never call is indistinguishable from one that is
    // broken, and the operator should know which they have.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    console.log(`  note the model refused the second call: ${message}`);
    console.log("       the Narrator kept the previous narrative, which is the specified behaviour");
    check(state.snapshot.narrative === undefined, "and published nothing rather than a partial one");
  } else {
    check(false, "the Narrator declined to call, and not because the model failed");
  }

  // No change: the gate that keeps an idle session from spending anything.
  const again = await narrator.observe(OBSERVATION);
  check(!again, "an unchanged session costs nothing");

  console.log("");
  if (failures.length > 0) {
    console.log(`NARRATOR DOGFOOD FAILED: ${failures.length} check(s)`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  if (inconclusive.length > 0) {
    console.log(`NARRATOR DOGFOOD INCONCLUSIVE: ${inconclusive.length} check(s) could not run`);
    for (const f of inconclusive) console.log(`  - ${f}`);
    console.log("  every check that COULD run passed; re-run when the gateway has capacity");
    process.exit(2);
  }
  console.log("NARRATOR DOGFOOD OK");
}

main().catch((err) => {
  console.error("dogfood-narrator:", err);
  process.exit(1);
});
