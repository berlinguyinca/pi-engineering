/**
 * Multi-project registry (spec: "One Pi Web deployment manages dozens of
 * projects", canonical model Workspace -> Project -> Repository).
 *
 * pi-engineering owns the project registry and configuration. This registry:
 *  - holds a named Workspace of Projects;
 *  - normalizes git remotes so a multi-worktree project stays ONE project;
 *  - emits platform events through the shared EventStore backend so the run
 *    graph and project history are reconstructable from events.
 */

import { id } from "../core/ids.ts";
import type { EventStoreBackend } from "./eventstore/backend.ts";
import type { PlatformEvent, Project, Repository, RiskClass, Workspace } from "./types.ts";

export interface RegisterProjectInput {
  name: string;
  canonicalRemote?: string | null;
  multiRepo?: boolean;
  riskClass?: RiskClass;
}

export interface RegisterRepositoryInput {
  projectId: string;
  root: string;
  remote?: string | null;
}

/** Normalizes a git remote to a stable canonical form (strip credentials/trailing .git). */
export function normalizeRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  let r = remote.trim();
  // Strip userinfo so credentials never leak into canonical identity.
  r = r.replace(/^[^/@]+@/, "");
  r = r.replace(/^https?:\/\/[^/@]+@/, "");
  // scp-like `host:path` -> `host/path` (only when not a URL scheme).
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(r)) {
    r = r.replace(/^([^/:]+):/, "$1/");
  }
  r = r.replace(/\.git$/, "");
  return r || null;
}

export class ProjectRegistry {
  private readonly store: EventStoreBackend;
  private workspace: Workspace;
  private readonly projects = new Map<string, Project>();
  private readonly repositories = new Map<string, Repository>();
  private readonly pendingEmit: Promise<unknown>[] = [];

  private constructor(store: EventStoreBackend, workspace: Workspace) {
    this.store = store;
    this.workspace = workspace;
  }

  /** Await all pending event writes (durability of the event log). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingEmit);
    this.pendingEmit.length = 0;
  }

  static create(store: EventStoreBackend, name = "default"): ProjectRegistry {
    const workspace: Workspace = { id: id("WS"), name, projectIds: [], created_at: new Date().toISOString() };
    const registry = new ProjectRegistry(store, workspace);
    void registry.emit({
      type: "platform.workspace.created",
      project_id: null,
      run_id: null,
      worker_id: null,
      actor: "system",
      payload: { workspace_id: workspace.id, name: workspace.name },
    });
    return registry;
  }

  private async emit(base: Omit<PlatformEvent, "event_id" | "timestamp">): Promise<void> {
    const event: PlatformEvent = {
      event_id: id("evt"),
      timestamp: new Date().toISOString(),
      ...base,
    };
    const p = this.store.append(event);
    this.pendingEmit.push(p);
    await p;
  }

  getWorkspace(): Workspace {
    return { ...this.workspace, projectIds: [...this.workspace.projectIds] };
  }

  listProjects(): Project[] {
    return [...this.projects.values()].map((p) => ({ ...p, repositoryIds: [...p.repositoryIds] }));
  }

  getProject(projectId: string): Project | undefined {
    const p = this.projects.get(projectId);
    return p ? { ...p, repositoryIds: [...p.repositoryIds] } : undefined;
  }

  /** Find a project by canonical remote (normalized), so worktrees stay one project. */
  findByRemote(remote: string | null | undefined): Project | undefined {
    const norm = normalizeRemote(remote);
    if (!norm) return undefined;
    return [...this.projects.values()].find((p) => normalizeRemote(p.canonicalRemote) === norm);
  }

  listRepositories(projectId?: string): Repository[] {
    const all = [...this.repositories.values()].map((r) => ({ ...r, worktreeRoots: [...r.worktreeRoots] }));
    return projectId ? all.filter((r) => r.projectId === projectId) : all;
  }

  registerProject(input: RegisterProjectInput): Project {
    const project: Project = {
      id: id("PRJ"),
      name: input.name,
      canonicalRemote: normalizeRemote(input.canonicalRemote),
      multiRepo: input.multiRepo ?? false,
      repositoryIds: [],
      riskClass: input.riskClass ?? "medium",
      created_at: new Date().toISOString(),
    };
    this.projects.set(project.id, project);
    this.workspace.projectIds.push(project.id);
    void this.emit({
      type: "platform.project.created",
      project_id: project.id,
      run_id: null,
      worker_id: null,
      actor: "system",
      payload: { project_id: project.id, name: project.name, risk_class: project.riskClass },
    });
    return this.getProject(project.id)!;
  }

  /**
   * Register a repository, joining it to an existing project by canonical remote
   * when possible (multi-worktree projects) or creating/using the named project.
   */
  registerRepository(input: RegisterRepositoryInput): Repository {
    const normRemote = normalizeRemote(input.remote);
    const existing = input.projectId ? this.getProject(input.projectId) : this.findByRemote(normRemote);
    const project =
      existing ??
      this.registerProject({ name: input.root.split("/").at(-1) ?? "project", canonicalRemote: normRemote });

    const repo: Repository = {
      id: id("REPO"),
      projectId: project.id,
      root: input.root,
      remote: input.remote ?? null,
      worktreeRoots: [],
      created_at: new Date().toISOString(),
    };
    this.repositories.set(repo.id, repo);
    // Push to the LIVE project (getProject returns a defensive copy).
    this.projects.get(project.id)!.repositoryIds.push(repo.id);
    void this.emit({
      type: "platform.repository.registered",
      project_id: project.id,
      run_id: null,
      worker_id: null,
      actor: "system",
      payload: { repository_id: repo.id, root: repo.root, project_id: project.id },
    });
    return { ...repo, worktreeRoots: [] };
  }

  /** Record a worktree root under a repository for isolation accounting. */
  addWorktree(repositoryId: string, worktreeRoot: string): void {
    const repo = this.repositories.get(repositoryId);
    if (!repo) return;
    if (!repo.worktreeRoots.includes(worktreeRoot)) repo.worktreeRoots.push(worktreeRoot);
  }
}
