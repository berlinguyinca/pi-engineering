/**
 * Phase 5 parity (review, verify, tournament) between the legacy path and the OMP worker path, by deterministic
 * evidence only: same fixtures, same scripted worker behavior, the SAME ledger and verifier on both paths, compared
 * after the golden normalizer. Gated on OMP_BIN (real omp, offline scripted model).
 *
 * The golden gate (legacy-golden.test.ts, PARITY_PATH=omp) already pins the engineer/review/tournament scenarios it
 * lists; this file adds what it does not: /verify after a candidate an OMP worker produced, and tournament winner
 * selection across several leg-outcome mixes.
 */
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
import { createNormalizer, normalizeEvents, stableStringify } from "../support/ledgerNormalizer.ts";
import { type ParityPath, legacyPath, ompPath } from "../support/legacyGolden.ts";
import { type EngineerScript, realOmpEnv } from "../support/ompOffline.ts";

const skip = realOmpEnv() ? false : "UNVERIFIED: OMP_BIN not set; no real omp available";

const ADD_OK = "export function add(a, b) {\n  return a + b;\n}\n";
const ADD_BAD = "export function add(a, b) {\n  return a - b;\n}\n";
const ADD_NOISY = "export function add(a, b) {\n  return a + b + 0;\n}\n";
const GOAL = "Implement add(a, b) to return the sum of a and b";
const NOISE = [{ severity: "high", claim: "unnecessary +0 noise", evidence: "diff://src/add.js" }];

const scoutOk = () => ({ status: "completed" as const, summary: "scouted", details: {} });

/** Legacy FakeWorkerExecutor equivalent of an {@link EngineerScript}: leg contents by implementer run, reviews by round. */
function fakeFor(legs: (run: number) => string, findings: (round: number) => unknown[]): FakeWorkerExecutor {
  let run = 0;
  let round = 0;
  return new FakeWorkerExecutor({
    scout: scoutOk,
    implementer: async (req) => {
      run += 1;
      await writeFile(join(req.cwd, "src", "add.js"), legs(run), "utf8");
      return { status: "completed" as const, summary: "implemented", details: {} };
    },
    reviewer: () => {
      round += 1;
      const f = findings(round);
      return {
        status: "completed" as const,
        summary: f.length ? "material findings" : "clean",
        details: { findings: f },
      };
    },
  });
}

/**
 * The normalized ledger. Legacy itself records the losing candidates' `candidate.rejected` events in a run-to-run
 * varying order when several legs pass (observed legacy against legacy), so the position-dependent candidate id
 * is dropped here; WHICH candidates were rejected, and why, is compared order-independently by `rejectedOf`.
 */
async function normalized(path: ParityPath, root: string): Promise<unknown> {
  const norm = createNormalizer([await realpath(tmpdir()), root, await realpath(root)]);
  const events = JSON.parse(stableStringify(normalizeEvents(await path.readEvents(root), norm))) as Array<{
    type: string;
    facts: Record<string, unknown>;
  }>;
  for (const e of events) if (e.type === "candidate.rejected") delete e.facts.candidate_id;
  return events;
}

interface Seed {
  name: string;
  n: number;
  legs: (run: number) => string;
  findings: (round: number) => unknown[];
  winner: number;
}

// Four fixtures with different leg outcomes. `winner` is the leg index legacy must pick (asserted, so a
// regression in the fixture itself cannot make both paths agree on nonsense).
const SEEDS: Seed[] = [
  { name: "last-leg-wins", n: 3, legs: (r) => (r === 3 ? ADD_OK : ADD_BAD), findings: () => [], winner: 2 },
  {
    name: "first-leg-reviewed-out",
    n: 3,
    legs: (r) => (r === 1 ? ADD_NOISY : r === 2 ? ADD_OK : ADD_BAD),
    findings: (round) => (round === 1 ? NOISE : []),
    winner: 1,
  },
  { name: "all-legs-fail", n: 3, legs: () => ADD_BAD, findings: () => [], winner: -1 },
  {
    // Every leg passes verification; legs 1, 3 and 4 are reviewed out, so leg 2 is the only clean one.
    // (A tie among several clean passing legs is NOT deterministic on legacy itself: the winner varied between
    // runs of the same legacy code, so it cannot be a parity target.)
    name: "only-unflagged-leg-wins",
    n: 4,
    legs: () => ADD_OK,
    findings: (round) => (round === 2 ? [] : NOISE),
    winner: 1,
  },
];

/** Rejected candidates as sorted [entry index, reason] pairs: identity survives, event order does not matter. */
async function rejectedOf(
  path: ParityPath,
  root: string,
  entries: ReadonlyArray<{ candidate: { id: string } }>,
): Promise<Array<[number, string]>> {
  const events = await path.readEvents(root);
  return events
    .filter((e) => e.type === "candidate.rejected")
    .map((e): [number, string] => {
      const p = e.payload as { candidate_id: string; reason?: string };
      const index = entries.findIndex((en) => en.candidate.id === p.candidate_id);
      assert.notEqual(index, -1, `rejected candidate ${p.candidate_id} is one of the tournament entries`);
      // the reason names the winner by candidate id: say which entry instead
      const reason = (p.reason ?? "").replace(
        /CAND-\w+/g,
        (id) => `entry#${entries.findIndex((en) => en.candidate.id === id)}`,
      );
      return [index, reason];
    })
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
}

