/**
 * Quarantine gate (autospec R-WATCH, issue #147).
 *
 * A pure, side-effect-free helper that applies a set of quarantined test names
 * to a verification outcome's stages. Any stage whose `tests` array contains a
 * quarantined test name is forced to `passed: false` (a quarantined test can
 * never contribute to green) and every matching name is collected, in
 * stage/test encounter order, into `quarantinedHits`. All other stages are
 * returned untouched. The result's `passed` is the AND of every stage's passed
 * value after gating (a stage with no `tests` field counts by its own `passed`),
 * so an empty stage list gates to `true`.
 *
 * Unlike {@link TestQuarantine.applyToOutcome} (which persists stall records and
 * reads them from the state dir), this function takes the quarantined names as
 * an argument and performs no I/O and no external state: callers own how the
 * set is discovered.
 */

/** A minimal verification stage the gate understands. */
export interface QuarantineStage {
  name: string;
  passed: boolean;
  /** Test names this stage ran; absent stages are judged purely by their own `passed`. */
  tests?: readonly string[];
}

/** The verification outcome the gate consumes. */
export interface QuarantineOutcome {
  passed: boolean;
  stages: readonly QuarantineStage[];
}

/** The gated result. */
export interface QuarantineResult {
  stages: QuarantineStage[];
  /** Quarantined test names, in stage/test encounter order, that forced a stage red. */
  quarantinedHits: string[];
  /** AND of every stage's passed value after gating. */
  passed: boolean;
}

/**
 * Applies the quarantine gate. Pure: mutates neither argument, performs no I/O
 * and touches no external state. Unaffected stages are returned by reference.
 */
export function applyQuarantine(outcome: QuarantineOutcome, quarantined: readonly string[]): QuarantineResult {
  const quarantinedSet = new Set(quarantined);
  const quarantinedHits: string[] = [];
  const stages = outcome.stages.map((stage) => {
    const tests = stage.tests ?? [];
    const hits = tests.filter((name) => quarantinedSet.has(name));
    if (hits.length === 0) return stage;
    quarantinedHits.push(...hits);
    return { ...stage, passed: false };
  });
  const passed = stages.every((stage) => stage.passed);
  return { stages, quarantinedHits, passed };
}
