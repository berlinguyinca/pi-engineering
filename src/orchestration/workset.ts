import type { OrchestrationTask, TaskKind, WorkspaceManifest } from "./types.ts";

export type WorksetValidationCode =
  | "UNKNOWN_REPOSITORY"
  | "MISSING_REPOSITORY_BINDING"
  | "WRITE_DOMAIN_OUTSIDE_REPOSITORY"
  | "UNCOVERED_ACCEPTANCE"
  | "UNKNOWN_ACCEPTANCE"
  | "UNKNOWN_DEPENDENCY"
  | "CYCLIC_DEPENDENCY"
  | "DECOMPOSITION_REQUIRED"
  | "TASK_BUDGET_EXCEEDED"
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
  maxTaskBudgetMs: number;
}

export const DEFAULT_WORKSET_POLICY: WorksetPolicy = {
  maxDeliverablesPerTask: 4,
  maxTaskBudgetMs: 30 * 60_000,
};

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
}

export interface ValidateWorksetInput {
  manifest: WorkspaceManifest;
  acceptanceIds: string[];
  tasks: WorksetTask[];
  policy?: Partial<WorksetPolicy>;
}

function normalizeDomain(domain: string): string {
  return domain.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function domainWithin(requested: string, authorized: string): boolean {
  const target = normalizeDomain(requested);
  const allowed = normalizeDomain(authorized);
  if (allowed === "**") return true;
  if (target === "**") return false;
  if (!allowed.endsWith("/**")) return target === allowed;
  const allowedPrefix = allowed.slice(0, -3).replace(/\/$/, "");
  const targetPrefix = target.endsWith("/**") ? target.slice(0, -3).replace(/\/$/, "") : target;
  return targetPrefix === allowedPrefix || targetPrefix.startsWith(`${allowedPrefix}/`);
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

  assertAcyclic(input.tasks);
  const mutatingRepositories = new Set(
    input.tasks.filter((task) => task.mutates_repo).flatMap((task) => (task.repo_id ? [task.repo_id] : [])),
  );
  if (mutatingRepositories.size > 1) {
    throw new WorksetValidationError(
      "CROSS_REPOSITORY_MUTATION_UNSUPPORTED",
      `mutating workset spans ${[...mutatingRepositories].sort().join(", ")}`,
      "Run a separate repository-scoped mission; coordinated cross-repository publication is deferred beyond Slice 1",
    );
  }
  for (const task of input.tasks) {
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
    if ((task.execution_budget_ms ?? 0) > policy.maxTaskBudgetMs) {
      throw new WorksetValidationError(
        "TASK_BUDGET_EXCEEDED",
        `task ${task.task_id} budget ${task.execution_budget_ms}ms exceeds ${policy.maxTaskBudgetMs}ms`,
        "Reduce the budget or split the task into checkpointed deliverables",
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

  const covered = new Set(input.tasks.flatMap((task) => task.acceptance_ids ?? []));
  const uncovered = input.acceptanceIds.filter((acceptanceId) => !covered.has(acceptanceId));
  if (uncovered.length > 0) {
    throw new WorksetValidationError(
      "UNCOVERED_ACCEPTANCE",
      `no task covers ${uncovered.join(", ")}`,
      "Assign every material acceptance criterion to at least one bounded task",
    );
  }
  return input.tasks;
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
export function splitTaskDeliverables<T extends WorksetTask>(task: T, maxDeliverablesPerTask: number): T[] {
  const deliverables = task.deliverables ?? [];
  if (deliverables.length <= maxDeliverablesPerTask) return [task];
  const chunks: string[][] = [];
  for (let index = 0; index < deliverables.length; index += maxDeliverablesPerTask) {
    chunks.push(deliverables.slice(index, index + maxDeliverablesPerTask));
  }
  return chunks.map((chunk, index) => {
    const taskId = `${task.task_id}-${index + 1}`;
    return {
      ...task,
      task_id: taskId,
      objective: `${(task as T & { objective?: string }).objective ?? task.task_id} [deliverables: ${chunk.join(", ")}]`,
      deliverables: chunk,
      depends_on: index === 0 ? [...task.depends_on] : [`${task.task_id}-${index}`],
    };
  });
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
