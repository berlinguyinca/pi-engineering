import type { Task } from "../core/types.ts";

/**
 * Pure Task-DAG helpers (spec §11): topological ordering and write-scope
 * conflict detection. Kept dependency-free and deterministic so the scheduler
 * can be unit-tested without a worker or a live model.
 */

/**
 * Kahn topological sort. Returns tasks in an order where every task appears
 * after all of its dependencies. Throws on a dependency cycle or on a
 * dependency that references an unknown task id (an unsatisfiable plan).
 */
export function topoSort(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indegree.set(t.id, 0);
    dependents.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!byId.has(dep)) {
        throw new Error(`task ${t.id} depends on unknown task ${dep}`);
      }
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.get(dep)!.push(t.id);
    }
  }
  const queue: string[] = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const d of dependents.get(id) ?? []) {
      const deg = (indegree.get(d) ?? 0) - 1;
      indegree.set(d, deg);
      if (deg === 0) queue.push(d);
    }
  }
  if (order.length !== tasks.length) {
    const cycle = tasks.filter((t) => !order.includes(t.id)).map((t) => t.id);
    throw new Error(`task dependency cycle detected: ${cycle.join(", ")}`);
  }
  return order.map((id) => byId.get(id)!);
}

/** True when two tasks share an overlapping write scope (path-level conflict). */
export function tasksConflict(a: Task, b: Task): boolean {
  return a.scope_paths.some((p) => b.scope_paths.includes(p));
}

/** Resolve the set of tasks that become un-runnable if `failed` are blocked. */
export function blockedByFailure(tasks: Task[], failedIds: Set<string>): Task[] {
  const failed = new Set(failedIds);
  const out: Task[] = [];
  // Iteratively propagate: a task is blocked if any transitive dependency failed.
  const isBlocked = (t: Task): boolean => t.depends_on.some((d) => failed.has(d));
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (failed.has(t.id)) continue;
      if (isBlocked(t)) {
        failed.add(t.id);
        out.push(t);
        changed = true;
      }
    }
  }
  return out;
}
