import type { OrchestrationTask, TaskKind, WorkspaceManifest } from "./types.ts";

export type WorksetValidationCode =
  | "UNKNOWN_REPOSITORY"
  | "MISSING_REPOSITORY_BINDING"
  | "WRITE_DOMAIN_OUTSIDE_REPOSITORY"
  | "UNCOVERED_ACCEPTANCE"
  | "UNKNOWN_ACCEPTANCE"
  | "UNKNOWN_DEPENDENCY"
  | "DUPLICATE_TASK_ID"
  | "CYCLIC_DEPENDENCY"
  | "DECOMPOSITION_REQUIRED"
  | "TASK_BUDGET_EXCEEDED"
  | "INVALID_TASK_BUDGET"
  | "INVALID_CHECKPOINT_POLICY"
  | "INVALID_WRITE_DOMAIN"
  | "CROSS_REPOSITORY_MUTATION_UNSUPPORTED";

export class WorksetValidationError extends Error {
  readonly name = "WorksetValidationError";
  readonly code: WorksetValidationCode;
  readonly action: string;

  constructor(code: WorksetValidationCode, message: string, action: string) {
    super(`${code}: ${message}. ${action}`);
    this.code = code;
    this.action = action;
  }
}

export interface WorksetPolicy {
  maxDeliverablesPerTask: number;
  /**
   * Hard wall-clock cap per task execution (policy `workers.execution_budget_ms`).
   * 0 means no cap: planned tasks get no default budget, and a positive
   * explicit `execution_budget_ms` is accepted as-is. A positive value is both
   * the default budget of a planned task and the largest one allowed.
   */
  maxTaskBudgetMs: number;
}

export const DEFAULT_WORKSET_POLICY: WorksetPolicy = {
  maxDeliverablesPerTask: 4,
  maxTaskBudgetMs: 0,
};

/**
 * True when a task's `execution_budget_ms` sets a hard deadline. Absent and 0
 * both mean "no execution budget", never "already expired".
 */
export function hasExecutionBudget(budgetMs: number | undefined): budgetMs is number {
  return budgetMs !== undefined && budgetMs !== 0;
}

export interface WorksetTask {
  task_id: string;
  kind: TaskKind;
  repo_id?: string;
  depends_on: string[];
  mutates_repo: boolean;
  write_domains: string[];
  acceptance_ids?: string[];
  deliverables?: string[];
  execution_budget_ms?: number;
  checkpoint_policy?: { activity_milestone: number; before_deadline_ms: number };
}

export interface ValidateWorksetInput {
  manifest: WorkspaceManifest;
  acceptanceIds: string[];
  tasks: WorksetTask[];
  policy?: Partial<WorksetPolicy>;
}

export function canonicalizeWriteDomain(domain: string): string {
  const normalized = domain.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new WorksetValidationError(
      "INVALID_WRITE_DOMAIN",
      `absolute write domain ${domain} is not repository-relative`,
      "Use a normalized path relative to the bound repository",
    );
  }
  const segments = normalized.replace(/\/$/, "").split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new WorksetValidationError(
      "INVALID_WRITE_DOMAIN",
      `write domain ${domain} contains empty, dot, or traversal components`,
      "Use canonical repository-relative path segments without . or ..",
    );
  }
  return segments.join("/");
}

function domainSegments(domain: string): string[] {
  return canonicalizeWriteDomain(domain).split("/");
}

function domainWithin(requested: string, authorized: string): boolean {
  const target = domainSegments(requested);
  const allowed = domainSegments(authorized);
  if (allowed.length === 1 && allowed[0] === "**") return true;
  if (target.length === 1 && target[0] === "**") return false;
  const recursive = allowed.at(-1) === "**";
  const prefix = recursive ? allowed.slice(0, -1) : allowed;
  if (!recursive && target.length !== prefix.length) return false;
  if (target.length < prefix.length) return false;
  return prefix.every((segment, index) => target[index] === segment);
}

function assertAcyclic(tasks: WorksetTask[]): void {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) {
      throw new WorksetValidationError(
        "CYCLIC_DEPENDENCY",
        `task dependency cycle includes ${taskId}`,
        "Split or reorder the work so every dependency graph is acyclic",
      );
    }
    if (visited.has(taskId)) return;
    const task = byId.get(taskId);
    if (!task) return;
    visiting.add(taskId);
    for (const dependency of task.depends_on) {
      if (!byId.has(dependency)) {
        throw new WorksetValidationError(
          "UNKNOWN_DEPENDENCY",
          `${taskId} depends on unknown task ${dependency}`,
          "Reference a task in this workset or remove the dependency",
        );
      }
      visit(dependency);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.task_id);
}

