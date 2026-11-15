/**
 * Ledger, custody, lease and fencing are untouched by the omp worker: for every scenario that runs workers,
 * the ledger event-type sequence recorded on the omp path equals the legacy golden's, event for event
 * (gated on OMP_BIN; real omp, offline scripted model). The full golden comparison (facts, actors, work item
 * and candidate ids) runs in legacy-golden.test.ts under PARITY_PATH=omp; this states the ledger invariant
 * on its own so a regression names it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { goldenName, ompPath, renderScenario, scenarios } from "../support/legacyGolden.ts";
import { realOmpEnv } from "../support/ompOffline.ts";

const skip = realOmpEnv() ? false : "UNVERIFIED: OMP_BIN not set; no real omp available";
const GOLDEN_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures", "legacy-golden");

interface Event {
  type: string;
  actor: string;
}
const ledgerOf = (json: string): Event[] => (JSON.parse(json) as { ledger?: Event[] }).ledger ?? [];

const WORKER_SCENARIOS = new Set(["engineer", "review", "plan", "tournament", "recovery"]);
const NO_WORKER = new Set(["plan / unknown-plan"]);

describe("ledger event-type sequence: omp path equals legacy", { skip }, () => {
  for (const s of scenarios.filter(
    (x) => WORKER_SCENARIOS.has(x.command) && !NO_WORKER.has(`${x.command} / ${x.scenario}`),
  )) {
    it(`${s.command} / ${s.scenario}`, async () => {
      const golden = ledgerOf(readFileSync(join(GOLDEN_DIR, goldenName(s)), "utf8"));
      const omp = ledgerOf(await renderScenario(s, ompPath));
      assert.ok(omp.length > 0 || golden.length === 0, "the omp path recorded a ledger");
      assert.deepEqual(
        omp.map((e) => e.type),
        golden.map((e) => e.type),
      );
      assert.deepEqual(
        omp.map((e) => e.actor),
        golden.map((e) => e.actor),
        "custody: the same actors write the same events",
      );
    });
  }
});
