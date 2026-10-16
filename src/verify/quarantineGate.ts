/**
 * Quarantine gate (autospec R-WATCH, issue #276).
 *
 * A pure, side-effect-free helper that applies a set of quarantined test names
 * to a verification outcome's stages. Any stage whose `tests` array contains a
 * quarantined test name is forced to `passed: false` (a quarantined test can
 * never contribute to green) and every matching test name is collected, in
 * stage/test encounter order and deduplicated (first-seen order), into
 * `quarantinedHits` — a quarantined test counts as a hit whatever its status
 * (pass, fail or skip). All other stages are returned untouched. The result's
 * `passed` is the AND of every stage's passed value after gating (a stage with
 * no `tests` field counts by its own `passed`), so an empty stage list gates to
 * `true`.
 *
 * Unlike {@link TestQuarantine.applyToOutcome} (which persists stall records and
 * reads them from the state dir), this function takes the quarantined names as
 * an argument and performs no I/O and no external state: callers own how the
 * set is discovered.
 */

/** A single test a verification stage ran. */
export interface QuarantineTest {
  name: string;
  status: "pass" | "fail" | "skip";
}

/** A minimal verification stage the gate understands. */
export interface QuarantineStage {
  name: string;
  passed: boolean;
  /** Tests this stage ran; absent stages are judged purely by their own `passed`. */
  tests?: QuarantineTest[];
}

/** The verification outcome the gate consumes. */
export interface QuarantineOutcome {
  stages: QuarantineStage[];
}

/** The gated result. */
export interface QuarantineResult {
  stages: QuarantineStage[];
  /** Quarantined test names, in stage/test encounter order, deduplicated. */
  quarantinedHits: string[];
  /** AND of every stage's passed value after gating. */
  passed: boolean;
}

/**
 * Applies the quarantine gate. Pure: mutates neither argument, performs no I/O
 * and touches no external state. Unaffected stages are returned by reference.
 */
export function applyQuarantine(outcome: QuarantineOutcome, quarantined: Set<string>): QuarantineResult {
  const quarantinedHits: string[] = [];
  const seen = new Set<string>();
  const stages = outcome.stages.map((stage) => {
    const tests = stage.tests ?? [];
    const hits = tests.filter((test) => quarantined.has(test.name));
    if (hits.length === 0) return stage;
    for (const hit of hits) {
      if (!seen.has(hit.name)) {
        seen.add(hit.name);
        quarantinedHits.push(hit.name);
      }
    }
    return { ...stage, passed: false };
  });
  const passed = stages.every((stage) => stage.passed);
  return { stages, quarantinedHits, passed };
}