/** Validate a complete planner workset before any executable task is dispatched. */
export function validateWorkset(input: ValidateWorksetInput): WorksetTask[] {
  const policy = { ...DEFAULT_WORKSET_POLICY, ...input.policy };
  const repositories = new Map(input.manifest.repositories.map((repository) => [repository.repoId, repository]));
  const knownAcceptance = new Set(input.acceptanceIds);
  const tasks = input.tasks.map((task) => ({
    ...task,
    write_domains: task.write_domains.map(canonicalizeWriteDomain),
  }));

  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.task_id)) {
      throw new WorksetValidationError(
        "DUPLICATE_TASK_ID",
        `task ID ${task.task_id} appears more than once`,
        "Assign every original planner task a unique stable ID",
      );
    }
    taskIds.add(task.task_id);
  }
  assertAcyclic(tasks);
  const mutatingRepositories = new Set(
    tasks.filter((task) => task.mutates_repo).flatMap((task) => (task.repo_id ? [task.repo_id] : [])),
  );
  if (mutatingRepositories.size > 1) {
    throw new WorksetValidationError(
      "CROSS_REPOSITORY_MUTATION_UNSUPPORTED",
      `mutating workset spans ${[...mutatingRepositories].sort().join(", ")}`,
      "Run a separate repository-scoped mission; coordinated cross-repository publication is deferred beyond Slice 1",
    );
  }
  for (const task of tasks) {
    if (task.kind === "aggregation" && task.mutates_repo) {
      throw new WorksetValidationError(
        "CROSS_REPOSITORY_MUTATION_UNSUPPORTED",
        `aggregation task ${task.task_id} requests mutation`,
        "Use one repository-scoped mutating task per repository; Slice 1 aggregation must be read-only",
      );
    }
    if (task.kind !== "aggregation" && !task.repo_id) {
      throw new WorksetValidationError(
        "MISSING_REPOSITORY_BINDING",
        `task ${task.task_id} has no repoId`,
        "Bind the executable task to exactly one repository",
      );
    }
    if (task.repo_id && !repositories.has(task.repo_id)) {
      throw new WorksetValidationError(
        "UNKNOWN_REPOSITORY",
        `task ${task.task_id} references ${task.repo_id}`,
        "Choose a repoId from the authorized workspace manifest",
      );
    }
    if (input.manifest.repositories.length > 1 && task.mutates_repo && task.write_domains.includes("**")) {
      throw new WorksetValidationError(
        "DECOMPOSITION_REQUIRED",
        `task ${task.task_id} has a broad ** scope in a multi-repository mission`,
        "Split the work into bounded repository-scoped tasks before dispatch",
      );
    }
    if ((task.deliverables?.length ?? 0) > policy.maxDeliverablesPerTask) {
      throw new WorksetValidationError(
        "DECOMPOSITION_REQUIRED",
        `task ${task.task_id} has ${task.deliverables?.length ?? 0} deliverables`,
        `Split it into tasks of at most ${policy.maxDeliverablesPerTask} deliverables`,
      );
    }
    const budget = task.execution_budget_ms;
    if (hasExecutionBudget(budget) && (!Number.isFinite(budget) || budget < 0)) {
      throw new WorksetValidationError(
        "INVALID_TASK_BUDGET",
        `task ${task.task_id} has invalid execution budget ${task.execution_budget_ms}`,
        "Use a finite positive execution budget, or omit it (or 0) for no budget",
      );
    }
    if (policy.maxTaskBudgetMs > 0 && hasExecutionBudget(budget) && budget > policy.maxTaskBudgetMs) {
      throw new WorksetValidationError(
        "TASK_BUDGET_EXCEEDED",
        `task ${task.task_id} budget ${task.execution_budget_ms}ms exceeds ${policy.maxTaskBudgetMs}ms`,
        "Reduce the budget or split the task into checkpointed deliverables",
      );
    }
    const checkpointPolicy = task.checkpoint_policy;
    if (
      !checkpointPolicy ||
      !Number.isInteger(checkpointPolicy.activity_milestone) ||
      checkpointPolicy.activity_milestone <= 0 ||
      !Number.isFinite(checkpointPolicy.before_deadline_ms) ||
      checkpointPolicy.before_deadline_ms <= 0 ||
      // Without a budget there is no deadline to checkpoint ahead of.
      (hasExecutionBudget(budget) && checkpointPolicy.before_deadline_ms >= budget)
    ) {
      throw new WorksetValidationError(
        "INVALID_CHECKPOINT_POLICY",
        `task ${task.task_id} checkpoint cadence is outside its execution budget`,
        "Use a positive integer activity milestone and a finite lead time smaller than the task budget",
      );
    }
    const repository = task.repo_id ? repositories.get(task.repo_id) : undefined;
    if (
      task.mutates_repo &&
      repository &&
      task.write_domains.some(
        (domain) => !repository.writableDomains.some((authorized) => domainWithin(domain, authorized)),
      )
    ) {
      throw new WorksetValidationError(
        "WRITE_DOMAIN_OUTSIDE_REPOSITORY",
        `task ${task.task_id} requests ${task.write_domains.join(", ")} outside ${repository.repoId}`,
        `Restrict writes to ${repository.writableDomains.join(", ")}`,
      );
    }
    for (const acceptanceId of task.acceptance_ids ?? []) {
      if (!knownAcceptance.has(acceptanceId)) {
        throw new WorksetValidationError(
          "UNKNOWN_ACCEPTANCE",
          `task ${task.task_id} covers unknown acceptance ID ${acceptanceId}`,
          "Use a stable acceptance ID declared by the mission",
        );
      }
    }
  }

  const covered = new Set(tasks.flatMap((task) => task.acceptance_ids ?? []));
  const uncovered = input.acceptanceIds.filter((acceptanceId) => !covered.has(acceptanceId));
  if (uncovered.length > 0) {
    throw new WorksetValidationError(
      "UNCOVERED_ACCEPTANCE",
      `no task covers ${uncovered.join(", ")}`,
      "Assign every material acceptance criterion to at least one bounded task",
    );
  }
  return tasks;
}

