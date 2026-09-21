/**
 * BAR (Brownfield Audit & Remediation) engine.
 *
 * Reconciles with the existing CAV architecture and Engineering Ledger rather
 * than replacing them: BAR adds the brownfield requirement/provenance/source-
 * map/immutable-baseline/root-cause-cluster/repair-campaign model on top of the
 * same append-only, role-gated evidence discipline. Historical success claims
 * are untrusted; reconstructed requirements begin UNKNOWN.
 */

export * from "./types.ts";
export * from "./store.ts";
export * from "./discovery.ts";
export * from "./executor.ts";
export * from "./cluster.ts";
export * from "./campaign.ts";
export * from "./reconcile.ts";
export * from "./baseline.ts";
export * from "./scope.ts";
export * from "./report.ts";

/** BAR data paths relative to a repo root. */
export function barPaths(repoRoot: string): { storeDir: string } {
  return { storeDir: `${repoRoot}/.pi-eng/bar` };
}
