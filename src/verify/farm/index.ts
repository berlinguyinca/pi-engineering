/**
 * Verification farm (spec §15, backlog B-107).
 *
 * Composable, deterministic verification depth beyond a single test run:
 * test-impact analysis, adversarial test generation (machine-gated),
 * property-based scaffolding, mutation testing, differential testing, and
 * performance evidence. All modules are dependency-free and inject their
 * harnesses, so they are unit-testable and usable standalone.
 */
export * from "./TestImpact.ts";
export * from "./Adversarial.ts";
export * from "./PropertyTest.ts";
export * from "./Mutation.ts";
export * from "./Differential.ts";
export * from "./Performance.ts";