export function decompositionInput(
  tasks: WorksetTask[],
  manifest: WorkspaceManifest,
  policy: Partial<WorksetPolicy> = {},
): {
  required: boolean;
  maxDeliverablesPerTask: number;
  repositoryIds: string[];
  tasks: Array<{ taskId: string; repoId: string | null; deliverables: string[] }>;
} {
  const resolved = { ...DEFAULT_WORKSET_POLICY, ...policy };
  const repositoryIds = manifest.repositories.map((repository) => repository.repoId).sort();
  return {
    required:
      repositoryIds.length > 1 ||
      tasks.some((task) => (task.deliverables?.length ?? 0) > resolved.maxDeliverablesPerTask),
    maxDeliverablesPerTask: resolved.maxDeliverablesPerTask,
    repositoryIds,
    tasks: tasks
      .map((task) => ({
        taskId: task.task_id,
        repoId: task.repo_id ?? null,
        deliverables: [...(task.deliverables ?? [])].sort(),
      }))
      .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)),
  };
}

/** Deterministically split an oversized task into dependency-ordered deliverable chunks. */
export function splitWorksetDeliverables<T extends WorksetTask>(
  tasks: T[],
  maxDeliverablesPerTask: number,
): { tasks: T[]; finalTaskIdByOriginal: Map<string, string> } {
  if (!Number.isInteger(maxDeliverablesPerTask) || maxDeliverablesPerTask <= 0) {
    throw new Error("maxDeliverablesPerTask must be a positive integer");
  }
  const occupied = new Set<string>();
  for (const task of tasks) {
    if (occupied.has(task.task_id)) {
      throw new WorksetValidationError(
        "DUPLICATE_TASK_ID",
        `task ID ${task.task_id} appears more than once`,
        "Assign every original planner task a unique stable ID",
      );
    }
    occupied.add(task.task_id);
  }
  const split: T[] = [];
  const finalTaskIdByOriginal = new Map<string, string>();
  for (const task of tasks) {
    const deliverables = task.deliverables ?? [];
    if (deliverables.length <= maxDeliverablesPerTask) {
      split.push({ ...task, depends_on: [...task.depends_on] });
      finalTaskIdByOriginal.set(task.task_id, task.task_id);
      continue;
    }
    let previous: string | undefined;
    for (let index = 0; index < deliverables.length; index += maxDeliverablesPerTask) {
      const part = index / maxDeliverablesPerTask + 1;
      const baseId = `${task.task_id}::part:${part}`;
      let taskId = baseId;
      let collision = 1;
      while (occupied.has(taskId)) taskId = `${baseId}:${collision++}`;
      occupied.add(taskId);
      const chunk = deliverables.slice(index, index + maxDeliverablesPerTask);
      split.push({
        ...task,
        task_id: taskId,
        objective: `${(task as T & { objective?: string }).objective ?? task.task_id} [deliverables: ${chunk.join(", ")}]`,
        deliverables: chunk,
        depends_on: previous ? [previous] : [...task.depends_on],
      });
      previous = taskId;
    }
    finalTaskIdByOriginal.set(task.task_id, previous!);
  }
  return {
    tasks: split.map((task) => ({
      ...task,
      depends_on: task.depends_on.map((dependency) => finalTaskIdByOriginal.get(dependency) ?? dependency),
    })),
    finalTaskIdByOriginal,
  };
}

export function splitTaskDeliverables<T extends WorksetTask>(task: T, maxDeliverablesPerTask: number): T[] {
  return splitWorksetDeliverables([task], maxDeliverablesPerTask).tasks;
}

export type ValidatableOrchestrationTask = Pick<
  OrchestrationTask,
  | "task_id"
  | "kind"
  | "repo_id"
  | "depends_on"
  | "mutates_repo"
  | "write_domains"
  | "acceptance_ids"
  | "deliverables"
  | "execution_budget_ms"
>;
