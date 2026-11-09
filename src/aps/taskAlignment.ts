/**
 * APS task-alignment deviation signals (T07): pure, deterministic, evidence-only.
 * Flags out-of-scope MUTATING writes, writes producing an artifact class the task
 * never declared, unauthorized new dependencies, task ids outside `declaredTasks`,
 * and acceptance stagnation; read-only investigation of unrelated files is
 * legitimate and stays silent. Evidence states observable facts.
 */
import { matchesGlob } from "../plannerWorker/contract.ts";
import { isMutatingTool } from "./types.ts";

export type AlignmentKind =
  | "out_of_scope_write"
  | "undeclared_artifact"
  | "unrelated_dependency"
  | "task_expansion"
  | "acceptance_stagnation";
/** What the operator declared the task would produce, before the run (the artifact contract). */
export interface DeclaredArtifact {
  kind: "source" | "test" | "docs";
  pathPattern?: string;
}
export interface AlignmentSignal {
  kind: AlignmentKind;
  subject: string;
  iteration: number;
  evidence: string;
  taskId?: string;
}
export interface TaskAction {
  iteration: number;
  tool: string;
  target?: string;
  taskId?: string;
  mutating: boolean;
  newDependency?: string;
}
export interface TaskAlignmentInput {
  allowedScope: readonly string[];
  declaredTasks: readonly string[];
  allowedDependencies: readonly string[];
  actions: readonly TaskAction[];
  declaredArtifacts?: readonly DeclaredArtifact[];
  acceptance?: { criteria: readonly string[]; progressedAtIteration: Record<string, number> };
  stagnationIterations?: number;
}

/** Artifact class of a path, by this repository's own layout conventions. */
const artifactClass = (path: string): "source" | "test" | "docs" =>
  path.startsWith("test/") || path.endsWith(".test.ts")
    ? "test"
    : path.startsWith("docs/") || path.endsWith(".md")
      ? "docs"
      : "source";
const contractOf = (declared: readonly DeclaredArtifact[]): string =>
  declared.map((d) => (d.pathPattern ? `${d.kind} ${d.pathPattern}` : d.kind)).join(", ");

const DEFAULT_STAGNATION_ITERATIONS = 10; // fallback for absent or malformed stagnationIterations
const limitOf = (value: number | undefined): number =>
  Number.isInteger(value) && value !== undefined && value > 0 ? value : DEFAULT_STAGNATION_ITERATIONS;
const listed = (items: readonly string[], none: string): string => (items.length > 0 ? items.join(", ") : none);

/** Deviation signals for a run, ordered by kind, then subject, then first observation. */
export function evaluateTaskAlignment(input: TaskAlignmentInput): AlignmentSignal[] {
  const limit = limitOf(input.stagnationIterations);
  const scope = input.allowedScope ?? [];
  const declared = input.declaredTasks ?? [];
  const actions = input.actions ?? [];
  const declaredArtifacts = input.declaredArtifacts ?? [];
  const deps = (input.allowedDependencies ?? []).map((d) => d.trim().toLowerCase()).filter((d) => d !== "");
  const hits: AlignmentSignal[] = [];
  let observed = Number.NEGATIVE_INFINITY;
  for (const a of actions) {
    if (Number.isFinite(a.iteration)) observed = Math.max(observed, a.iteration);
    const target = a.target?.trim();
    const mutating = a.mutating ?? isMutatingTool(a.tool);
    if (
      mutating &&
      target &&
      declaredArtifacts.length > 0 &&
      !declaredArtifacts.some((d) =>
        d.pathPattern === undefined ? d.kind === artifactClass(target) : matchesGlob(target, d.pathPattern),
      )
    )
      hits.push({
        kind: "undeclared_artifact",
        subject: target,
        iteration: a.iteration,
        taskId: a.taskId,
        evidence: `mutating ${a.tool} to ${target} at iteration ${a.iteration} produces a ${artifactClass(target)} artifact the task did not declare (declared: ${contractOf(declaredArtifacts)})`,
      });
    if (mutating && target && !scope.some((glob) => matchesGlob(target, glob)))
      hits.push({
        kind: "out_of_scope_write",
        subject: target,
        iteration: a.iteration,
        taskId: a.taskId,
        evidence: `mutating ${a.tool} to ${target} at iteration ${a.iteration} matches no allowed scope (${listed(scope, "none declared, so nothing is authorized")})`,
      });
    const dep = a.newDependency?.trim();
    if (dep && !deps.includes(dep.toLowerCase()))
      hits.push({
        kind: "unrelated_dependency",
        subject: dep,
        iteration: a.iteration,
        taskId: a.taskId,
        evidence: `new dependency ${dep} added at iteration ${a.iteration}; authorized: ${listed(deps, "none")}`,
      });
    if (a.taskId && !declared.includes(a.taskId))
      hits.push({
        kind: "task_expansion",
        subject: a.taskId,
        iteration: a.iteration,
        taskId: a.taskId,
        evidence: `task ${a.taskId} observed at iteration ${a.iteration}; declared tasks: ${listed(declared, "none")}`,
      });
  }
  const acceptance = input.acceptance;
  if (acceptance && acceptance.criteria.length > 0 && actions.length > 0) {
    const marks = acceptance.criteria
      .map((c) => acceptance.progressedAtIteration[c])
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    const last = marks.length > 0 ? Math.max(...marks) : undefined;
    const stale = acceptance.criteria
      .filter((c) => {
        const at = acceptance.progressedAtIteration[c];
        return at === undefined || observed - at >= limit;
      })
      .sort();
    if (stale.length > 0 && (last === undefined || observed - last >= limit))
      hits.push({
        kind: "acceptance_stagnation",
        subject: stale.join(","),
        iteration: observed,
        evidence: `${stale.length} of ${acceptance.criteria.length} criteria (${stale.join(", ")}) unadvanced for ${limit} iterations; last recorded progress ${last === undefined ? "never recorded" : `iteration ${last}`}; actions observed through iteration ${observed}`,
      });
  }
  hits.sort((a, b) => a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject) || a.iteration - b.iteration);
  const seen = new Set<string>();
  return hits.filter((s) => {
    const key = `${s.kind}\u0000${s.subject}`;
    const fresh = !seen.has(key);
    seen.add(key);
    return fresh;
  });
}