async function tournament(
  path: ParityPath,
  seed: Seed,
): Promise<{ summary: unknown; ledger: unknown; rejected: Array<[number, string]>; nonWinners: number[] }> {
  const fx = await makeFixtureRepo();
  try {
    const script: EngineerScript = {
      implement: (run) => ({ path: "src/add.js", content: seed.legs(run) }),
      review: (round) => ({ findings: seed.findings(round) }),
    };
    const rt = await path.openRuntime({ cwd: fx.root, worker: fakeFor(seed.legs, seed.findings), script });
    try {
      const report = await rt.tournament(GOAL, { n: seed.n });
      return {
        summary: {
          outcome: report.outcome,
          n_candidates: report.n_candidates,
          winner_index: report.entries.findIndex((e) => e.winner),
          entries: report.entries.map((e) => ({
            status: e.candidate.status,
            passed: e.outcome.passed,
            failed_stage: e.outcome.failedStage,
            findings: e.findings.length,
            review_completed: e.reviewCompleted,
            winner: e.winner,
          })),
          evidence_count: report.evidence_ids.length,
        },
        ledger: await normalized(path, fx.root),
        rejected: await rejectedOf(path, fx.root, report.entries),
        nonWinners: report.entries.flatMap((e, i) => (e.winner ? [] : [i])),
      };
    } finally {
      await rt.close();
    }
  } finally {
    await fx.cleanup();
  }
}

describe("tournament winner selection: omp path equals legacy", { skip }, () => {
  for (const seed of SEEDS) {
    it(`${seed.name} (n=${seed.n})`, async () => {
      const legacy = await tournament(legacyPath, seed);
      const omp = await tournament(ompPath, seed);
      assert.equal((legacy.summary as { winner_index: number }).winner_index, seed.winner, "fixture sanity");
      assert.deepEqual(omp.summary, legacy.summary);
      assert.deepEqual(omp.ledger, legacy.ledger, "ledger events, facts and actors are identical");
      assert.deepEqual(omp.rejected, legacy.rejected, "the same candidates are rejected, for the same reasons");
      assert.deepEqual(
        omp.rejected.map(([i]) => i),
        omp.nonWinners,
        "the rejected candidates are exactly the non-winning legs",
      );
    });
  }
});

/** engineer on `path`, then /verify on the resulting repository; returns the verify outcome and the whole ledger. */
async function engineerThenVerify(
  path: ParityPath,
  leg: string,
): Promise<{ verify: unknown; ledger: unknown; types: string[] }> {
  const fx = await makeFixtureRepo();
  try {
    const script: EngineerScript = { implement: leg, review: () => ({ findings: [] }) };
    const rt = await path.openRuntime({
      cwd: fx.root,
      worker: fakeFor(
        () => leg,
        () => [],
      ),
      script,
    });
    try {
      const report = await rt.engineer(GOAL);
      const { profile, outcome } = await path.verify(rt);
      const events = await path.readEvents(fx.root);
      return {
        verify: {
          engineer: { outcome: report.outcome, rounds: report.rounds },
          profile: profile.name,
          passed: outcome.passed,
          failedStage: outcome.failedStage,
          stages: outcome.stages.map((s) => ({ name: s.stage.name, passed: s.passed, exitCode: s.exitCode })),
          evidence: outcome.evidence.map((e) => ({
            type: e.type,
            status: e.status,
            exit_code: e.exit_code,
            trust: e.trust,
          })),
        },
        ledger: await normalized(path, fx.root),
        types: events.map((e) => e.type),
      };
    } finally {
      await rt.close();
    }
  } finally {
    await fx.cleanup();
  }
}

describe("verify after an engineer run: omp path equals legacy", { skip }, () => {
  for (const [name, leg, passes] of [
    ["omp-produced candidate passes /verify", ADD_OK, true],
    ["omp-produced candidate that fails /verify", ADD_BAD, false],
  ] as const) {
    it(name, async () => {
      const legacy = await engineerThenVerify(legacyPath, leg);
      const omp = await engineerThenVerify(ompPath, leg);
      assert.equal((omp.verify as { passed: boolean }).passed, passes, "verify outcome");
      assert.deepEqual(omp.verify, legacy.verify);
      assert.deepEqual(omp.types, legacy.types, "event-type sequence, evidence.recorded included");
      assert.deepEqual(omp.ledger, legacy.ledger);
      assert.ok(omp.types.includes("evidence.recorded"), "evidence was recorded");
    });
  }
});
