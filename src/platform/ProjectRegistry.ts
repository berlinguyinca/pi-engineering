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
import { redactDeep } from "./redact.ts";
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

/**
 * Normalizes a git remote to a stable canonical form.
 *
 * Two jobs, and both were subtly wrong:
 *
 *   * **Strip credentials.** The userinfo rule only covered `https?://`, so
 *     `ssh://git:TOKEN@host/repo` and `git+ssh://user:pw@host/repo` carried
 *     their secret straight into the canonical identity — which is persisted
 *     in `platform.project.created` and served by the control plane. It now
 *     strips userinfo for ANY `scheme://` form.
 *   * **One identity per repository.** The scheme was kept for URL forms and
 *     dropped for the scp form, so `https://github.com/acme/a` and
 *     `git@github.com:acme/a` — the same repository — became two projects, and
 *     a multi-worktree project silently split. Scheme and userinfo are both
 *     dropped, leaving `host/path` in every case.
 */
export function normalizeRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  let r = remote.trim();
  // `scheme://[userinfo@]host/path` -> `host/path`, whatever the scheme is.
  r = r.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?/i, "");
  // scp-like `[user@]host:path` -> `host/path`.
  r = r.replace(/^[^/@]+@/, "");
  r = r.replace(/^([^/:]+):/, "$1/");
  r = r.replace(/\.git$/, "");
  return r || null;
}

export class ProjectRegistry {
  private readonly store: EventStoreBackend;
  private workspace: Workspace;
  private readonly projects = new Map<string, Project>();
  private readonly repositories = new Map<string, Repository>();
  /** See WorkGraph: a chain and a failure list, not an unbounded promise array. */
  private emitChain: Promise<void> = Promise.resolve();
  private emitFailures: Error[] = [];
  private onEmitError: (err: Error) => void = () => undefined;

  private constructor(store: EventStoreBackend, workspace: Workspace) {
    this.store = store;
    this.workspace = workspace;
  }

  /** Await all pending event writes, and report any that failed. */
  async flush(): Promise<void> {
    await this.emitChain;
    if (this.emitFailures.length === 0) return;
    const failures = this.emitFailures;
    this.emitFailures = [];
    throw new AggregateError(failures, `project registry: ${failures.length} event write(s) failed`);
  }

