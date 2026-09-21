/**
 * BAR root-cause clustering and dependency ordering
 * (steps .../root-cause-analysis, .../repair-engine).
 *
 * Clusters requirements by shared evidence (shared source paths, shared
 * blockers, shared runtime surfaces) into likely root causes. Builds a
 * dependency ordering (a deterministic topological sort over requirement
 * dependencies plus a root-cause grouping) that repair campaigns consume.
 */

import type { RequirementRecord } from "./types.ts";

export interface RootCauseCluster {
  cluster: string;
  requirements: string[];
  evidence: string[];
}

/** Group requirements into likely root-cause clusters by shared evidence. */
export function clusterRootCauses(requirements: RequirementRecord[]): RootCauseCluster[] {
  // Map each source path -> requirements that reference it.
  const bySource = new Map<string, string[]>();
  for (const req of requirements) {
    for (const m of req.sourceMappings) {
      const list = bySource.get(m.path) ?? [];
      list.push(req.id);
      bySource.set(m.path, list);
    }
  }
  const clusters: RootCauseCluster[] = [];
  const seen = new Set<string>();
  for (const [path, reqs] of bySource) {
    const unique = [...new Set(reqs)];
    if (unique.length < 2) continue;
    const key = unique.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    clusters.push({
      cluster: `shared-source:${path}`,
      requirements: unique,
      evidence: [`source file ${path} referenced by ${unique.length} requirements`],
    });
  }
  // Clusters by shared blockers.
  const byBlocker = new Map<string, string[]>();
  for (const req of requirements) {
    for (const b of req.blockers) {
      const list = byBlocker.get(b) ?? [];
      list.push(req.id);
      byBlocker.set(b, list);
    }
  }
  for (const [blocker, reqs] of byBlocker) {
    const unique = [...new Set(reqs)];
    if (unique.length < 2) continue;
    clusters.push({
      cluster: `shared-blocker:${blocker}`,
      requirements: unique,
      evidence: [`blocker "${blocker}" affects ${unique.length} requirements`],
    });
  }
  // Stable order.
  clusters.sort((a, b) => a.cluster.localeCompare(b.cluster));
  return clusters;
}

/**
 * Dependency ordering. Deterministic topological sort over explicit
 * requirement dependencies. Cycles are broken by a stable tie-break so the
 * output is reproducible; unresolved dependencies are reported separately.
 */
export function buildDependencyOrder(requirements: RequirementRecord[]): {
  order: string[];
  unresolved: string[];
} {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const visited = new Set<string>();
  const stack = new Set<string>();
  const order: string[] = [];
  const unresolved = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (stack.has(id)) {
      unresolved.add(id);
      return;
    }
    stack.add(id);
    const req = byId.get(id);
    for (const dep of req?.dependencies ?? []) {
      if (!byId.has(dep)) unresolved.add(dep);
      else visit(dep);
    }
    stack.delete(id);
    visited.add(id);
    order.push(id);
  };

  // Deterministic seed order by id so the result is reproducible.
  const sorted = [...byId.keys()].sort();
  for (const id of sorted) visit(id);
  return { order, unresolved: [...unresolved].sort() };
}