  /** Event writes that have failed since the last `flush`. */
  hasFailures(): boolean {
    return this.emitFailures.length > 0;
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

  /** Append an event without ever producing an unhandled rejection. See WorkGraph.emit. */
  private emit(base: Omit<PlatformEvent, "event_id" | "timestamp">): Promise<void> {
    const event: PlatformEvent = {
      event_id: id("evt"),
      timestamp: new Date().toISOString(),
      ...base,
    };
    // Redacted BEFORE the append, never on the way out. A caller-supplied run
    // goal or worker role reached the store and the control-plane response
    // untouched, so a secret pasted into a goal was persisted and then served.
    const redacted = { ...event, payload: redactDeep(event.payload) };
    const next = this.emitChain.then(
      () => this.store.append(redacted).then(() => undefined),
      () => this.store.append(redacted).then(() => undefined),
    );
    this.emitChain = next.catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitFailures.push(error);
      this.onEmitError(error);
    });
    return this.emitChain;
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
      // Everything `rebuild` needs. The payload used to omit `canonicalRemote`
      // and `multiRepo`, so the events were not sufficient to reconstruct the
      // registry even once a replay existed.
      payload: {
        project_id: project.id,
        name: project.name,
        risk_class: project.riskClass,
        canonical_remote: project.canonicalRemote,
        multi_repo: project.multiRepo,
        created_at: project.created_at,
      },
    });
    return this.getProject(project.id)!;
  }

  /**
   * Register a repository, joining it to an existing project by canonical remote
   * when possible (multi-worktree projects) or creating/using the named project.
   */
  registerRepository(input: RegisterRepositoryInput): Repository {
    const normRemote = normalizeRemote(input.remote);
    // A truthy-but-unknown id used to make `existing` undefined AND skip
    // `findByRemote`, so a new project was invented and named after the
    // directory — which is exactly what a caller holding a stale id does after
    // a restart. An id that was supplied must exist.
    if (input.projectId && !this.projects.has(input.projectId)) {
      throw new Error(`registerRepository: unknown project ${input.projectId}`);
    }
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
      payload: {
        repository_id: repo.id,
        root: repo.root,
        project_id: project.id,
        // The CANONICAL remote, never the raw one: a raw remote may carry
        // userinfo, and this payload is persisted and served.
        remote: normalizeRemote(repo.remote),
        created_at: repo.created_at,
      },
    });
    return { ...repo, worktreeRoots: [] };
  }

  /**
   * Record a worktree root under a repository for isolation accounting.
   *
   * Emits, because it did not: worktree accounting was unrecoverable by
   * construction, so a restart lost every worktree the registry knew about.
   */
  addWorktree(repositoryId: string, worktreeRoot: string): void {
    const repo = this.repositories.get(repositoryId);
    if (!repo) return;
    if (repo.worktreeRoots.includes(worktreeRoot)) return;
    repo.worktreeRoots.push(worktreeRoot);
    void this.emit({
      type: "platform.worktree.added",
      project_id: repo.projectId,
      run_id: null,
      worker_id: null,
      actor: "system",
      payload: { repository_id: repo.id, worktree_root: worktreeRoot },
    });
  }

  /**
   * Rebuild a registry from events (control-plane restart recovery).
   *
   * There was no replay at all, while both this file and `index.ts` claimed the
   * control plane was "reconstructable from events": after a restart the
   * platform had zero projects and a brand-new workspace id, while the events
   * sat on disk being ignored. `findByRemote` then missed, so the next
   * `registerRepository` for the same remote forked a duplicate project and
   * runs from before and after the restart were attributed to different ids.
   */
  static rebuild(
    store: EventStoreBackend,
    events: ReadonlyArray<{ type: string; timestamp: string; payload: Record<string, unknown> }>,
  ): ProjectRegistry | undefined {
    const created = events.find((e) => e.type === "platform.workspace.created");
    if (!created) return undefined;
    const workspace: Workspace = {
      // The EXISTING id, not a new one: a workspace that changes identity on
      // every boot is not the same workspace.
      id: String(created.payload.workspace_id ?? id("WS")),
      name: String(created.payload.name ?? "default"),
      projectIds: [],
      created_at: created.timestamp,
    };
    const registry = new ProjectRegistry(store, workspace);

    for (const e of events) {
      if (e.type === "platform.project.created") {
        const projectId = String(e.payload.project_id ?? "");
        if (!projectId) continue;
        registry.projects.set(projectId, {
          id: projectId,
          name: String(e.payload.name ?? "project"),
          canonicalRemote: (e.payload.canonical_remote as string | null) ?? null,
          multiRepo: e.payload.multi_repo === true,
          repositoryIds: [],
          riskClass: (e.payload.risk_class as RiskClass) ?? "medium",
          created_at: String(e.payload.created_at ?? e.timestamp),
        });
        workspace.projectIds.push(projectId);
      } else if (e.type === "platform.repository.registered") {
        const repositoryId = String(e.payload.repository_id ?? "");
        const projectId = String(e.payload.project_id ?? "");
        if (!repositoryId || !projectId) continue;
        registry.repositories.set(repositoryId, {
          id: repositoryId,
          projectId,
          root: String(e.payload.root ?? ""),
          remote: (e.payload.remote as string | null) ?? null,
          worktreeRoots: [],
          created_at: String(e.payload.created_at ?? e.timestamp),
        });
        registry.projects.get(projectId)?.repositoryIds.push(repositoryId);
      } else if (e.type === "platform.worktree.added") {
        const repo = registry.repositories.get(String(e.payload.repository_id ?? ""));
        const root = String(e.payload.worktree_root ?? "");
        if (repo && root && !repo.worktreeRoots.includes(root)) repo.worktreeRoots.push(root);
      }
    }
    return registry;
  }
}
